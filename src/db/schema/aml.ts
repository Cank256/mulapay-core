/**
 * AML (spec 5.2, 6.13): screening, monitoring rules, alerts, cases, the blocklist and the
 * merchant block.
 *
 * Nothing here is financial truth. A rule, an alert or a case decides whether to look at
 * money or to stop a payout; it never changes a ledger entry. The one thing that touches
 * balances is a hold, placed through `HoldsService`, and a block never reverses a completed
 * transaction.
 *
 * Database rules added by migration 0007 (the domain checks them first): a confirmed
 * screening is final, a closed alert or case is final, rule versions, case notes and STR
 * packages are append-only, and a merchant has at most one active block.
 *
 * Deviations from spec 5.2, listed in docs/ARCHITECTURE.md ("Phase 7 decisions to confirm"):
 * `aml_screenings.subject_type` also allows `ubo`; a case holds its alerts through
 * `aml_alerts.case_id` rather than an `alert_ids` array, so a foreign key keeps an alert in
 * at most one case; rule `params` hold the window and the currency; rules have effective
 * dates and a version history.
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
  numeric,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { holds } from './holds';
import { users } from './identity';
import { currencies } from './ledger';
import { merchants } from './merchants';
import { kycProfiles } from './kyc';

export const AML_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const AML_ALERT_STATUSES = [
  'open',
  'investigating',
  'escalated',
  'closed_false_positive',
  'closed_confirmed',
] as const;
export const AML_RULE_TYPES = [
  'velocity',
  'amount_threshold',
  'structuring',
  'geography',
  'new_account',
  'round_amount',
  'counterparty_reuse',
] as const;
export const AML_RULE_ACTIONS = ['flag', 'hold', 'block'] as const;
export const AML_CASE_OUTCOMES = [
  'no_action',
  'false_positive',
  'suspicious_activity_reported',
  'merchant_blocked',
  'merchant_offboarded',
] as const;
export const AML_BLOCKLIST_TYPES = ['msisdn', 'email', 'account', 'bin', 'device', 'name'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const amlCases = core.table(
  'aml_cases',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    status: text('status').notNull().default('open'),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    /** What opened it: a confirmed screening match, an alert, or an analyst. */
    source: text('source').notNull(),
    /** Null when the system opened it. */
    openedBy: uuid('opened_by').references(() => users.id),
    assignedTo: uuid('assigned_to').references(() => users.id),
    outcome: text('outcome'),
    closedBy: uuid('closed_by').references(() => users.id),
    closedAt: timestamptz('closed_at'),
    strFiledAt: timestamptz('str_filed_at'),
    strReference: text('str_reference'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('aml_cases_ref_key').on(t.ref),
    index('aml_cases_merchant_idx').on(t.merchantId, t.createdAt.desc()),
    index('aml_cases_open_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.status} <> 'closed'`),
    check('aml_cases_ref_check', sql`${t.ref} ~ '^case_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('aml_cases_status_check', sql`${t.status} in ('open', 'investigating', 'closed')`),
    check('aml_cases_severity_check', sql`${t.severity} in (${list(AML_SEVERITIES)})`),
    check('aml_cases_source_check', sql`${t.source} in ('screening', 'alert', 'manual')`),
    check(
      'aml_cases_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${list(AML_CASE_OUTCOMES)})`
    ),
    check(
      'aml_cases_closed_check',
      sql`(${t.status} = 'closed') = (${t.outcome} is not null)
        and (${t.status} = 'closed') = (${t.closedAt} is not null)
        and (${t.status} = 'closed') = (${t.closedBy} is not null)`
    ),
    check('aml_cases_str_check', sql`(${t.strFiledAt} is null) = (${t.strReference} is null)`),
  ]
);

