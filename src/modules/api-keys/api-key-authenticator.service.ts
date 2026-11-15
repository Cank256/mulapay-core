/**
 * API key authentication for the `/v1` surface (spec 8.3, API key path).
 *
 * Parse `mp_{env}_{keyId}_{secret}`, find the key by `keyId` (Redis cache, then Postgres),
 * compare SHA-256 of the secret with `crypto.timingSafeEqual`, and refuse revoked or
 * expired keys, keys whose prefix environment differs from the stored one, and clients
 * outside the key's IP allowlist. The client IP is `request.ip`, which Fastify derives from
 * the configured proxy CIDRs only (`TRUST_PROXY`); forwarding headers from anyone else are
 * ignored.
 *
 * Caching (see `ApiKeyCache`): entries live 60 s, unknown ids are remembered for 30 s, and
 * a revocation evicts the entry on every replica at once. Expiry is judged against the
 * clock on every request, so a scheduled retirement needs no eviction when it arrives.
 *
 * Every refusal returns null, which the guard answers with one 401, so a caller cannot
 * tell a wrong secret from a revoked key or a blocked address.
 */
import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiKeyAuthenticator, ApiKeyPrincipal } from '../../common/auth/principal';
import {
  ApiKeyCache,
  type CachedApiKey,
  type KeyLookupSource,
} from '../../common/auth/api-key-cache';
import { ApiKeyUsageTracker } from '../../common/auth/api-key-usage.tracker';
import { apiKeyAbility } from '../../common/authz/ability';
import type { Clock } from '../../common/clock/clock';
import { sha256Hex } from '../../common/crypto/crypto';
import { CLOCK } from '../../common/tokens';
import { parseApiKey } from './api-key-format';
import { ApiKeysRepository } from './api-keys.repository';
import { isKeyUsable } from './api-keys.service';
import { ipAllowed } from './ip-allowlist';

@Injectable()
export class DbApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly cache: ApiKeyCache,
    private readonly usage: ApiKeyUsageTracker,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async authenticate(rawKey: string, clientIp: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) return null;
    const key = await this.load(parsed.keyId);
    if (!key) return null;
    const presented = Buffer.from(sha256Hex(parsed.secret), 'hex');
    const stored = Buffer.from(key.secretHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
    if (key.environment !== parsed.environment) return null;
    const now = this.clock.now();
    if (!isKeyUsable({ revokedAt: toDate(key.revokedAt), expiresAt: toDate(key.expiresAt) }, now)) {
      return null;
    }
    if (!ipAllowed(key.ipAllowlist, clientIp)) return null;
    this.usage.touch(key.id, now);
    return {
      kind: 'api_key',
      apiKeyId: key.id,
      apiKeyRef: key.ref,
      name: key.name,
      merchant: { id: key.merchantId, ref: key.merchantRef, status: key.merchantStatus },
      environment: key.environment,
      scopes: key.scopes,
      ability: apiKeyAbility(key.scopes),
      rateLimitRpm: key.rateLimitRpm,
      signing: { required: key.signingRequired, secretEnc: key.signingSecretEnc },
    };
  }

  private async load(keyId: string): Promise<CachedApiKey | null> {
    const cached = await this.cache.lookup(keyId);
    if (cached.kind === 'hit') return cached.key;
    if (cached.kind === 'negative') return null;
    // The database read must start after this instant is taken, so that an eviction that
    // lands while we read always compares newer than the entry (see ApiKeyCache).
    const readAtMs = await this.cache.serverTimeMs().catch(() => null);
    const found = await this.keys.findForAuthentication(keyId);
    if (!found) {
      await this.cache.putNegative(keyId);
      return null;
    }
    const entry = toCachedKey(found, readAtMs ?? 0);
    if (readAtMs !== null) await this.cache.put(entry);
    return entry;
  }
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function toCachedKey(found: KeyLookupSource, readAtMs: number): CachedApiKey {
  const { key } = found;
  return {
    id: key.id,
    ref: key.ref,
    keyId: key.keyId,
    name: key.name,
    environment: key.environment as CachedApiKey['environment'],
    secretHash: key.secretHash,
    scopes: key.scopes,
    ipAllowlist: key.ipAllowlist,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    rateLimitRpm: key.rateLimitRpm,
    signingRequired: key.signingRequired,
    signingSecretEnc: key.signingSecretEnc,
    merchantId: key.merchantId,
    merchantRef: found.merchantRef,
    merchantStatus: found.merchantStatus as CachedApiKey['merchantStatus'],
    readAtMs,
  };
}
