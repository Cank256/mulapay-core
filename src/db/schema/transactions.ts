/**
 * The transaction read model and its event log (spec 5.2 money movement, 6.5).
 *
 * `transactions` is partitioned by month on `created_at` (spec 5.1), a hand edit in
 * migration 0003. A partitioned table cannot hold a unique index without the partition key,
 * so global uniqueness of `ref` and of the gateway `external_id` lives in the unpartitioned
 * `transaction_keys` registry, which a trigger fills from every transaction insert (the same
 * approach as `journal_entry_keys`). The registry also lets a lookup by public ref find the
 * partition key first, so the read is pruned to one partition.
 *
 * `created_at` is set by the application from the injected clock (millisecond precision), so
 * the keyset cursor `(created_at, ref)` compares exactly and a payment can share its
 * transaction's `created_at` for the composite foreign key.
 *
 * Database rules added by the migration (the domain checks them first):
 *  - rows are never deleted; terminal payment rows never change again;
 *  - a payment status change must be one of the allowed pairs (`core.payment_transition_allowed`);
 *  - amount, currency, merchant, environment, type and channel never change;
 *  - gateway identifiers and the provider are set once;
 *  - `completed_at` is set exactly when the status is terminal;
 *  - `outcome_unknown` is only ever true while `processing`;
 *  - a deferred trigger asserts that each payment transaction and its `payments` row agree.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { currencies } from './ledger';
import { merchants } from './merchants';

/** Statuses a payment transaction can hold. Keep in step with the payment state machine. */
export const PAYMENT_STATUS_SQL = sql.raw(
  "'created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired'"
);
const TERMINAL_PAYMENT_STATUS_SQL = sql.raw("'succeeded', 'failed', 'cancelled', 'expired'");

/** Uniqueness and lookup registry for the partitioned `transactions`. Insert-only. */
export const transactionKeys = core.table(
  'transaction_keys',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    transactionCreatedAt: timestamptz('transaction_created_at').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    type: text('type').notNull(),
    /** Core's idempotency key at the gateway (spec 3.4), unique per operation type. */
    gatewayExternalId: text('gateway_external_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('transaction_keys_ref_key').on(t.ref),
    unique('transaction_keys_type_external_id_key').on(t.type, t.gatewayExternalId),
    index('transaction_keys_merchant_idx').on(t.merchantId, t.environment),
  ]
);

