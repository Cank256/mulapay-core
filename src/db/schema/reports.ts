/**
 * Reports and rollups (spec 5.2, 6.12, 9.2, Phase 8).
 *
 * A report is asynchronous: the row is `queued`, a worker streams the rows from the database
 * through a server-side cursor into object storage, and the row becomes `ready` with the file's
 * key, size and checksum. Files expire after seven days. A schedule creates a report per due
 * time; `report_schedule_runs` is its execution history and is unique per (schedule, due time),
 * so a repeated tick creates no second report.
 *
 * `daily_merchant_rollups` is what every dashboard tile reads (spec 9.2 rule 4).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';
import { currencies } from './ledger';
import { merchants } from './merchants';

export const REPORT_TYPES = [
  'transactions',
  'payments',
  'payouts',
  'refunds',
  'fees',
  'balance_statement',
  'ledger_account_statement',
  'settlement_statement',
  'reconciliation_exceptions',
  'aml_alerts',
  'kyc_status',
  'audit_trail',
  'merchant_performance',
] as const;
export const REPORT_FORMATS = ['csv', 'json'] as const;
export const REPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const reports = core.table(
  'reports',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    /** Null for a platform report requested by staff. */
    merchantId: uuid('merchant_id').references(() => merchants.id),
    environment: text('environment'),
    type: text('type').notNull(),
    format: text('format').notNull().default('csv'),
    /** Validated per type before insert (`modules/reports/domain/report-params.ts`). */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    rowCount: bigint('row_count', { mode: 'number' }),
    fileKey: text('file_key'),
    fileSize: bigint('file_size', { mode: 'number' }),
    sha256: text('sha256'),
    requestedBy: uuid('requested_by').references(() => users.id),
    /** Set when a schedule created the report. */
    scheduleId: uuid('schedule_id'),
    attempts: smallint('attempts').notNull().default(0),
    /** A worker's claim; another worker may take over after it lapses. */
    leaseExpiresAt: timestamptz('lease_expires_at'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    expiresAt: timestamptz('expires_at'),
    /** A short code, never a stack trace or provider text. */
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reports_ref_key').on(t.ref),
    uniqueIndex('reports_file_key_key')
      .on(t.fileKey)
      .where(sql`${t.fileKey} is not null`),
    index('reports_merchant_idx').on(t.merchantId, t.environment, t.createdAt.desc(), t.ref.desc()),
    index('reports_platform_idx')
      .on(t.createdAt.desc(), t.ref.desc())
      .where(sql`${t.merchantId} is null`),
    index('reports_active_idx')
      .on(t.merchantId, t.status)
      .where(sql`${t.status} in ('queued', 'running')`),
    index('reports_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'ready'`),
    check('reports_ref_check', sql`${t.ref} ~ '^rpt_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('reports_type_check', sql`${t.type} in (${list(REPORT_TYPES)})`),
    check('reports_format_check', sql`${t.format} in (${list(REPORT_FORMATS)})`),
    check('reports_status_check', sql`${t.status} in (${list(REPORT_STATUSES)})`),
    check(
      'reports_environment_check',
      sql`${t.environment} is null or ${t.environment} in ('test', 'live')`
    ),
    check(
      'reports_ready_check',
      sql`(${t.status} in ('ready', 'expired')) = (${t.fileKey} is not null and ${t.rowCount} is not null and ${t.fileSize} is not null)`
    ),
    check('reports_attempts_check', sql`${t.attempts} >= 0`),
  ]
);

export const reportSchedules = core.table(
  'report_schedules',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    environment: text('environment'),
    reportType: text('report_type').notNull(),
    /** Filters that do not depend on time. The window is `period`. */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    /** The window each run covers, relative to its due time: the day, week or month before. */
    period: text('period').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    /** Emails of members of the merchant (or staff, for a platform schedule). */
    recipients: text('recipients')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    format: text('format').notNull().default('csv'),
    active: boolean('active').notNull().default(true),
    lastRunAt: timestamptz('last_run_at'),
    nextRunAt: timestamptz('next_run_at').notNull(),
    lastStatus: text('last_status'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Why the schedule stopped by itself, when it did. */
    disabledReason: text('disabled_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('report_schedules_ref_key').on(t.ref),
    index('report_schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.active} and ${t.deletedAt} is null`),
    index('report_schedules_merchant_idx')
      .on(t.merchantId, t.environment, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    check('report_schedules_ref_check', sql`${t.ref} ~ '^rsc_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('report_schedules_type_check', sql`${t.reportType} in (${list(REPORT_TYPES)})`),
    check('report_schedules_format_check', sql`${t.format} in (${list(REPORT_FORMATS)})`),
    check(
      'report_schedules_period_check',
      sql`${t.period} in ('previous_day', 'previous_week', 'previous_month')`
    ),
    check('report_schedules_recipients_check', sql`cardinality(${t.recipients}) between 1 and 10`),
    check(
      'report_schedules_environment_check',
      sql`${t.environment} is null or ${t.environment} in ('test', 'live')`
    ),
  ]
);

/** One row per scheduled execution. Unique per (schedule, due time). */
export const reportScheduleRuns = core.table(
  'report_schedule_runs',
  {
    id: uuid('id').primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => reportSchedules.id),
    dueAt: timestamptz('due_at').notNull(),
    reportId: uuid('report_id').references(() => reports.id),
    status: text('status').notNull().default('queued'),
    error: text('error'),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    uniqueIndex('report_schedule_runs_due_key').on(t.scheduleId, t.dueAt),
    uniqueIndex('report_schedule_runs_report_key')
      .on(t.reportId)
      .where(sql`${t.reportId} is not null`),
    index('report_schedule_runs_history_idx').on(t.scheduleId, t.dueAt.desc()),
    check(
      'report_schedule_runs_status_check',
      sql`${t.status} in ('queued', 'succeeded', 'failed', 'skipped')`
    ),
  ]
);

/**
 * Daily figures per merchant (spec 5.2), read by every dashboard tile. `environment` is added to
 * the spec's key: test and live data share tables and are separated by it (spec 5).
 * A day is the UTC date a transaction reached its final state.
 */
export const dailyMerchantRollups = core.table(
  'daily_merchant_rollups',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    day: date('date', { mode: 'string' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    channel: text('channel').notNull(),
    provider: text('provider').notNull(),
    paymentCount: integer('payment_count').notNull().default(0),
    paymentMinor: bigint('payment_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    refundCount: integer('refund_count').notNull().default(0),
    refundMinor: bigint('refund_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    payoutCount: integer('payout_count').notNull().default(0),
    payoutMinor: bigint('payout_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    feeMinor: bigint('fee_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    computedAt: timestamptz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.merchantId, t.environment, t.day, t.currency, t.channel, t.provider],
    }),
    index('daily_merchant_rollups_day_idx').on(t.environment, t.day),
    check('daily_merchant_rollups_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'daily_merchant_rollups_counts_check',
      sql`${t.paymentCount} >= 0 and ${t.refundCount} >= 0 and ${t.payoutCount} >= 0
        and ${t.successCount} >= 0 and ${t.failureCount} >= 0
        and ${t.paymentMinor} >= 0 and ${t.refundMinor} >= 0 and ${t.payoutMinor} >= 0 and ${t.feeMinor} >= 0`
    ),
  ]
);
