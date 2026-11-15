/** API key response shapes. The secret hash, ciphertexts and internal ids are never exposed. */
import { z } from 'zod';
import { keyPrefix } from './api-key-format';
import type { ApiKeyRow } from './api-keys.repository';

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  environment: z.enum(['test', 'live']),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  ipAllowlist: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked']),
  rateLimitRpm: z.number().int().nullable(),
  signingRequired: z.boolean(),
  hasSigningSecret: z.boolean(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ApiKeyView = z.infer<typeof apiKeySchema>;

/** Create and roll responses carry the full key and signing secret, once. */
export const createdApiKeySchema = apiKeySchema.extend({
  key: z.string(),
  signingSecret: z.string().nullable(),
});
export type CreatedApiKeyView = z.infer<typeof createdApiKeySchema>;

export function toApiKeyView(row: ApiKeyRow, now: Date): ApiKeyView {
  const status = row.revokedAt
    ? 'revoked'
    : row.expiresAt && row.expiresAt.getTime() <= now.getTime()
      ? 'expired'
      : 'active';
  return {
    id: row.ref,
    name: row.name,
    environment: row.environment as ApiKeyView['environment'],
    keyPrefix: keyPrefix(row.environment, row.keyId),
    scopes: row.scopes,
    ipAllowlist: row.ipAllowlist ?? [],
    status,
    rateLimitRpm: row.rateLimitRpm,
    signingRequired: row.signingRequired,
    hasSigningSecret: row.signingSecretEnc !== null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
