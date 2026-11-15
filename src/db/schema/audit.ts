/**
 * Audit log (spec section 5.2 platform and 6.14): append-only and hash-chained,
 * `hash = sha256(prev_hash || canonical(row))`.
 *
 * Migration 0001 creates `audit_logs` partitioned by month on `created_at` (spec 5.1),
 * which drizzle-kit cannot express; this definition gives typed access to the columns.
 * UPDATE, DELETE and TRUNCATE are refused by triggers and revoked from mulapay_core_rw.
 *
 * `audit_chain_head` is a single row holding the last `seq` and `hash`. Writers lock it
 * `FOR UPDATE`, which serialises appends without scanning partitions, and `seq` is
 * assigned from it so the sequence has no gaps.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, primaryKey, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { core } from './core';

export const auditLogs = core.table(
  'audit_logs',
  {
    seq: bigint('seq', { mode: 'number' }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    merchantId: uuid('merchant_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    changedFields: text('changed_fields').array().notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    surface: text('surface'),
    outcome: text('outcome').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seq, t.createdAt] }),
    index('audit_logs_created_idx').on(t.createdAt.desc(), t.seq.desc()),
    index('audit_logs_merchant_created_idx').on(t.merchantId, t.createdAt.desc()),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
    check(
      'audit_logs_actor_type_check',
      sql`${t.actorType} in ('user', 'api_key', 'system', 'job')`
    ),
    check('audit_logs_outcome_check', sql`${t.outcome} in ('success', 'denied', 'error')`),
    check('audit_logs_hash_format_check', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ]
);

export const auditChainHead = core.table(
  'audit_chain_head',
  {
    id: smallint('id').primaryKey().default(1),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
    lastHash: text('last_hash').notNull(),
  },
  (t) => [check('audit_chain_head_singleton_check', sql`${t.id} = 1`)]
);
