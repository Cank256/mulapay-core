/**
 * Currencies, chart of accounts, balances and the double-entry journal (spec 5.2 to 5.4,
 * 6.6, decision D5).
 *
 * Migration 0002 adds what drizzle-kit cannot express, and those parts are where most
 * invariants live:
 *
 * - `journal_entries` and `journal_lines` are partitioned by month on `created_at`
 *   (spec 5.1). Their unique keys must include `created_at`, so global uniqueness of
 *   `idempotency_key`, `ref` and `reverses_entry_id` is held by the unpartitioned
 *   `journal_entry_keys` registry, which a trigger fills from every entry insert.
 * - A deferred constraint trigger asserts at commit that each entry has at least two lines
 *   whose debits equal credits, and that a reversal mirrors the entry it reverses.
 * - Row triggers check each line against its entry and account (currency, environment,
 *   merchant, active) and apply it to `account_balances`, which refuses any other write.
 * - Journal tables, the key registry and currencies are append-only: UPDATE, DELETE and
 *   TRUNCATE are revoked from mulapay_core_rw and refused by triggers.
 * - `created_at` and `posted_at` on journal rows are set by the database to the
 *   transaction timestamp; a line can only join an entry created in its own transaction.
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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';

/**
 * `created_at` of journal rows is the partition key and is matched exactly, so it is read
 * as the database's own text (microseconds) rather than a millisecond JavaScript Date.
 */
const exactCreatedAt = (name = 'created_at') =>
  timestamp(name, { withTimezone: true, mode: 'string' }).notNull().defaultNow();
import { core } from './core';
import { merchants } from './merchants';

/** ISO 4217 currencies and their minor-unit exponent (spec 3.8). Seeded, append-only. */
export const currencies = core.table(
  'currencies',
  {
    code: char('code', { length: 3 }).primaryKey(),
    exponent: smallint('exponent').notNull(),
    name: text('name').notNull(),
    isZeroDecimal: boolean('is_zero_decimal').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('currencies_code_check', sql`${t.code} ~ '^[A-Z]{3}$'`),
    check('currencies_exponent_check', sql`${t.exponent} between 0 and 4`),
    check('currencies_zero_decimal_check', sql`${t.isZeroDecimal} = (${t.exponent} = 0)`),
  ]
);

