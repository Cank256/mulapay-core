/**
 * Settlement (spec 5.2 "Settlement and reconciliation", 6.9): cycles, runs, batches, items,
 * the rolling reserve and the merchant's settlement destination.
 *
 * Database rules added by migration 0006 (the domain checks them first):
 *  - a batch's amounts never change, and its status moves only along
 *    draft -> pending_approval -> approved -> releasing -> paid, with `failed` from
 *    `releasing` and `cancelled` from any state before `releasing`;
 *  - the approver is never the person who submitted the batch (maker-checker);
 *  - a batch never pays less than its own `min_payout_minor` snapshot (no dust payouts);
 *  - items, batch events and runs are never deleted; items and events are never updated;
 *  - one live (not cancelled, not failed) batch per merchant, cycle, currency and period.
 *
 * Money is `bigint` minor units. Settlement is live-only: test data never settles.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { currencies } from './ledger';
import { merchants } from './merchants';

export const settlementCycles = core.table(
  'settlement_cycles',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    name: text('name').notNull(),
    /** Cron expression (5 fields) in `timezone`; the worker runs the cycle at each tick. */
    schedule: text('schedule').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Days a payment must age past the cutoff before it is settled. */
    delayDays: smallint('delay_days').notNull(),
    /** Local wall-clock time of the daily cutoff, `HH:MM`. */
    cutoffTime: text('cutoff_time').notNull(),
    timezone: text('timezone').notNull(),
    /** A batch below this rolls into the next cycle (spec 6.9). */
    minPayoutMinor: bigint('min_payout_minor', { mode: 'bigint' }).notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_cycles_ref_key').on(t.ref),
    uniqueIndex('settlement_cycles_name_key').on(t.name),
    check('settlement_cycles_ref_format_check', sql.raw(`ref ~ '^scy_[0-9A-HJKMNP-TV-Z]{26}$'`)),
    check('settlement_cycles_delay_check', sql`${t.delayDays} between 0 and 90`),
    check(
      'settlement_cycles_cutoff_check',
      sql`${t.cutoffTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`
    ),
    check('settlement_cycles_min_payout_check', sql`${t.minPayoutMinor} >= 0`),
    check('settlement_cycles_name_length_check', sql`char_length(${t.name}) between 1 and 80`),
  ]
);

