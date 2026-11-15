/**
 * Idempotency records (spec 5.2 developer platform, 8.2).
 *
 * The row is written in the same transaction as the work it protects (`in_flight` first,
 * `completed` with the response last), so durability never depends on Redis and a crash
 * leaves no half-claimed key: a rolled-back request leaves nothing behind. Concurrent
 * requests with one key serialise on the unique index.
 *
 * `environment` is part of the key (the spec's unique index omits it): the same key may be
 * used once in test and once in live without colliding.
 *
 * Rows live 24 hours. A reused key after expiry recycles its row (the work's own unique
 * constraints still prevent a second payment). Unpartitioned: the table is bounded by the
 * expiry and a retention job (Phase 9) deletes expired rows.
 */
import { sql } from 'drizzle-orm';
import { char, check, index, jsonb, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { merchants } from './merchants';

export const idempotencyKeys = core.table(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    /** sha256(canonicalJson(body) + method + path), hex. */
    requestFingerprint: char('request_fingerprint', { length: 64 }).notNull(),
    status: text('status').notNull().default('in_flight'),
    responseStatus: smallint('response_status'),
    responseBody: jsonb('response_body'),
    lockedAt: timestamptz('locked_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_key_idx').on(t.merchantId, t.environment, t.scope, t.key),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
    check('idempotency_keys_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'idempotency_keys_status_check',
      sql`${t.status} in ('in_flight', 'completed', 'failed')`
    ),
    check('idempotency_keys_key_check', sql`char_length(${t.key}) between 1 and 255`),
    check('idempotency_keys_scope_check', sql`${t.scope} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check('idempotency_keys_fingerprint_check', sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    // A completed key always carries the response to replay.
    check(
      'idempotency_keys_completed_check',
      sql`${t.status} <> 'completed' or (${t.responseStatus} is not null and ${t.responseBody} is not null)`
    ),
  ]
);
