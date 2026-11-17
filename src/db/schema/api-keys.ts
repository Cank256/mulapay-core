/**
 * API keys (spec section 5.2 developer platform and 6.11).
 *
 * A secret key is `sk_{live|test}_{keyId}_{secret}`: only `key_id` and the SHA-256 of the secret
 * are stored, and the full key is returned once. A publishable key is `pk_{live|test}_{keyId}`:
 * it has no secret, so `secret_hash` is null and it can be shown again (P5-D9). The retired
 * `mp_` prefix is still parsed for existing development keys (see api-key-format.ts).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, cidr, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';
import { merchants } from './merchants';

export const apiKeys = core.table(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    keyId: text('key_id').notNull(),
    /** `secret` or `publishable`. A publishable key carries no secret and no scopes beyond a client-safe set. */
    kind: text('kind').notNull().default('secret'),
    /** Null exactly when `kind = 'publishable'`. */
    secretHash: text('secret_hash'),
    /** Browser origins a publishable key may be used from; an IP allowlist means nothing there. */
    allowedOrigins: text('allowed_origins').array(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull(),
    ipAllowlist: cidr('ip_allowlist').array(),
    rateLimitRpm: integer('rate_limit_rpm'),
    /**
     * The secret that signs requests (spec 6.11), AES-256-GCM encrypted: unlike the API key
     * secret it must be recoverable, because the server recomputes the HMAC. Shown once.
     */
    signingSecretEnc: text('signing_secret_enc'),
    /** Every request with this key must be signed (always true for live `payouts:write`). */
    signingRequired: boolean('signing_required').notNull().default(false),
    lastUsedAt: timestamptz('last_used_at'),
    expiresAt: timestamptz('expires_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id),
    createdBy: uuid('created_by').references(() => users.id),
    /** The key this one replaced when it was created by a roll. */
    rolledFromId: uuid('rolled_from_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('api_keys_ref_key').on(t.ref),
    uniqueIndex('api_keys_key_id_key').on(t.keyId),
    index('api_keys_merchant_revoked_idx').on(t.merchantId, t.revokedAt),
    check('api_keys_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('api_keys_key_id_format_check', sql`${t.keyId} ~ '^[a-z0-9]{16}$'`),
    check('api_keys_secret_hash_format_check', sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
    check('api_keys_kind_check', sql`${t.kind} in ('secret', 'publishable')`),
    check(
      'api_keys_secret_presence_check',
      sql`(${t.kind} = 'secret') = (${t.secretHash} is not null)`
    ),
    check(
      'api_keys_publishable_unsigned_check',
      sql`${t.kind} = 'secret' or (${t.signingSecretEnc} is null and not ${t.signingRequired})`
    ),
    check(
      'api_keys_allowed_origins_check',
      sql`${t.kind} = 'publishable' or ${t.allowedOrigins} is null`
    ),
    check('api_keys_scopes_nonempty_check', sql`cardinality(${t.scopes}) > 0`),
    check(
      'api_keys_signing_check',
      sql`not ${t.signingRequired} or ${t.signingSecretEnc} is not null`
    ),
    check(
      'api_keys_rate_limit_check',
      sql`${t.rateLimitRpm} is null or ${t.rateLimitRpm} between 1 and 100000`
    ),
  ]
);
