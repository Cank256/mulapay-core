/**
 * API key authentication for the `/v1` surface (spec 8.3, API key path).
 *
 * Parse `mp_{env}_{keyId}_{secret}`, look the key up by `keyId`, compare SHA-256 of the
 * secret with `crypto.timingSafeEqual`, and refuse revoked or expired keys, keys whose
 * prefix environment differs from the stored one, and clients outside the key's IP
 * allowlist (client IP from trusted proxies only, via Fastify `trustProxy`).
 *
 * Not yet here (Phase 5, spec 8.3 and 6.11): the Redis key cache with negative caching and
 * pub/sub eviction, the batched `last_used_at` flush, request signing and rate limits.
 * Every lookup reads Postgres, so revocation is already immediate.
 */
import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ApiKeyAuthenticator,
  ApiKeyPrincipal,
  MerchantStatus,
} from '../../common/auth/principal';
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
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async authenticate(rawKey: string, clientIp: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) return null;
    const found = await this.keys.findForAuthentication(parsed.keyId);
    if (!found) return null;
    const { key } = found;
    const presented = Buffer.from(sha256Hex(parsed.secret), 'hex');
    const stored = Buffer.from(key.secretHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
    if (key.environment !== parsed.environment) return null;
    if (!isKeyUsable(key, this.clock.now())) return null;
    if (!ipAllowed(key.ipAllowlist, clientIp)) return null;
    return {
      kind: 'api_key',
      apiKeyId: key.id,
      apiKeyRef: key.ref,
      name: key.name,
      merchant: {
        id: key.merchantId,
        ref: found.merchantRef,
        status: found.merchantStatus as MerchantStatus,
      },
      environment: key.environment,
      scopes: key.scopes,
      ability: apiKeyAbility(key.scopes),
    };
  }
}