export const amlScreenings = core.table(
  'aml_screenings',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    subjectType: text('subject_type').notNull(),
    /** A merchant ref or a KYC party ref. The name screened is never stored here. */
    subjectId: text('subject_id').notNull(),
    /** One screening per subject per submission: a retried job is the same row. */
    dedupeKey: text('dedupe_key').notNull(),
    kycProfileId: uuid('kyc_profile_id').references(() => kycProfiles.id),
    submissionNo: integer('submission_no'),
    provider: text('provider').notNull(),
    lists: text('lists')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    hitCount: integer('hit_count').notNull().default(0),
    highestScore: numeric('highest_score', { precision: 4, scale: 3, mode: 'number' }),
    /** The hits as the provider reported them: ids, captions, scores, datasets. */
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull(),
    screenedAt: timestamptz('screened_at').notNull(),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamptz('reviewed_at'),
    reviewNote: text('review_note'),
    caseId: uuid('case_id').references(() => amlCases.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('aml_screenings_ref_key').on(t.ref),
    uniqueIndex('aml_screenings_dedupe_key').on(t.dedupeKey),
    index('aml_screenings_subject_idx').on(t.subjectType, t.subjectId, t.screenedAt.desc()),
    index('aml_screenings_merchant_idx').on(t.merchantId, t.screenedAt.desc()),
    index('aml_screenings_open_idx')
      .on(t.screenedAt)
      .where(sql`${t.status} = 'potential_match'`),
    check('aml_screenings_ref_check', sql`${t.ref} ~ '^scr_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check(
      'aml_screenings_subject_type_check',
      sql`${t.subjectType} in ('merchant', 'director', 'ubo', 'customer', 'counterparty')`
    ),
    check(
      'aml_screenings_status_check',
      sql`${t.status} in ('clear', 'potential_match', 'confirmed_match')`
    ),
    check(
      'aml_screenings_review_check',
      sql`(${t.reviewedBy} is null) = (${t.reviewedAt} is null)`
    ),
  ]
);

export const amlRules = core.table(
  'aml_rules',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ruleType: text('rule_type').notNull(),
    /** Validated per type by the domain (`domain/rule-params.ts`): currency, window, thresholds. */
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    severity: text('severity').notNull(),
    action: text('action').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    version: integer('version').notNull().default(1),
    effectiveFrom: timestamptz('effective_from').notNull(),
    effectiveTo: timestamptz('effective_to'),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('aml_rules_code_key').on(t.code),
    index('aml_rules_active_idx')
      .on(t.ruleType)
      .where(sql`${t.enabled}`),
    check('aml_rules_code_check', sql`${t.code} ~ '^[a-z][a-z0-9_.-]{2,63}$'`),
    check('aml_rules_type_check', sql`${t.ruleType} in (${list(AML_RULE_TYPES)})`),
    check('aml_rules_severity_check', sql`${t.severity} in (${list(AML_SEVERITIES)})`),
    check('aml_rules_action_check', sql`${t.action} in (${list(AML_RULE_ACTIONS)})`),
    check(
      'aml_rules_effective_check',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`
    ),
  ]
);

/** Append-only: the rule as it was at each version, who changed it and why. */
export const amlRuleVersions = core.table(
  'aml_rule_versions',
  {
    id: uuid('id').primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => amlRules.id),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    changedBy: uuid('changed_by').references(() => users.id),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('aml_rule_versions_key').on(t.ruleId, t.version)]
);

/**
 * What monitoring knows about each terminal transaction: the facts the rules aggregate over,
 * one row per transaction. It is also the idempotency marker of the monitoring job.
 */
