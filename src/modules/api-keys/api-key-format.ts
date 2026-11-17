/**
 * API key format (P5-D9, decided by the owner; amends spec 2 and 6.11). Stripe-style keys:
 *
 *   secret       `sk_{live|test}_{keyId}_{secret}`   the secret is 64 hex characters (32 random
 *                bytes); only SHA-256(secret) is stored; shown once
 *   publishable  `pk_{live|test}_{keyId}`            an identifier with no secret part; safe to
 *                embed in a browser or app and can be shown again
 *
 * `keyId` is 16 characters of [a-z0-9], public and indexed for lookup (`apikey:{keyId}` in Redis,
 * spec 8.3). These keys are not Stripe keys: they share a prefix and nothing else.
 *
 * The earlier `mp_{live|test}_{keyId}_{secret}` form is still parsed (read only, never issued)
 * until task P5-K1 confirms no such key exists outside development. Remove `LEGACY_PREFIX` then.
 */
import { randomBytes } from 'node:crypto';
import type { Environment } from '../../common/auth/principal';
import { randomAlphanumeric, sha256Hex } from '../../common/crypto/crypto';

export type ApiKeyKind = 'secret' | 'publishable';

const LEGACY_PREFIX = 'mp';
const SECRET_PATTERN = /^(sk|mp)_(live|test)_([a-z0-9]{16})_([0-9a-f]{64})$/;
const PUBLISHABLE_PATTERN = /^pk_(live|test)_([a-z0-9]{16})$/;

export type ParsedApiKey =
  | {
      readonly kind: 'secret';
      readonly environment: Environment;
      readonly keyId: string;
      readonly secret: string;
      /** True for the retired `mp_` prefix. */
      readonly legacy: boolean;
    }
  | { readonly kind: 'publishable'; readonly environment: Environment; readonly keyId: string };

export interface GeneratedApiKey {
  readonly kind: ApiKeyKind;
  readonly environment: Environment;
  readonly keyId: string;
  /** The full key as the merchant sees it. */
  readonly key: string;
  /** SHA-256 of the secret part; null for a publishable key, which has none. */
  readonly secretHash: string | null;
}

export function generateApiKey(
  environment: Environment,
  kind: ApiKeyKind = 'secret'
): GeneratedApiKey {
  const keyId = randomAlphanumeric(16);
  if (kind === 'publishable') {
    return { kind, environment, keyId, key: `pk_${environment}_${keyId}`, secretHash: null };
  }
  const secret = randomBytes(32).toString('hex');
  return {
    kind,
    environment,
    keyId,
    key: `sk_${environment}_${keyId}_${secret}`,
    secretHash: sha256Hex(secret),
  };
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const secret = SECRET_PATTERN.exec(raw);
  if (secret) {
    const [, prefix, environment, keyId, value] = secret as unknown as [
      string,
      string,
      Environment,
      string,
      string,
    ];
    return {
      kind: 'secret',
      environment,
      keyId,
      secret: value,
      legacy: prefix === LEGACY_PREFIX,
    };
  }
  const publishable = PUBLISHABLE_PATTERN.exec(raw);
  if (publishable) {
    const [, environment, keyId] = publishable as unknown as [string, Environment, string];
    return { kind: 'publishable', environment, keyId };
  }
  return null;
}

/** What the dashboard shows instead of the key: never any part of the secret. */
export function keyPrefix(kind: ApiKeyKind, environment: string, keyId: string): string {
  return `${kind === 'secret' ? 'sk' : 'pk'}_${environment}_${keyId}`;
}
