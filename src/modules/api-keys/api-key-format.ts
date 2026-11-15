/**
 * API key format (spec 2 and 6.11): `mp_{live|test}_{keyId}_{secret}`.
 *
 * - `keyId`: 16 characters of [a-z0-9], public, indexed for lookup.
 * - `secret`: 32 random bytes as 64 hex characters. Only SHA-256(secret) is stored.
 */
import { randomBytes } from 'node:crypto';
import type { Environment } from '../../common/auth/principal';
import { randomAlphanumeric, sha256Hex } from '../../common/crypto/crypto';

const KEY_PATTERN = /^mp_(live|test)_([a-z0-9]{16})_([0-9a-f]{64})$/;

export interface ParsedApiKey {
  readonly environment: Environment;
  readonly keyId: string;
  readonly secret: string;
}

export interface GeneratedApiKey extends ParsedApiKey {
  readonly key: string;
  readonly secretHash: string;
}

export function generateApiKey(environment: Environment): GeneratedApiKey {
  const keyId = randomAlphanumeric(16);
  const secret = randomBytes(32).toString('hex');
  return {
    environment,
    keyId,
    secret,
    key: `mp_${environment}_${keyId}_${secret}`,
    secretHash: sha256Hex(secret),
  };
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = KEY_PATTERN.exec(raw);
  if (!match) return null;
  const [, environment, keyId, secret] = match as unknown as [string, Environment, string, string];
  return { environment, keyId, secret };
}

/** What the dashboard shows instead of the key: never any part of the secret. */
export function keyPrefix(environment: string, keyId: string): string {
  return `mp_${environment}_${keyId}`;
}
