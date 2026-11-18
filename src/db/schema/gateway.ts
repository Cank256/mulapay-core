/**
 * Gateway integration tables (Phase 3): gateway_events stores events from the gateway event
 * stream with dedupe, apply status and retry tracking; gateway_requests records every HTTP
 * call core makes to the gateway for reconciliation, debugging and metrics.
 */
import {
  bigint,
  bigserial,
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, timestamptz } from './columns';

export const gatewayEvents = pgTable(
  'gateway_events',
  {
    id: bigserial('id', { mode: 'number' }).notNull(),
    gatewayEventId: uuid('gateway_event_id').notNull(),
    gatewayId: bigint('gateway_id', { mode: 'number' }).notNull(),
    operationId: text('operation_id'),
    providerId: text('provider_id').notNull(),
    operationType: text('operation_type').notNull(),
    externalId: text('external_id').notNull(),
    referenceId: text('reference_id'),
    providerTransactionId: text('provider_transaction_id'),
    status: text('status').notNull(),
    previousStatus: text('previous_status'),
    amount: numeric('amount', { precision: 15, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    reason: text('reason'),
    source: text('source').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
    processedAt: timestamptz('processed_at'),
    applyStatus: text('apply_status').notNull().default('pending'),
    applyError: text('apply_error'),
    attempts: integer('attempts').notNull().default(0),
  },
  (table) => ({
    // Composite PK required because gateway_events is partitioned by created_at.
    // PostgreSQL 16 requires all partition columns in every unique/primary key constraint.
    pk: primaryKey({ columns: [table.id, table.createdAt], name: 'gateway_events_pkey' }),
    operationTypeCheck: check(
      'gateway_events_operation_type_check',
      sql`${table.operationType} IN ('collection', 'disbursement', 'refund')`
    ),
    statusCheck: check(
      'gateway_events_status_check',
      sql`${table.status} IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')`
    ),
    previousStatusCheck: check(
      'gateway_events_previous_status_check',
      sql`${table.previousStatus} IS NULL OR ${table.previousStatus} IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')`
    ),
    sourceCheck: check(
      'gateway_events_source_check',
      sql`${table.source} IN ('provider_response', 'callback', 'reconciliation')`
    ),
    applyStatusCheck: check(
      'gateway_events_apply_status_check',
      sql`${table.applyStatus} IN ('pending', 'applied', 'skipped', 'failed')`
    ),
    attemptsCheck: check('gateway_events_attempts_check', sql`${table.attempts} >= 0`),
    gatewayIdCheck: check('gateway_events_gateway_id_check', sql`${table.gatewayId} >= 0`),
    // Dedupe index — includes created_at because that is the partition key.
    gatewayEventIdIdx: index('gateway_events_gateway_event_id_idx').on(
      table.gatewayEventId,
      table.createdAt
    ),
    gatewayIdIdx: index('gateway_events_gateway_id_idx').on(table.gatewayId),
    externalIdIdx: index('gateway_events_external_id_idx').on(
      table.externalId,
      table.operationType
    ),
    applyStatusIdx: index('gateway_events_apply_status_idx')
      .on(table.applyStatus)
      .where(sql`${table.applyStatus} IN ('pending', 'failed')`),
    occurredAtIdx: index('gateway_events_occurred_at_idx').on(table.occurredAt),
  })
);

export const gatewayRequests = pgTable(
  'gateway_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Informational reference to the transaction; no FK because transactions is partitioned
    // and its PK is composite (id, created_at) — a simple FK is not possible without
    // storing transaction_created_at here too.
    transactionId: uuid('transaction_id'),
    provider: text('provider').notNull(),
    operationType: text('operation_type').notNull(),
    externalId: text('external_id').notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    attempt: integer('attempt').notNull().default(0),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => ({
    operationTypeCheck: check(
      'gateway_requests_operation_type_check',
      sql`${table.operationType} IN ('collection', 'disbursement', 'refund', 'query', 'balance')`
    ),
    attemptCheck: check('gateway_requests_attempt_check', sql`${table.attempt} >= 0`),
    latencyCheck: check(
      'gateway_requests_latency_check',
      sql`${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0`
    ),
    transactionIdIdx: index('gateway_requests_transaction_id_idx').on(table.transactionId),
    externalIdIdx: index('gateway_requests_external_id_idx').on(table.externalId),
    createdAtIdx: index('gateway_requests_created_at_idx').on(table.createdAt),
  })
);

// consumer_cursors already exists in operations.ts, so no need to define it here
