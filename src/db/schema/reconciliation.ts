/**
 * Reconciliation (spec 5.2, 6.8): runs, the exception queue, resolution approvals and
 * provider statements.
 *
 * A run never changes financial state. It records what it checked and raises exceptions;
 * only a resolution does anything, and a resolution that moves money (a reversing entry or
 * a write-off to `5100:loss_writeoff`) needs a second person's approval.
 *
 * Database rules added by migration 0006:
 *  - at most one `running` run per (kind, scope), so two workers cannot run the same check;
 *  - at most one open or investigating exception per `dedupe_key`: the same discrepancy
 *    seen again by a later run bumps `occurrences` instead of creating a second exception;
 *  - exception notes are append-only; a resolved exception never changes again;
 *  - the approver of a resolution is never its requester;
 *  - statement rows are never deleted.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { currencies } from './ledger';
import { merchants } from './merchants';

export const reconciliationRuns = core.table(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    /** What the run covered, for example `{ "environment": "live", "currency": "UGX" }`. */
    scope: jsonb('scope').$type<Record<string, string>>().notNull().default({}),
    /** Canonical string of `scope`: the unit the single-flight lock applies to. */
    scopeKey: text('scope_key').notNull(),
    /** The same business window always has the same key, so a repeat is the same run. */
    runKey: text('run_key').notNull(),
    periodStart: timestamptz('period_start'),
    periodEnd: timestamptz('period_end'),
    status: text('status').notNull().default('running'),
    triggeredBy: text('triggered_by').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),
    /** A running run past its lease belongs to a dead worker and may be taken over. */
    leaseExpiresAt: timestamptz('lease_expires_at').notNull(),
    attempts: integer('attempts').notNull().default(1),
    checkedCount: integer('checked_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    exceptionCount: integer('exception_count').notNull().default(0),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_runs_ref_key').on(t.ref),
    uniqueIndex('reconciliation_runs_run_key_key').on(t.kind, t.runKey),
    uniqueIndex('reconciliation_runs_single_flight_key')
      .on(t.kind, t.scopeKey)
      .where(sql`${t.status} = 'running'`),
    index('reconciliation_runs_kind_started_idx').on(t.kind, t.startedAt.desc()),
    check('reconciliation_runs_ref_format_check', sql.raw(`ref ~ '^rcr_[0-9A-HJKMNP-TV-Z]{26}$'`)),
    check(
      'reconciliation_runs_kind_check',
      sql`${t.kind} in ('gateway_gap', 'ledger_integrity', 'provider_statement', 'balance_proof')`
    ),
    check(
      'reconciliation_runs_status_check',
      sql`${t.status} in ('running', 'completed', 'failed')`
    ),
    check(
      'reconciliation_runs_finished_check',
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`
    ),
    check(
      'reconciliation_runs_counts_check',
      sql`${t.checkedCount} >= 0 and ${t.matchedCount} >= 0 and ${t.exceptionCount} >= 0`
    ),
  ]
);

export const reconciliationExceptions = core.table(
  'reconciliation_exceptions',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    /** The run that first found it, and the latest run that still sees it. */
    runId: uuid('run_id').references(() => reconciliationRuns.id),
    lastRunId: uuid('last_run_id').references(() => reconciliationRuns.id),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    environment: text('environment').notNull().default('live'),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    /** The amount in dispute, when there is one. Minor units. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    /** `transactions` is partitioned: no foreign key. */
    transactionId: uuid('transaction_id'),
    gatewayOperationId: text('gateway_operation_id'),
    expected: jsonb('expected').$type<Record<string, unknown>>().notNull().default({}),
    actual: jsonb('actual').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('open'),
    assignedTo: uuid('assigned_to'),
    assignedAt: timestamptz('assigned_at'),
    resolution: text('resolution'),
    resolutionNote: text('resolution_note'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamptz('resolved_at'),
    /** The ledger entry a reversal or write-off posted. */
    resolutionEntryRef: text('resolution_entry_ref'),
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_exceptions_ref_key').on(t.ref),
    uniqueIndex('reconciliation_exceptions_open_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('open', 'investigating')`),
    index('reconciliation_exceptions_queue_idx')
      .on(t.status, t.severity, t.createdAt.desc())
      .where(sql`${t.status} in ('open', 'investigating')`),
    index('reconciliation_exceptions_kind_idx').on(t.kind, t.createdAt.desc()),
    index('reconciliation_exceptions_transaction_idx')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    index('reconciliation_exceptions_assignee_idx')
      .on(t.assignedTo, t.status)
      .where(sql`${t.assignedTo} is not null`),
    check(
      'reconciliation_exceptions_ref_format_check',
      sql.raw(`ref ~ '^rce_[0-9A-HJKMNP-TV-Z]{26}$'`)
    ),
    check('reconciliation_exceptions_kind_check', sql`${t.kind} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check(
      'reconciliation_exceptions_severity_check',
      sql`${t.severity} in ('critical', 'high', 'medium', 'low')`
    ),
    check(
      'reconciliation_exceptions_status_check',
      sql`${t.status} in ('open', 'investigating', 'resolved', 'written_off')`
    ),
    check(
      'reconciliation_exceptions_resolution_check',
      sql`(${t.status} in ('open', 'investigating')) = (${t.resolution} is null)
        and (${t.status} = 'written_off') = (${t.resolution} = 'written_off')
        and (${t.resolution} is null or ${t.resolution} in ('matched_manually', 'corrected_with_reversal', 'written_off'))
        and (${t.resolution} is null) = (${t.resolvedAt} is null)
        and (${t.resolution} is null) = (${t.resolvedBy} is null)`
    ),
    check('reconciliation_exceptions_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'reconciliation_exceptions_amount_check',
      sql`${t.amountMinor} is null or ${t.amountMinor} >= 0`
    ),
    check('reconciliation_exceptions_occurrences_check', sql`${t.occurrences} >= 1`),
    check(
      'reconciliation_exceptions_json_check',
      sql`jsonb_typeof(${t.expected}) = 'object' and jsonb_typeof(${t.actual}) = 'object'`
    ),
  ]
);

/** Investigation notes and the queue's own record of what happened to an exception. */
export const reconciliationExceptionNotes = core.table(
  'reconciliation_exception_notes',
  {
    id: uuid('id').primaryKey(),
    exceptionId: uuid('exception_id')
      .notNull()
      .references(() => reconciliationExceptions.id),
    kind: text('kind').notNull(),
    authorId: uuid('author_id'),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('reconciliation_exception_notes_idx').on(t.exceptionId, t.createdAt, t.id),
    check(
      'reconciliation_exception_notes_kind_check',
      sql`${t.kind} in ('note', 'assignment', 'status', 'resolution', 'approval', 'system')`
    ),
    check(
      'reconciliation_exception_notes_body_check',
      sql`char_length(${t.body}) between 1 and 2000`
    ),
  ]
);

/**
 * A resolution that moves money, waiting for a second person. One pending request per
 * exception. Approving posts the entry in the same transaction that records the decision.
 */
export const reconciliationResolutionRequests = core.table(
  'reconciliation_resolution_requests',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    exceptionId: uuid('exception_id')
      .notNull()
      .references(() => reconciliationExceptions.id),
    kind: text('kind').notNull(),
    /** `{ entryRef }` for a reversal; `{ accountCode }` for a write-off. */
    payload: jsonb('payload').$type<Record<string, string>>().notNull(),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamptz('requested_at').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionNote: text('decision_note'),
    entryRef: text('entry_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_resolution_requests_ref_key').on(t.ref),
    uniqueIndex('reconciliation_resolution_requests_pending_key')
      .on(t.exceptionId)
      .where(sql`${t.status} = 'pending'`),
    index('reconciliation_resolution_requests_status_idx').on(t.status, t.requestedAt.desc()),
    check(
      'reconciliation_resolution_requests_ref_format_check',
      sql.raw(`ref ~ '^rca_[0-9A-HJKMNP-TV-Z]{26}$'`)
    ),
    check(
      'reconciliation_resolution_requests_kind_check',
      sql`${t.kind} in ('corrected_with_reversal', 'written_off')`
    ),
    check(
      'reconciliation_resolution_requests_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected')`
    ),
    check(
      'reconciliation_resolution_requests_decision_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null)
        and (${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy})
        and (${t.status} <> 'approved') = (${t.entryRef} is null)`
    ),
    check(
      'reconciliation_resolution_requests_writeoff_check',
      sql`${t.kind} <> 'written_off' or (${t.amountMinor} > 0 and ${t.currency} is not null)`
    ),
    check(
      'reconciliation_resolution_requests_reason_check',
      sql`char_length(${t.reason}) between 3 and 1000`
    ),
  ]
);

export const providerStatements = core.table(
  'provider_statements',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    provider: text('provider').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    /** Set when the file was uploaded to object storage (not built yet): rows arrive in the API. */
    fileKey: text('file_key'),
    /** Hash of the canonical rows: the same statement uploaded twice is refused. */
    contentSha256: text('content_sha256').notNull(),
    rowCount: integer('row_count').notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('uploaded'),
    matchedCount: integer('matched_count').notNull().default(0),
    unmatchedCount: integer('unmatched_count').notNull().default(0),
    mismatchCount: integer('mismatch_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    uploadedBy: text('uploaded_by').notNull(),
    matchedAt: timestamptz('matched_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provider_statements_ref_key').on(t.ref),
    uniqueIndex('provider_statements_content_key').on(t.provider, t.currency, t.contentSha256),
    index('provider_statements_created_idx').on(t.createdAt.desc()),
    check('provider_statements_ref_format_check', sql.raw(`ref ~ '^pst_[0-9A-HJKMNP-TV-Z]{26}$'`)),
    check(
      'provider_statements_provider_check',
      sql`${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    check('provider_statements_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      'provider_statements_status_check',
      sql`${t.status} in ('uploaded', 'matching', 'matched', 'failed')`
    ),
    check('provider_statements_rows_check', sql`${t.rowCount} > 0 and ${t.totalMinor} >= 0`),
  ]
);

export const providerStatementRows = core.table(
  'provider_statement_rows',
  {
    id: uuid('id').primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => providerStatements.id),
    rowNo: integer('row_no').notNull(),
    providerRef: text('provider_ref').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    /** What the provider sent for the row. Never logged. */
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    /** `transactions` is partitioned: no foreign key. */
    matchedTransactionId: uuid('matched_transaction_id'),
    matchStatus: text('match_status').notNull().default('pending'),
    matchNote: text('match_note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('provider_statement_rows_row_key').on(t.statementId, t.rowNo),
    index('provider_statement_rows_ref_idx').on(t.providerRef),
    index('provider_statement_rows_matched_idx')
      .on(t.matchedTransactionId)
      .where(sql`${t.matchedTransactionId} is not null`),
    check('provider_statement_rows_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'provider_statement_rows_status_check',
      sql`${t.matchStatus} in ('pending', 'matched_reference', 'matched_amount', 'unmatched', 'mismatch', 'duplicate')`
    ),
    check(
      'provider_statement_rows_matched_check',
      sql`(${t.matchStatus} in ('matched_reference', 'matched_amount')) = (${t.matchedTransactionId} is not null)
        or ${t.matchStatus} in ('mismatch', 'duplicate')`
    ),
  ]
);