export const amlTransactionFacts = core.table(
  'aml_transaction_facts',
  {
    transactionId: uuid('transaction_id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    status: text('status').notNull(),
    channel: text('channel').notNull(),
    /** Keyed hash of the payer's phone number; null when the payment had none. */
    counterpartyHmac: text('counterparty_hmac'),
    completedAt: timestamptz('completed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('aml_facts_merchant_idx').on(t.merchantId, t.currency, t.completedAt.desc()),
    index('aml_facts_counterparty_idx')
      .on(t.counterpartyHmac, t.completedAt.desc())
      .where(sql`${t.counterpartyHmac} is not null`),
    check('aml_facts_amount_check', sql`${t.amountMinor} > 0`),
  ]
);

export const amlAlerts = core.table(
  'aml_alerts',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    ruleCode: text('rule_code').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    severity: text('severity').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** `transactions` is partitioned, so this is not a foreign key. */
    transactionId: uuid('transaction_id'),
    customerId: uuid('customer_id'),
    score: integer('score').notNull().default(0),
    status: text('status').notNull().default('open'),
    /** What fired: counts, sums, the threshold. No personal data. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    action: text('action').notNull(),
    assignedTo: uuid('assigned_to').references(() => users.id),
    dueAt: timestamptz('due_at').notNull(),
    escalatedAt: timestamptz('escalated_at'),
    escalationReason: text('escalation_reason'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamptz('resolved_at'),
    resolutionNote: text('resolution_note'),
    holdId: uuid('hold_id').references(() => holds.id),
    caseId: uuid('case_id').references(() => amlCases.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('aml_alerts_ref_key').on(t.ref),
    // One alert per rule and transaction: a re-run of the monitoring job adds nothing.
    uniqueIndex('aml_alerts_rule_transaction_key')
      .on(t.ruleCode, t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    index('aml_alerts_queue_idx').on(t.status, t.dueAt),
    index('aml_alerts_merchant_idx').on(t.merchantId, t.createdAt.desc()),
    index('aml_alerts_case_idx')
      .on(t.caseId)
      .where(sql`${t.caseId} is not null`),
    index('aml_alerts_sla_idx')
      .on(t.dueAt)
      .where(sql`${t.status} in ('open', 'investigating')`),
    check('aml_alerts_ref_check', sql`${t.ref} ~ '^alrt_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('aml_alerts_severity_check', sql`${t.severity} in (${list(AML_SEVERITIES)})`),
    check('aml_alerts_status_check', sql`${t.status} in (${list(AML_ALERT_STATUSES)})`),
    check('aml_alerts_action_check', sql`${t.action} in (${list(AML_RULE_ACTIONS)})`),
    check('aml_alerts_score_check', sql`${t.score} between 0 and 100`),
    check(
      'aml_alerts_resolved_check',
      sql`(${t.status} in ('closed_false_positive', 'closed_confirmed')) = (${t.resolvedAt} is not null)
        and (${t.status} in ('closed_false_positive', 'closed_confirmed')) = (${t.resolvedBy} is not null)`
    ),
    check(
      'aml_alerts_escalated_check',
      sql`(${t.escalatedAt} is null) = (${t.escalationReason} is null)`
    ),
  ]
);

/** Append-only investigation notes. */
export const amlCaseNotes = core.table(
  'aml_case_notes',
  {
    id: uuid('id').primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => amlCases.id),
    authorId: uuid('author_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('aml_case_notes_case_idx').on(t.caseId, t.createdAt),
    check('aml_case_notes_body_check', sql`char_length(${t.body}) between 1 and 5000`),
  ]
);

/** Append-only: each generated STR package, the file it was stored as and its hash. */
export const amlStrPackages = core.table(
  'aml_str_packages',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => amlCases.id),
    fileKey: text('file_key').notNull(),
    fileHash: char('file_hash', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    alertCount: integer('alert_count').notNull(),
    generatedBy: uuid('generated_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('aml_str_packages_ref_key').on(t.ref),
    uniqueIndex('aml_str_packages_file_key').on(t.fileKey),
    index('aml_str_packages_case_idx').on(t.caseId, t.createdAt.desc()),
    check('aml_str_packages_ref_check', sql`${t.ref} ~ '^str_[0-9A-HJKMNP-TV-Z]{26}$'`),
  ]
);

/** Only keyed hashes are stored, so the list cannot be read back as a list of phone numbers. */
export const amlBlocklist = core.table(
  'aml_blocklist',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    entryType: text('entry_type').notNull(),
    valueHmac: text('value_hmac').notNull(),
    /** The last four characters, so staff can recognise an entry. Never more. */
    valueHint: text('value_hint').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull().default('manual'),
    addedBy: uuid('added_by').references(() => users.id),
    expiresAt: timestamptz('expires_at'),
    removedAt: timestamptz('removed_at'),
    removedBy: uuid('removed_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('aml_blocklist_ref_key').on(t.ref),
    uniqueIndex('aml_blocklist_active_key')
      .on(t.entryType, t.valueHmac)
      .where(sql`${t.removedAt} is null`),
    index('aml_blocklist_active_idx')
      .on(t.entryType)
      .where(sql`${t.removedAt} is null`),
    check('aml_blocklist_ref_check', sql`${t.ref} ~ '^bl_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('aml_blocklist_type_check', sql`${t.entryType} in (${list(AML_BLOCKLIST_TYPES)})`),
    check('aml_blocklist_hmac_check', sql`${t.valueHmac} ~ '^[0-9a-f]{64}$'`),
    check('aml_blocklist_removed_check', sql`(${t.removedAt} is null) = (${t.removedBy} is null)`),
  ]
);

/**
 * A block on a merchant (spec 6.13): holds on its balances and no further payouts. At most
 * one is active per merchant. It never reverses or alters a transaction.
 */
export const amlBlocks = core.table(
  'aml_blocks',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    status: text('status').notNull().default('active'),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    alertId: uuid('alert_id').references(() => amlAlerts.id),
    caseId: uuid('case_id').references(() => amlCases.id),
    /** `user:{ref}` or `system:aml`. */
    createdBy: text('created_by').notNull(),
    liftedAt: timestamptz('lifted_at'),
    liftedBy: uuid('lifted_by').references(() => users.id),
    liftNote: text('lift_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('aml_blocks_ref_key').on(t.ref),
    uniqueIndex('aml_blocks_one_active_key')
      .on(t.merchantId)
      .where(sql`${t.status} = 'active'`),
    index('aml_blocks_merchant_idx').on(t.merchantId, t.createdAt.desc()),
    check('aml_blocks_ref_check', sql`${t.ref} ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('aml_blocks_status_check', sql`${t.status} in ('active', 'lifted')`),
    check('aml_blocks_source_check', sql`${t.source} in ('rule', 'case', 'manual')`),
    check(
      'aml_blocks_lifted_check',
      sql`(${t.status} = 'lifted') = (${t.liftedAt} is not null)
        and (${t.status} = 'lifted') = (${t.liftedBy} is not null)`
    ),
  ]
);

/** The holds a block placed, one per currency with a balance to hold. */
export const amlBlockHolds = core.table(
  'aml_block_holds',
  {
    blockId: uuid('block_id')
      .notNull()
      .references(() => amlBlocks.id),
    holdId: uuid('hold_id')
      .notNull()
      .references(() => holds.id),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('aml_block_holds_hold_key').on(t.holdId),
    index('aml_block_holds_block_idx').on(t.blockId),
  ]
);
