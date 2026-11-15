/**
 * Payments, payment links and checkout sessions (spec 5.2 money movement, 6.1).
 *
 * One payment maps to exactly one `transactions` row of type `payment`. The payment shares
 * the transaction's `created_at`, so the composite foreign key `(transaction_id, created_at)`
 * resolves to one partition. A deferred trigger (migration 0003) asserts at commit that the
 * two rows agree on status, amount, currency, merchant and environment.
 *
 * Payment links and checkout sessions create payments lazily, on first use (spec 6.1).
 * `payment_links.used_count` is incremented in the same transaction as the payment it
 * pays for, and a CHECK keeps it within `max_uses`.
 *
 * `customer_id` is not here yet: the customers table arrives with its module.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { currencies } from './ledger';
import { merchants } from './merchants';
import { PAYMENT_STATUS_SQL, transactions } from './transactions';

export const paymentLinks = core.table(
  'payment_links',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    /** Null for an open-amount link: the payer chooses the amount. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    title: text('title').notNull(),
    description: text('description'),
    slug: text('slug').notNull(),
    active: boolean('active').notNull().default(true),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamptz('expires_at'),
    successUrl: text('success_url'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_links_ref_key').on(t.ref),
    uniqueIndex('payment_links_slug_key').on(t.slug),
    index('payment_links_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    check('payment_links_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('payment_links_ref_format_check', sql`${t.ref} ~ '^pl_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('payment_links_slug_check', sql`${t.slug} ~ '^[a-z0-9]{12}$'`),
    check('payment_links_amount_check', sql`${t.amountMinor} is null or ${t.amountMinor} > 0`),
    check('payment_links_max_uses_check', sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    // The database, not only the service, stops a link being used past its limit.
    check(
      'payment_links_used_count_check',
      sql`${t.usedCount} >= 0 and (${t.maxUses} is null or ${t.usedCount} <= ${t.maxUses})`
    ),
    check('payment_links_title_check', sql`char_length(${t.title}) between 1 and 200`),
  ]
);

export const checkoutSessions = core.table(
  'checkout_sessions',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    status: text('status').notNull().default('open'),
    /** Set on first use, once. A session pays for at most one payment. */
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    description: text('description'),
    successUrl: text('success_url'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    expiresAt: timestamptz('expires_at').notNull(),
    /** SHA-256 of the client secret, which is shown once at creation. */
    clientSecretHash: text('client_secret_hash').notNull(),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('checkout_sessions_ref_key').on(t.ref),
    unique('checkout_sessions_payment_id_key').on(t.paymentId),
    index('checkout_sessions_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('checkout_sessions_open_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'open'`),
    check('checkout_sessions_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('checkout_sessions_ref_format_check', sql`${t.ref} ~ '^cs_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('checkout_sessions_status_check', sql`${t.status} in ('open', 'complete', 'expired')`),
    check('checkout_sessions_amount_check', sql`${t.amountMinor} > 0`),
    check('checkout_sessions_secret_hash_check', sql`${t.clientSecretHash} ~ '^[0-9a-f]{64}$'`),
    // A completed session paid for a payment, and `completed_at` marks exactly that.
    check(
      'checkout_sessions_complete_check',
      sql`(${t.status} = 'complete') = (${t.completedAt} is not null)
        and (${t.status} <> 'complete' or ${t.paymentId} is not null)`
    ),
  ]
);

export const payments = core.table(
  'payments',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    transactionId: uuid('transaction_id').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    status: text('status').notNull().default('created'),
    channel: text('channel').notNull(),
    /** `{ provider?, msisdnEnc?, msisdnLast4? }`. The number is AES-GCM encrypted. */
    paymentMethod: jsonb('payment_method')
      .$type<{ provider?: string; msisdnEnc?: string; msisdnLast4?: string }>()
      .notNull()
      .default({}),
    description: text('description'),
    statementDescriptor: text('statement_descriptor'),
    returnUrl: text('return_url'),
    paymentLinkId: uuid('payment_link_id').references(() => paymentLinks.id),
    checkoutSessionId: uuid('checkout_session_id').references(
      (): AnyPgColumn => checkoutSessions.id
    ),
    /** The caller's `Idempotency-Key`; unique per merchant and environment, for ever. */
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    /** Equals the transaction's `created_at`; see the composite foreign key. */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_ref_key').on(t.ref),
    unique('payments_transaction_id_key').on(t.transactionId),
    uniqueIndex('payments_idempotency_key_key').on(t.merchantId, t.environment, t.idempotencyKey),
    foreignKey({
      columns: [t.transactionId, t.createdAt],
      foreignColumns: [transactions.id, transactions.createdAt],
      name: 'payments_transaction_fk',
    }),
    index('payments_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    // The expiry sweep only touches payments that were never submitted to a provider.
    index('payments_created_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'created'`),
    index('payments_checkout_session_idx')
      .on(t.checkoutSessionId)
      .where(sql`${t.checkoutSessionId} is not null`),
    check('payments_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('payments_ref_format_check', sql`${t.ref} ~ '^pay_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('payments_status_check', sql`${t.status} in (${PAYMENT_STATUS_SQL})`),
    check('payments_amount_check', sql`${t.amountMinor} > 0`),
    check('payments_channel_check', sql`${t.channel} in ('mobile_money', 'card', 'bank')`),
    check(
      'payments_idempotency_key_check',
      sql`char_length(${t.idempotencyKey}) between 1 and 255`
    ),
    check(
      'payments_statement_descriptor_check',
      sql`${t.statementDescriptor} is null or char_length(${t.statementDescriptor}) between 1 and 22`
    ),
    // One origin at most: a payment is made directly, through a link, or through a session.
    check(
      'payments_origin_check',
      sql`${t.paymentLinkId} is null or ${t.checkoutSessionId} is null`
    ),
  ]
);
