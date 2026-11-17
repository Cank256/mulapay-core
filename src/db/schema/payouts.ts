/**
 * Payouts schema (Phase 4): disbursements to merchants or third parties.
 */
import { pgTable, uuid, text, bigint, char, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, timestamptz } from './columns';
import { transactions } from './transactions';
import { merchants } from './merchants';
import { payments } from './payments';

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().notNull(),
    ref: text('ref').notNull().unique(),
    transactionId: uuid('transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status').notNull().default('created'),
    channel: text('channel').notNull(),
    destination: jsonb('destination').notNull(),
    destinationEncrypted: text('destination_encrypted'),
    description: text('description'),
    holdRef: text('hold_ref'),
    approvalRef: text('approval_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    environmentCheck: check(
      'payouts_environment_check',
      sql`${table.environment} in ('test', 'live')`
    ),
    refFormatCheck: check(
      'payouts_ref_format_check',
      sql`${table.ref} ~ '^pyt_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    statusCheck: check(
      'payouts_status_check',
      sql`${table.status} in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')`
    ),
    amountCheck: check('payouts_amount_check', sql`${table.amountMinor} > 0`),
    channelCheck: check(
      'payouts_channel_check',
      sql`${table.channel} in ('mobile_money', 'bank')`
    ),
    idempotencyKeyCheck: check(
      'payouts_idempotency_key_check',
      sql`char_length(${table.idempotencyKey}) between 1 and 255`
    ),
    currencyCheck: check('payouts_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    merchantIdempotencyKeyIdx: uniqueIndex('payouts_merchant_idempotency_key_idx').on(
      table.merchantId,
      table.environment,
      table.idempotencyKey
    ),
    merchantCreatedIdx: index('payouts_merchant_created_idx').on(
      table.merchantId,
      table.environment,
      table.createdAt.desc()
    ),
    statusIdx: index('payouts_status_idx')
      .on(table.status)
      .where(sql`${table.status} in ('processing', 'pending_approval')`),
  })
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().notNull(),
    ref: text('ref').notNull().unique(),
    transactionId: uuid('transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status').notNull().default('created'),
    reason: text('reason'),
    holdRef: text('hold_ref'),
    approvalRef: text('approval_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    environmentCheck: check(
      'refunds_environment_check',
      sql`${table.environment} in ('test', 'live')`
    ),
    refFormatCheck: check(
      'refunds_ref_format_check',
      sql`${table.ref} ~ '^rfd_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    statusCheck: check(
      'refunds_status_check',
      sql`${table.status} in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled')`
    ),
    amountCheck: check('refunds_amount_check', sql`${table.amountMinor} > 0`),
    idempotencyKeyCheck: check(
      'refunds_idempotency_key_check',
      sql`char_length(${table.idempotencyKey}) between 1 and 255`
    ),
    currencyCheck: check('refunds_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    reasonCheck: check(
      'refunds_reason_check',
      sql`${table.reason} is null or char_length(${table.reason}) between 1 and 500`
    ),
    merchantIdempotencyKeyIdx: uniqueIndex('refunds_merchant_idempotency_key_idx').on(
      table.merchantId,
      table.environment,
      table.idempotencyKey
    ),
    paymentIdIdx: index('refunds_payment_id_idx').on(table.paymentId),
    merchantCreatedIdx: index('refunds_merchant_created_idx').on(
      table.merchantId,
      table.environment,
      table.createdAt.desc()
    ),
    statusIdx: index('refunds_status_idx')
      .on(table.status)
      .where(sql`${table.status} in ('processing', 'pending_approval')`),
  })
);
