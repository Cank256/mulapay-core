/**
 * Fee plans and rules (spec section 5.2, Phase 4).
 *
 * Fee plans define pricing for merchants. Each plan contains rules that specify:
 * - Percentage fees (in basis points)
 * - Fixed fees (in minor units)
 * - Minimum and maximum fees
 * - Tiered pricing based on transaction volume
 *
 * A merchant's `fee_plan_id` references a plan here. If null, the default platform plan
 * is used. Fee calculation is idempotent: the same inputs always produce the same fee.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns';
import { core } from './core';
import { merchants } from './merchants';

export const feePlans = core.table(
  'fee_plans',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Null for platform-wide plans, set for merchant-specific plans. */
    merchantId: uuid('merchant_id').references(() => merchants.id),
    /** One default plan per merchant (or one global default if merchantId is null). */
    isDefault: boolean('is_default').notNull().default(false),
    /** Version tracks changes; a new version is a new plan to preserve fee history. */
    version: smallint('version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_plans_ref_key').on(t.ref),
    // One default plan per merchant (null merchantId = global default)
    uniqueIndex('fee_plans_merchant_default_key')
      .on(t.merchantId)
      .where(sql`${t.isDefault} = true`),
    index('fee_plans_merchant_idx').on(t.merchantId, t.active),
    check('fee_plans_ref_format_check', sql`${t.ref} ~ '^fp_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('fee_plans_name_check', sql`char_length(${t.name}) between 1 and 200`),
    check('fee_plans_version_check', sql`${t.version} > 0`),
  ]
);

export const feePlanRules = core.table(
  'fee_plan_rules',
  {
    id: uuid('id').primaryKey(),
    feePlanId: uuid('fee_plan_id')
      .notNull()
      .references(() => feePlans.id),
    /** Operation type: payment, payout, refund. */
    operationType: text('operation_type').notNull(),
    /** Provider filter (null = applies to all providers). */
    provider: text('provider'),
    /** Currency filter (null = applies to all currencies). */
    currency: text('currency'),
    /** Channel filter (null = applies to all channels). */
    channel: text('channel'),
    /** Percentage fee in basis points (10000 bps = 100%). */
    percentBps: smallint('percent_bps').notNull().default(0),
    /** Fixed fee in minor units. */
    fixedMinor: bigint('fixed_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Minimum fee in minor units (0 = no minimum). */
    minMinor: bigint('min_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Maximum fee in minor units (0 = no maximum). */
    maxMinor: bigint('max_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * Tier threshold in minor units (0 = applies to all amounts).
     * Rules are ordered by tier_from_minor ASC, and the first matching rule wins.
     * Example: tier_from_minor = 0 is the default tier, tier_from_minor = 1000000 is for
     * amounts >= 1000000.
     */
    tierFromMinor: bigint('tier_from_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Display order for rules with same filters. */
    priority: smallint('priority').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('fee_plan_rules_plan_idx').on(t.feePlanId, t.operationType, t.active),
    index('fee_plan_rules_lookup_idx').on(
      t.feePlanId,
      t.operationType,
      t.currency,
      t.provider,
      t.channel,
      t.tierFromMinor
    ),
    check(
      'fee_plan_rules_operation_type_check',
      sql`${t.operationType} in ('payment', 'payout', 'refund')`
    ),
    check(
      'fee_plan_rules_provider_check',
      sql`${t.provider} is null or ${t.provider} in ('mtn', 'airtel', 'flutterwave')`
    ),
    check('fee_plan_rules_currency_check', sql`${t.currency} is null or ${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'fee_plan_rules_channel_check',
      sql`${t.channel} is null or ${t.channel} in ('mobile_money', 'card', 'bank')`
    ),
    check('fee_plan_rules_percent_bps_check', sql`${t.percentBps} >= 0 and ${t.percentBps} <= 10000`),
    check('fee_plan_rules_fixed_minor_check', sql`${t.fixedMinor} >= 0`),
    check('fee_plan_rules_min_minor_check', sql`${t.minMinor} >= 0`),
    check(
      'fee_plan_rules_max_minor_check',
      sql`${t.maxMinor} >= 0 and (${t.maxMinor} = 0 or ${t.maxMinor} >= ${t.minMinor})`
    ),
    check('fee_plan_rules_tier_from_minor_check', sql`${t.tierFromMinor} >= 0`),
    check('fee_plan_rules_priority_check', sql`${t.priority} >= 0`),
  ]
);
