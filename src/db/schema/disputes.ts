/**
 * Disputes and chargebacks (spec 5.2, 6.14). They are a table of their own because they hold
 * money: opening one places a hold on the merchant's balance for the disputed amount, and
 * resolving it either releases the hold or captures it and posts to the ledger.
 *
 * Database rules added by migration 0007 (the domain checks them first):
 *  - what a dispute is about (transaction, merchant, currency, amount, kind) never changes;
 *  - status moves open -> under_review -> resolved, or open -> resolved, and resolved is final;
 *  - a transaction has at most one unresolved dispute;
 *  - an outcome exists exactly when the dispute is resolved.
 */
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { holds } from './holds';
import { users } from './identity';
import { currencies } from './ledger';
import { merchants } from './merchants';
import { transactionKeys } from './transactions';

export const DISPUTE_KINDS = ['chargeback', 'inquiry', 'pre_arbitration'] as const;
export const DISPUTE_STATUSES = ['open', 'under_review', 'resolved'] as const;
export const DISPUTE_OUTCOMES = ['merchant_won', 'merchant_lost', 'withdrawn'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const disputes = core.table(
  'disputes',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactionKeys.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull().default('live'),
    kind: text('kind').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** The scheme's or provider's reason code, as given. */
    reasonCode: text('reason_code').notNull(),
    status: text('status').notNull().default('open'),
    evidenceDueAt: timestamptz('evidence_due_at'),
    /** Items the merchant submitted: `{ at, text }`. Bounded by the service. */
    evidence: jsonb('evidence').$type<Array<{ at: string; text: string }>>().notNull().default([]),
    outcome: text('outcome'),
    /** The hold that protects the disputed amount. Null when nothing was available to hold. */
    holdId: uuid('hold_id').references(() => holds.id),
    holdMinor: bigint('hold_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Disputed amount that could not be held because the balance was too low. */
    shortfallMinor: bigint('shortfall_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** The ledger entry a lost dispute posted. */
    resolutionEntryRef: text('resolution_entry_ref'),
    resolutionNote: text('resolution_note'),
    internalNote: text('internal_note'),
    /** Phase 8: the investigator, and whether staff were told the evidence deadline is near or gone. */
    assignedTo: uuid('assigned_to').references(() => users.id),
    assignedAt: timestamptz('assigned_at'),
    dueSoonNotifiedAt: timestamptz('due_soon_notified_at'),
    overdueNotifiedAt: timestamptz('overdue_notified_at'),
    createdBy: text('created_by').notNull(),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('disputes_ref_key').on(t.ref),
    uniqueIndex('disputes_one_unresolved_key')
      .on(t.transactionId)
      .where(sql`${t.status} <> 'resolved'`),
    index('disputes_merchant_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('disputes_queue_idx').on(t.status, t.createdAt.desc()),
    index('disputes_due_idx')
      .on(t.evidenceDueAt)
      .where(sql`${t.status} = 'open' and ${t.evidenceDueAt} is not null`),
    index('disputes_deadline_idx')
      .on(t.evidenceDueAt)
      .where(sql`${t.status} <> 'resolved' and ${t.evidenceDueAt} is not null`),
    index('disputes_assignee_idx')
      .on(t.assignedTo, t.status)
      .where(sql`${t.assignedTo} is not null`),
    check('disputes_ref_check', sql`${t.ref} ~ '^dsp_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('disputes_environment_check', sql`${t.environment} = 'live'`),
    check('disputes_kind_check', sql`${t.kind} in (${list(DISPUTE_KINDS)})`),
    check('disputes_status_check', sql`${t.status} in (${list(DISPUTE_STATUSES)})`),
    check(
      'disputes_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${list(DISPUTE_OUTCOMES)})`
    ),
    check('disputes_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'disputes_hold_check',
      sql`${t.holdMinor} >= 0 and ${t.shortfallMinor} >= 0 and ${t.holdMinor} + ${t.shortfallMinor} = ${t.amountMinor}
        and ((${t.holdMinor} > 0) = (${t.holdId} is not null))`
    ),
    check('disputes_reason_check', sql`char_length(${t.reasonCode}) between 1 and 64`),
    check(
      'disputes_resolved_check',
      sql`(${t.status} = 'resolved') = (${t.outcome} is not null)
        and (${t.status} = 'resolved') = (${t.resolvedAt} is not null)
        and (${t.status} = 'resolved') = (${t.resolvedBy} is not null)`
    ),
    check(
      'disputes_entry_check',
      sql`${t.resolutionEntryRef} is null or ${t.outcome} = 'merchant_lost'`
    ),
  ]
);
