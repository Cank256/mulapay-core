/**
 * Operations (spec 5.2, 6.14, 11, Phase 8): the approvals workflow, feature flags, routing
 * rules, provider status, consumer cursors, maintenance mode and the signal state the
 * automatic incident monitors keep.
 *
 * `routing_rules` and `provider_status` are configuration that Phase 4's routing service will
 * read; nothing consults them for a payment yet. `consumer_cursors` is created here so the
 * operations surface can show and rewind it; the Phase 3 consumer will be its only writer
 * besides an approved rewind.
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
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';

export const APPROVAL_KINDS = [
  'consumer_cursor.rewind',
  'feature_flag.change',
  'provider.disable',
  'routing_rule.remove',
] as const;
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A request for a sensitive operational change (spec 11, maker-checker). The request carries
 * what will be done; approving it performs it, in the same transaction as the decision.
 */
export const approvals = core.table(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** Exactly what approval will apply. Validated by the kind's executor before insert. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamptz('requested_at').notNull(),
    requiredApprovals: smallint('required_approvals').notNull().default(1),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    executedAt: timestamptz('executed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('approvals_ref_key').on(t.ref),
    index('approvals_inbox_idx').on(t.status, t.requestedAt.desc()),
    // One pending request per subject and kind: a second click is the same request.
    uniqueIndex('approvals_one_pending_key')
      .on(t.kind, t.resourceType, t.resourceId)
      .where(sql`${t.status} = 'pending'`),
    check('approvals_ref_check', sql`${t.ref} ~ '^apr_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('approvals_kind_check', sql`${t.kind} in (${list(APPROVAL_KINDS)})`),
    check('approvals_status_check', sql`${t.status} in (${list(APPROVAL_STATUSES)})`),
    check('approvals_required_check', sql`${t.requiredApprovals} between 1 and 5`),
    check('approvals_reason_check', sql`char_length(${t.reason}) between 1 and 1000`),
    check(
      'approvals_decided_check',
      sql`(${t.status} in ('approved', 'rejected')) = (${t.decidedAt} is not null)`
    ),
    check('approvals_executed_check', sql`${t.executedAt} is null or ${t.status} = 'approved'`),
  ]
);

/** One decision per approver. Append-only. */
export const approvalDecisions = core.table(
  'approval_decisions',
  {
    id: uuid('id').primaryKey(),
    approvalId: uuid('approval_id')
      .notNull()
      .references(() => approvals.id),
    approverId: uuid('approver_id')
      .notNull()
      .references(() => users.id),
    decision: text('decision').notNull(),
    note: text('note'),
    decidedAt: timestamptz('decided_at').notNull(),
  },
  (t) => [
    uniqueIndex('approval_decisions_key').on(t.approvalId, t.approverId),
    check('approval_decisions_decision_check', sql`${t.decision} in ('approve', 'reject')`),
  ]
);

export const featureFlags = core.table(
  'feature_flags',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    rolloutPercent: smallint('rollout_percent').notNull().default(100),
    merchantAllowlist: uuid('merchant_allowlist')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('feature_flags_key_key').on(t.key),
    check('feature_flags_key_check', sql`${t.key} ~ '^[a-z][a-z0-9_.]{2,60}$'`),
    check('feature_flags_rollout_check', sql`${t.rolloutPercent} between 0 and 100`),
    check('feature_flags_allowlist_check', sql`cardinality(${t.merchantAllowlist}) <= 500`),
  ]
);

export const routingRules = core.table(
  'routing_rules',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    /** Lower is evaluated first (spec 6.2). */
    priority: integer('priority').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** `*` matches any. */
    country: text('country').notNull().default('*'),
    channel: text('channel').notNull().default('*'),
    minAmountMinor: bigint('min_amount_minor', { mode: 'bigint' }),
    maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' }),
    msisdnPrefix: text('msisdn_prefix'),
    provider: text('provider').notNull(),
    /** Rules of equal priority share traffic in proportion to their weight. */
    weight: integer('weight').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('routing_rules_ref_key').on(t.ref),
    index('routing_rules_lookup_idx')
      .on(t.currency, t.priority)
      .where(sql`${t.enabled}`),
    check('routing_rules_ref_check', sql`${t.ref} ~ '^rrl_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('routing_rules_provider_check', sql`${t.provider} in ('mtn', 'airtel', 'flutterwave')`),
    check('routing_rules_priority_check', sql`${t.priority} between 0 and 10000`),
    check('routing_rules_weight_check', sql`${t.weight} between 1 and 1000`),
    check('routing_rules_country_check', sql`${t.country} = '*' or ${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'routing_rules_channel_check',
      sql`${t.channel} in ('*', 'mobile_money', 'card', 'bank')`
    ),
    check(
      'routing_rules_amount_check',
      sql`(${t.minAmountMinor} is null or ${t.minAmountMinor} >= 0)
        and (${t.maxAmountMinor} is null or ${t.maxAmountMinor} > 0)
        and (${t.minAmountMinor} is null or ${t.maxAmountMinor} is null or ${t.minAmountMinor} <= ${t.maxAmountMinor})`
    ),
    check(
      'routing_rules_msisdn_check',
      sql`${t.msisdnPrefix} is null or ${t.msisdnPrefix} ~ '^\\+[0-9]{1,8}$'`
    ),
  ]
);

export const providerStatus = core.table(
  'provider_status',
  {
    provider: text('provider').primaryKey(),
    enabled: boolean('enabled').notNull().default(true),
    health: text('health').notNull().default('healthy'),
    note: text('note'),
    successRate5m: numeric('success_rate_5m', { precision: 5, scale: 4 }),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('provider_status_provider_check', sql`${t.provider} in ('mtn', 'airtel', 'flutterwave')`),
    check('provider_status_health_check', sql`${t.health} in ('healthy', 'degraded', 'down')`),
    check('provider_status_note_check', sql`${t.note} is null or char_length(${t.note}) <= 500`),
  ]
);

/** Where the gateway event consumer has got to (spec 5.2, 8.7). */
export const consumerCursors = core.table(
  'consumer_cursors',
  {
    name: text('name').primaryKey(),
    position: bigint('position', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    holder: text('holder'),
    heartbeatAt: timestamptz('heartbeat_at'),
    updatedAt: updatedAt(),
  },
  (t) => [check('consumer_cursors_position_check', sql`${t.position} >= 0`)]
);

/** The single maintenance-mode row (spec 6.14). */
export const maintenanceState = core.table(
  'maintenance_state',
  {
    id: boolean('id').primaryKey().default(true),
    enabled: boolean('enabled').notNull().default(false),
    message: text('message'),
    retryAfterSeconds: integer('retry_after_seconds').notNull().default(60),
    changedBy: uuid('changed_by').references(() => users.id),
    changedAt: timestamptz('changed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('maintenance_state_singleton_check', sql`${t.id}`),
    check('maintenance_state_retry_check', sql`${t.retryAfterSeconds} between 1 and 86400`),
  ]
);

/**
 * What the automatic incident monitors last saw per signal. `active_since` is when the
 * condition was first observed in the current streak: a signal opens an incident only once it
 * has lasted its threshold (spec 10: "non-zero for over 1 hour", "above 0 for 15 minutes").
 */
export const opsSignals = core.table('ops_signals', {
  signalKey: text('signal_key').primaryKey(),
  activeSince: timestamptz('active_since'),
  lastObservedAt: timestamptz('last_observed_at').notNull(),
  lastValue: jsonb('last_value').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});