export const accounts = core.table(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    environment: text('environment').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    normalBalance: text('normal_balance').notNull(),
    /** Null: the account holds any currency, one `account_balances` row per currency. */
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    provider: text('provider'),
    purpose: text('purpose').notNull(),
    isSystem: boolean('is_system').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_ref_key').on(t.ref),
    uniqueIndex('accounts_environment_code_key').on(t.environment, t.code),
    index('accounts_merchant_idx')
      .on(t.merchantId)
      .where(sql`${t.merchantId} is not null`),
    index('accounts_purpose_idx').on(t.purpose),
    check('accounts_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('accounts_ref_format_check', sql`${t.ref} ~ '^acct_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('accounts_code_format_check', sql`${t.code} ~ '^[0-9]{4}:[a-z_]+(:[A-Za-z0-9_]+)?$'`),
    check(
      'accounts_type_check',
      sql`${t.type} in ('asset', 'liability', 'equity', 'revenue', 'expense')`
    ),
    check(
      'accounts_normal_balance_check',
      sql`${t.normalBalance} = case when ${t.type} in ('asset', 'expense') then 'debit' else 'credit' end`
    ),
    // Purpose fixes the code number and the type (spec 5.4). Keep in step with
    // src/modules/accounts/domain/chart-of-accounts.ts.
    check(
      'accounts_purpose_check',
      sql`split_part(${t.code}, ':', 2) = ${t.purpose} and split_part(${t.code}, ':', 1) || ':' || ${t.type} = case ${t.purpose}
        when 'provider_clearing' then '1000:asset'
        when 'provider_float' then '1010:asset'
        when 'bank' then '1100:asset'
        when 'settlement_in_transit' then '1200:asset'
        when 'fx_clearing' then '1900:asset'
        when 'merchant_payable' then '2000:liability'
        when 'merchant_reserve' then '2010:liability'
        when 'refund_payable' then '2100:liability'
        when 'tax_payable' then '2200:liability'
        when 'fee_revenue' then '4000:revenue'
        when 'fx_revenue' then '4100:revenue'
        when 'provider_fee_expense' then '5000:expense'
        when 'loss_writeoff' then '5100:expense'
        when 'suspense' then '9000:asset'
      end`
    ),
    check(
      'accounts_scope_check',
      sql`case
        when ${t.purpose} in ('merchant_payable', 'merchant_reserve')
          then ${t.merchantId} is not null and ${t.provider} is null and split_part(${t.code}, ':', 3) ~ '^mch_[0-9A-HJKMNP-TV-Z]{26}$'
        when ${t.purpose} in ('provider_clearing', 'provider_float')
          then ${t.merchantId} is null and ${t.provider} is not null and split_part(${t.code}, ':', 3) = ${t.provider}
        when ${t.purpose} = 'bank'
          then ${t.merchantId} is null and ${t.provider} is null and split_part(${t.code}, ':', 3) ~ '^[a-z0-9_]{2,40}$'
        else ${t.merchantId} is null and ${t.provider} is null and split_part(${t.code}, ':', 3) = ''
      end`
    ),
    check(
      'accounts_provider_check',
      sql`${t.provider} is null or ${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    check('accounts_is_system_check', sql`${t.isSystem} = (${t.merchantId} is null)`),
    check('accounts_name_check', sql`char_length(${t.name}) between 1 and 200`),
  ]
);

/**
 * Posted totals per (account, currency) (spec 5.2, 6.7). Written only by the journal line
 * trigger; both totals only grow, so the balance is always `f(normal_balance, debits,
 * credits)` and a reversal adds to both sides instead of subtracting.
 */
export const accountBalances = core.table(
  'account_balances',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    postedDebitsMinor: bigint('posted_debits_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    postedCreditsMinor: bigint('posted_credits_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    version: bigint('version', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.currency] }),
    check('account_balances_debits_check', sql`${t.postedDebitsMinor} >= 0`),
    check('account_balances_credits_check', sql`${t.postedCreditsMinor} >= 0`),
    check('account_balances_version_check', sql`${t.version} >= 0`),
  ]
);

/**
 * Global uniqueness for journal entries, which a partitioned table cannot hold itself:
 * one entry per idempotency key, unique refs, and at most one reversal per entry. Filled
 * only by the `journal_entries` insert trigger; append-only.
 */
export const journalEntryKeys = core.table(
  'journal_entry_keys',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    entryId: uuid('entry_id').notNull(),
    entryRef: text('entry_ref').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true, mode: 'string' }).notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    reversesEntryId: uuid('reverses_entry_id'),
    createdAt: createdAt(),
  },
  (t) => [
    // Constraints rather than indexes: foreign keys reference them.
    unique('journal_entry_keys_entry_id_key').on(t.entryId),
    unique('journal_entry_keys_entry_ref_key').on(t.entryRef),
    unique('journal_entry_keys_reverses_entry_id_key').on(t.reversesEntryId),
    foreignKey({
      columns: [t.reversesEntryId],
      foreignColumns: [t.entryId],
      name: 'journal_entry_keys_reverses_entry_id_fk',
    }),
  ]
);

/** Partitioned by month on `created_at` (hand edit in migration 0002). */
export const journalEntries = core.table(
  'journal_entries',
  {
    id: uuid('id').notNull(),
    ref: text('ref').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** sha256 of the material fields; a replay with a different body is refused. */
    requestFingerprint: text('request_fingerprint').notNull(),
    environment: text('environment').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    /** `transactions` arrives in Phase 4 and is partitioned, so there is no foreign key. */
    transactionId: uuid('transaction_id'),
    source: text('source').notNull(),
    /** The originating business operation (gateway event id, payout id, entry ref, ...). */
    sourceId: text('source_id').notNull(),
    reversesEntryId: uuid('reverses_entry_id'),
    postedAt: timestamptz('posted_at').notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    createdAt: exactCreatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    foreignKey({
      columns: [t.id],
      foreignColumns: [journalEntryKeys.entryId],
      name: 'journal_entries_registry_fk',
    }),
    index('journal_entries_created_idx').on(t.createdAt.desc(), t.id.desc()),
    index('journal_entries_merchant_created_idx').on(t.merchantId, t.createdAt.desc()),
    index('journal_entries_source_idx').on(t.source, t.sourceId),
    index('journal_entries_transaction_idx')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    check('journal_entries_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('journal_entries_ref_format_check', sql`${t.ref} ~ '^je_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('journal_entries_idempotency_key_check', sql`${t.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    check('journal_entries_fingerprint_check', sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'journal_entries_source_check',
      sql`${t.source} in ('payment', 'payout', 'refund', 'fee', 'settlement', 'adjustment', 'reversal')`
    ),
    check(
      'journal_entries_reversal_check',
      sql`(${t.source} = 'reversal') = (${t.reversesEntryId} is not null)`
    ),
    check('journal_entries_kind_check', sql`${t.kind} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
    check(
      'journal_entries_description_check',
      sql`char_length(${t.description}) between 1 and 500`
    ),
    check('journal_entries_source_id_check', sql`char_length(${t.sourceId}) between 1 and 128`),
    check(
      'journal_entries_created_by_check',
      sql`${t.createdBy} ~ '^(user|api_key|system|job):[A-Za-z0-9._:-]{1,128}$'`
    ),
  ]
);

/** Partitioned by month on `created_at` (hand edit in migration 0002). */
export const journalLines = core.table(
  'journal_lines',
  {
    entryId: uuid('entry_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    direction: text('direction').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Copied from the account by the insert trigger, for merchant-scoped reads. */
    merchantId: uuid('merchant_id'),
    metadata: jsonb('metadata').$type<Record<string, string>>(),
    createdAt: exactCreatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.lineNo, t.createdAt] }),
    foreignKey({
      columns: [t.entryId, t.createdAt],
      foreignColumns: [journalEntries.id, journalEntries.createdAt],
      name: 'journal_lines_entry_fk',
    }),
    index('journal_lines_account_created_idx').on(t.accountId, t.createdAt.desc()),
    index('journal_lines_merchant_created_idx')
      .on(t.merchantId, t.createdAt.desc())
      .where(sql`${t.merchantId} is not null`),
    check('journal_lines_direction_check', sql`${t.direction} in ('debit', 'credit')`),
    check('journal_lines_amount_positive_check', sql`${t.amountMinor} > 0`),
    check('journal_lines_line_no_check', sql`${t.lineNo} between 1 and 100`),
  ]
);