/** One run per cycle and period end: running it again returns this row (idempotent). */
export const settlementRuns = core.table(
  'settlement_runs',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => settlementCycles.id),
    periodEnd: timestamptz('period_end').notNull(),
    /** The instant the run was computed for (the scheduled tick, or "now" for a manual run). */
    asOf: timestamptz('as_of').notNull(),
    status: text('status').notNull().default('running'),
    attempts: integer('attempts').notNull().default(1),
    triggeredBy: text('triggered_by').notNull(),
    merchantsConsidered: integer('merchants_considered').notNull().default(0),
    batchesCreated: integer('batches_created').notNull().default(0),
    rolledOver: integer('rolled_over').notNull().default(0),
    nothingToSettle: integer('nothing_to_settle').notNull().default(0),
    failedMerchants: integer('failed_merchants').notNull().default(0),
    /** Merchant refs and amounts rolled into the next cycle. No PII. */
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_runs_ref_key').on(t.ref),
    uniqueIndex('settlement_runs_cycle_period_key').on(t.cycleId, t.periodEnd),
    index('settlement_runs_cycle_created_idx').on(t.cycleId, t.createdAt.desc()),
    check('settlement_runs_ref_format_check', sql.raw(`ref ~ '^srun_[0-9A-HJKMNP-TV-Z]{26}$'`)),
    check('settlement_runs_status_check', sql`${t.status} in ('running', 'completed', 'failed')`),
    check(
      'settlement_runs_finished_check',
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`
    ),
  ]
);

/** Where a merchant's settlements are paid. The details are encrypted (spec 11). */
export const settlementDestinations = core.table(
  'settlement_destinations',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    provider: text('provider').notNull(),
    channel: text('channel').notNull().default('mobile_money'),
    /** AES-256-GCM envelope of `{ partyIdType, partyId }`. */
    detailsEnc: text('details_enc').notNull(),
    /** Masked form for screens and reports, for example `+256•••••789`. */
    display: text('display').notNull(),
    /** HMAC of the details: lets a batch prove the destination did not change after approval. */
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    retiredAt: timestamptz('retired_at'),
  },
  (t) => [
    uniqueIndex('settlement_destinations_ref_key').on(t.ref),
    uniqueIndex('settlement_destinations_active_key')
      .on(t.merchantId, t.currency)
      .where(sql`${t.status} = 'active'`),
    check(
      'settlement_destinations_ref_format_check',
      sql.raw(`ref ~ '^sd_[0-9A-HJKMNP-TV-Z]{26}$'`)
    ),
    check(
      'settlement_destinations_provider_check',
      sql`${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    // The gateway's party types are MSISDN, EMAIL and PARTY_CODE: a bank payee has no wire form.
    check('settlement_destinations_channel_check', sql`${t.channel} = 'mobile_money'`),
    check('settlement_destinations_status_check', sql`${t.status} in ('active', 'retired')`),
    check(
      'settlement_destinations_retired_check',
      sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`
    ),
  ]
);

export const rollingReserves = core.table(
  'rolling_reserves',
  {
    id: uuid('id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    percentBps: integer('percent_bps').notNull(),
    holdDays: integer('hold_days').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rolling_reserves_merchant_currency_key').on(t.merchantId, t.currency),
    check('rolling_reserves_bps_check', sql`${t.percentBps} between 0 and 10000`),
    check('rolling_reserves_days_check', sql`${t.holdDays} between 0 and 365`),
  ]
);

export const settlementBatches = core.table(
  'settlement_batches',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => settlementCycles.id),
    runId: uuid('run_id').references(() => settlementRuns.id),
    environment: text('environment').notNull().default('live'),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    /** Succeeded payments completed in the period. */
    grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
    refundMinor: bigint('refund_minor', { mode: 'bigint' }).notNull(),
    feeMinor: bigint('fee_minor', { mode: 'bigint' }).notNull(),
    /** Withheld into the reserve account by this batch. */
    reserveMinor: bigint('reserve_minor', { mode: 'bigint' }).notNull(),
    /** Earlier reserve released into this batch. */
    reserveReleaseMinor: bigint('reserve_release_minor', { mode: 'bigint' }).notNull(),
    disputeHoldMinor: bigint('dispute_hold_minor', { mode: 'bigint' }).notNull(),
    amlHoldMinor: bigint('aml_hold_minor', { mode: 'bigint' }).notNull(),
    /** Earned this period but not payable because the payable balance could not cover it. */
    shortfallMinor: bigint('shortfall_minor', { mode: 'bigint' }).notNull(),
    /** Taken from the merchant payable account and paid out (not counting the reserve). */
    payableDrawMinor: bigint('payable_draw_minor', { mode: 'bigint' }).notNull(),
    /** What the payout sends: `payable_draw_minor + reserve_release_minor`. */
    netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
    minPayoutMinor: bigint('min_payout_minor', { mode: 'bigint' }).notNull(),
    reserveHoldDays: integer('reserve_hold_days').notNull().default(0),
    status: text('status').notNull().default('draft'),
    destinationId: uuid('destination_id').references(() => settlementDestinations.id),
    destinationFingerprint: text('destination_fingerprint'),
    provider: text('provider'),
    submittedBy: uuid('submitted_by'),
    submittedAt: timestamptz('submitted_at'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamptz('approved_at'),
    cancelledBy: text('cancelled_by'),
    cancelReason: text('cancel_reason'),
    /** The gateway `externalId` of the disbursement (spec 3.4: `po_` + ULID). */
    payoutRef: text('payout_ref'),
    /** `transactions` is partitioned: no foreign key. */
    payoutTransactionId: uuid('payout_transaction_id'),
    holdId: uuid('hold_id'),
    releasedAt: timestamptz('released_at'),
    paidAt: timestamptz('paid_at'),
    failureCode: text('failure_code'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlement_batches_ref_key').on(t.ref),
    // Spec 6.9: idempotent per (merchant, cycle, period). A cancelled or failed batch frees its period.
    uniqueIndex('settlement_batches_live_period_key')
      .on(t.merchantId, t.cycleId, t.currency, t.periodStart, t.periodEnd)
      .where(sql`${t.status} not in ('cancelled', 'failed')`),
    uniqueIndex('settlement_batches_payout_ref_key')
      .on(t.payoutRef)
      .where(sql`${t.payoutRef} is not null`),
    index('settlement_batches_merchant_created_idx').on(t.merchantId, t.createdAt.desc(), t.ref),
    index('settlement_batches_status_idx').on(t.status, t.createdAt.desc()),
    index('settlement_batches_cycle_idx').on(t.cycleId, t.periodEnd.desc()),
    check('settlement_batches_ref_format_check', sql.raw(`ref ~ '^stl_[0-9A-HJKMNP-TV-Z]{26}$'`)),
    check('settlement_batches_live_check', sql`${t.environment} = 'live'`),
    check(
      'settlement_batches_status_check',
      sql`${t.status} in ('draft', 'pending_approval', 'approved', 'releasing', 'paid', 'failed', 'cancelled')`
    ),
    check('settlement_batches_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      'settlement_batches_amounts_check',
      sql`${t.grossMinor} >= 0 and ${t.refundMinor} >= 0 and ${t.feeMinor} >= 0
        and ${t.reserveMinor} >= 0 and ${t.reserveReleaseMinor} >= 0
        and ${t.disputeHoldMinor} >= 0 and ${t.amlHoldMinor} >= 0 and ${t.shortfallMinor} >= 0
        and ${t.payableDrawMinor} >= 0 and ${t.minPayoutMinor} >= 0`
    ),
    // The payout is the draw from the payable account plus the reserve released into it.
    check(
      'settlement_batches_net_check',
      sql`${t.netMinor} = ${t.payableDrawMinor} + ${t.reserveReleaseMinor}`
    ),
    // Spec 6.9: no dust payout. Anything below the minimum rolls over and creates no batch.
    check(
      'settlement_batches_min_payout_check',
      sql`${t.netMinor} > 0 and ${t.netMinor} >= ${t.minPayoutMinor}`
    ),
    check(
      'settlement_batches_approval_check',
      sql`(${t.status} not in ('approved', 'releasing', 'paid') or (${t.approvedBy} is not null and ${t.approvedAt} is not null))
        and (${t.approvedBy} is null or ${t.submittedBy} is null or ${t.approvedBy} <> ${t.submittedBy})`
    ),
    check(
      'settlement_batches_release_check',
      sql`(${t.status} not in ('releasing', 'paid') or (${t.payoutRef} is not null and ${t.payoutTransactionId} is not null and ${t.releasedAt} is not null))
        and (${t.status} <> 'paid' or ${t.paidAt} is not null)`
    ),
    check(
      'settlement_batches_provider_check',
      sql`${t.provider} is null or ${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    check(
      'settlement_batches_payout_ref_format_check',
      sql.raw(`payout_ref is null or payout_ref ~ '^po_[0-9A-HJKMNP-TV-Z]{26}$'`)
    ),
  ]
);

/** Append-only status history of a batch, including gateway outcomes (keyed to dedupe). */
export const settlementBatchEvents = core.table(
  'settlement_batch_events',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => settlementBatches.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** `transition`, or the outcome of a payout event (`outcome_applied`, `outcome_rejected`...). */
    kind: text('kind').notNull(),
    /** Set for payout outcomes: the same key applied twice is recorded once. */
    eventKey: text('event_key'),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('settlement_batch_events_batch_idx').on(t.batchId, t.createdAt, t.id),
    uniqueIndex('settlement_batch_events_key_idx')
      .on(t.batchId, t.eventKey)
      .where(sql`${t.eventKey} is not null`),
  ]
);

export const settlementItems = core.table(
  'settlement_items',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => settlementBatches.id),
    /** Null for reserve and hold lines. `transactions` is partitioned: no foreign key. */
    transactionId: uuid('transaction_id'),
    transactionRef: text('transaction_ref'),
    kind: text('kind').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    feeMinor: bigint('fee_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
    occurredAt: timestamptz('occurred_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('settlement_items_batch_idx').on(t.batchId, t.kind, t.occurredAt, t.id),
    index('settlement_items_transaction_idx')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    check(
      'settlement_items_kind_check',
      sql`${t.kind} in ('payment', 'refund', 'reserve_withheld', 'reserve_released', 'dispute_hold', 'aml_hold')`
    ),
    check('settlement_items_amount_check', sql`${t.amountMinor} > 0 and ${t.feeMinor} >= 0`),
    check(
      'settlement_items_net_check',
      sql`${t.netMinor} = ${t.amountMinor} - ${t.feeMinor} and ${t.feeMinor} <= ${t.amountMinor}`
    ),
    check(
      'settlement_items_transaction_check',
      sql`(${t.kind} in ('payment', 'refund')) = (${t.transactionId} is not null)`
    ),
  ]
);

/**
 * Reserve withheld by a paid batch, kept for `hold_days`. Created when the batch pays (the
 * ledger moves the money then). `release_batch_id` claims an entry for a draft batch so two
 * batches cannot release the same reserve; `released_at` is set when that batch pays.
 */
export const reserveEntries = core.table(
  'reserve_entries',
  {
    id: uuid('id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    holdUntil: timestamptz('hold_until').notNull(),
    settlementBatchId: uuid('settlement_batch_id')
      .notNull()
      .references(() => settlementBatches.id),
    releaseBatchId: uuid('release_batch_id').references(() => settlementBatches.id),
    releasedAt: timestamptz('released_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reserve_entries_source_batch_key').on(t.settlementBatchId),
    index('reserve_entries_due_idx')
      .on(t.merchantId, t.currency, t.holdUntil)
      .where(sql`${t.releasedAt} is null`),
    index('reserve_entries_release_batch_idx')
      .on(t.releaseBatchId)
      .where(sql`${t.releaseBatchId} is not null`),
    check('reserve_entries_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'reserve_entries_release_check',
      sql`${t.releasedAt} is null or ${t.releaseBatchId} is not null`
    ),
  ]
);
