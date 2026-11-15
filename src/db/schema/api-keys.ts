/**
 * API keys (spec section 5.2 developer platform and 6.11).
 *
 * The key is `mp_{live|test}_{keyId}_{secret}`. Only `key_id` and the SHA-256 of the
 * secret are stored; the full key is returned once, at creation.
 */
import { sql } from 'drizzle-orm';
import { check, cidr, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    secretHash: text('secret_hash').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull(),
    ipAllowlist: cidr('ip_allowlist').array(),
    rateLimitRpm: integer('rate_limit_rpm'),
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
    check('api_keys_scopes_nonempty_check', sql`cardinality(${t.scopes}) > 0`),
    check(
      'api_keys_rate_limit_check',
      sql`${t.rateLimitRpm} is null or ${t.rateLimitRpm} between 1 and 100000`
    ),
  ]
);
