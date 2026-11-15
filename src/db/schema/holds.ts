/**
 * Holds: reservations against a merchant's available balance (spec 5.2, 6.7).
 *
 * A hold takes money out of `available` without touching the ledger. It ends exactly once:
 * `captured` (the ledger entry for the operation it protected is posted in the same
 * transaction), `released` (the operation did not happen), or `expired` (the sweep found it
 * past `expires_at`). Every end is final.
 *
 * Database rules added by migration 0004 (the domain checks them first):
 *  - a hold is never deleted, and amount, merchant, account, currency, environment and the
 *    placing key never change;
 *  - `state` moves only from `active` to one of the three end states, and each end state
 *    carries exactly its own timestamp (and, for capture and release, its own key);
 *  - a hold is only placed on a merchant payable account of its own merchant and currency.
 *
 * `expires_at` is nullable: a payout hold must outlive the payout, including an ambiguous
 * gateway outcome, so payout holds never expire by the clock (spec 6.3, 17.5).
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { accounts, currencies } from './ledger';
import { merchants } from './merchants';
export const holds = core.table(
  'holds',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    /** The merchant payable account the hold reserves against. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    state: text('state').notNull().default('active'),
    reason: text('reason').notNull(),
    /** The business operation the hold protects. `transactions` is partitioned: no foreign key. */
    transactionId: uuid('transaction_id'),
    expiresAt: timestamptz('expires_at'),
    capturedAt: timestamptz('captured_at'),
    releasedAt: timestamptz('released_at'),
    expiredAt: timestamptz('expired_at'),
    /** Places the hold exactly once, however often the caller retries. */
    idempotencyKey: text('idempotency_key').notNull(),
    captureKey: text('capture_key'),
    releaseKey: text('release_key'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('holds_ref_key').on(t.ref),
    uniqueIndex('holds_idempotency_key_key').on(t.environment, t.idempotencyKey),
    uniqueIndex('holds_capture_key_key')
      .on(t.environment, t.captureKey)
      .where(sql`${t.captureKey} is not null`),
    uniqueIndex('holds_release_key_key')
      .on(t.environment, t.releaseKey)
      .where(sql`${t.releaseKey} is not null`),
    // Spec 9.2 rule 7: holds (merchant_id, state) partial on active.
    index('holds_merchant_active_idx')
      .on(t.merchantId, t.environment, t.currency)
      .where(sql`${t.state} = 'active'`),
    index('holds_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'active' and ${t.expiresAt} is not null`),
    index('holds_transaction_idx')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    check('holds_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('holds_ref_format_check', sql`${t.ref} ~ '^hold_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('holds_amount_check', sql`${t.amountMinor} > 0`),
    check('holds_state_check', sql`${t.state} in ('active', 'captured', 'released', 'expired')`),
    check('holds_reason_check', sql`char_length(${t.reason}) between 1 and 200`),
    check('holds_idempotency_key_check', sql`char_length(${t.idempotencyKey}) between 1 and 128`),
    check(
      'holds_created_by_check',
      sql`${t.createdBy} ~ '^(user|api_key|system|job):[A-Za-z0-9._:-]{1,128}$'`
    ),
    // Each end state carries its own timestamp and nothing else's.
    check(
      'holds_end_state_check',
      sql`(${t.state} = 'captured') = (${t.capturedAt} is not null and ${t.captureKey} is not null)
        and (${t.state} = 'released') = (${t.releasedAt} is not null and ${t.releaseKey} is not null)
        and (${t.state} = 'expired') = (${t.expiredAt} is not null)
        and (${t.captureKey} is null or ${t.state} = 'captured')
        and (${t.releaseKey} is null or ${t.state} = 'released')`
    ),
    check('holds_expiry_check', sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`),
  ]
);