/** Partitioned by month on `created_at` (hand edit in migration 0003). */
export const transactions = core.table(
  'transactions',
  {
    id: uuid('id').notNull(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    feeMinor: bigint('fee_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Set once, when the routing service or the first gateway event names it. */
    provider: text('provider'),
    channel: text('channel').notNull(),
    gatewayOperationId: uuid('gateway_operation_id'),
    gatewayExternalId: text('gateway_external_id'),
    gatewayReferenceId: text('gateway_reference_id'),
    providerTransactionId: text('provider_transaction_id'),
    failureCode: text('failure_code'),
    /** Internal detail. Never returned to merchants: it can carry provider wording. */
    failureReason: text('failure_reason'),
    /** True only while `processing` and the gateway has not said what happened (spec 3.7). */
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    initiatedAt: timestamptz('initiated_at'),
    completedAt: timestamptz('completed_at'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    foreignKey({
      columns: [t.id],
      foreignColumns: [transactionKeys.id],
      name: 'transactions_registry_fk',
    }),
    index('transactions_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('transactions_merchant_status_created_idx').on(
      t.merchantId,
      t.environment,
      t.status,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('transactions_gateway_external_id_idx')
      .on(t.gatewayExternalId)
      .where(sql`${t.gatewayExternalId} is not null`),
    index('transactions_provider_transaction_id_idx')
      .on(t.providerTransactionId)
      .where(sql`${t.providerTransactionId} is not null`),
    check('transactions_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('transactions_ref_format_check', sql`${t.ref} ~ '^txn_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check(
      'transactions_type_check',
      sql`${t.type} in ('payment', 'payout', 'refund', 'fee', 'adjustment', 'transfer', 'settlement')`
    ),
    // Statuses are per type; later phases add the payout and refund sets here.
    check(
      'transactions_status_check',
      sql`${t.type} <> 'payment' or ${t.status} in (${PAYMENT_STATUS_SQL})`
    ),
    check('transactions_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'transactions_fee_net_check',
      sql`${t.feeMinor} >= 0 and ${t.feeMinor} <= ${t.amountMinor} and ${t.netMinor} = ${t.amountMinor} - ${t.feeMinor}`
    ),
    check('transactions_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('transactions_channel_check', sql`${t.channel} in ('mobile_money', 'card', 'bank')`),
    check(
      'transactions_provider_check',
      sql`${t.provider} is null or ${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    check(
      'transactions_completed_at_check',
      sql`${t.type} <> 'payment' or ((${t.status} in (${TERMINAL_PAYMENT_STATUS_SQL})) = (${t.completedAt} is not null))`
    ),
    // Spec 3.7 and 17.5: unknown is a flag on `processing`, never a state of its own.
    check(
      'transactions_outcome_unknown_check',
      sql`not ${t.outcomeUnknown} or ${t.status} = 'processing'`
    ),
    check(
      'transactions_failure_check',
      sql`(${t.failureCode} is null or (${t.failureCode} ~ '^[a-z][a-z0-9_]{0,63}$' and ${t.status} in ('failed', 'cancelled', 'expired')))
        and (${t.failureReason} is null or ${t.failureCode} is not null)`
    ),
    // A success is only recorded for a known provider: the ledger posting needs it.
    check(
      'transactions_success_provider_check',
      sql`${t.type} <> 'payment' or ${t.status} <> 'succeeded' or ${t.provider} is not null`
    ),
    check(
      'transactions_external_id_check',
      sql`${t.gatewayExternalId} is null or char_length(${t.gatewayExternalId}) between 1 and 128`
    ),
  ]
);

/**
 * Append-only log of what happened to a transaction: one row per distinct event key,
 * including events that were refused. It is the merchant-visible timeline (spec 6.5) and
 * the record Phase 6 reconciliation reads to raise exceptions for rejected events.
 *
 * `(transaction_id, event_key)` is unique: a gateway event, a chase result or a job tick
 * delivered twice is recorded once, and the second delivery changes nothing.
 */
export const transactionEvents = core.table(
  'transaction_events',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactionKeys.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    /** Gateway `event_id`, chase attempt id, or a deterministic business key. */
    eventKey: text('event_key').notNull(),
    source: text('source').notNull(),
    outcome: text('outcome').notNull(),
    fromStatus: text('from_status'),
    /** The status the event asked for; for a rejected event this is not the current status. */
    toStatus: text('to_status').notNull(),
    rejectionReason: text('rejection_reason'),
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    failureCode: text('failure_code'),
    /** When the source says it happened (gateway `occurred_at`); defaults to receipt. */
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('transaction_events_key_idx').on(t.transactionId, t.eventKey),
    index('transaction_events_transaction_idx').on(t.transactionId, t.createdAt, t.id),
    index('transaction_events_rejected_idx')
      .on(t.createdAt)
      .where(sql`${t.outcome} = 'rejected'`),
    check('transaction_events_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'transaction_events_source_check',
      sql`${t.source} in ('api', 'job', 'gateway_event', 'chase')`
    ),
    check('transaction_events_outcome_check', sql`${t.outcome} in ('applied', 'noop', 'rejected')`),
    check('transaction_events_key_check', sql`char_length(${t.eventKey}) between 1 and 128`),
    check(
      'transaction_events_rejection_check',
      sql`(${t.outcome} = 'rejected') = (${t.rejectionReason} is not null)`
    ),
    check(
      'transaction_events_status_check',
      sql`(${t.fromStatus} is null or ${t.fromStatus} in (${PAYMENT_STATUS_SQL})) and ${t.toStatus} in (${PAYMENT_STATUS_SQL})`
    ),
  ]
);
