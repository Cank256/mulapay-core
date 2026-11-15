/**
 * Merchants, team membership and invitations (spec section 5.2 and 6.10).
 *
 * `fee_plan_id` and `settlement_cycle_id` have no foreign key yet: their tables arrive in
 * Phase 4 and Phase 6, whose migrations add the constraints.
 */
import { sql } from 'drizzle-orm';
import { char, check, index, jsonb, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';

export const merchants = core.table(
  'merchants',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    legalName: text('legal_name').notNull(),
    tradingName: text('trading_name'),
    country: char('country', { length: 2 }).notNull(),
    defaultCurrency: char('default_currency', { length: 3 }).notNull(),
    status: text('status').notNull().default('draft'),
    kycLevel: smallint('kyc_level').notNull().default(0),
    riskRating: text('risk_rating'),
    feePlanId: uuid('fee_plan_id'),
    settlementCycleId: uuid('settlement_cycle_id'),
    mcc: char('mcc', { length: 4 }),
    website: text('website'),
    supportEmail: text('support_email'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('merchants_ref_key').on(t.ref),
    index('merchants_created_idx').on(t.createdAt.desc(), t.ref.desc()),
    index('merchants_status_created_idx').on(t.status, t.createdAt.desc(), t.ref.desc()),
    check(
      'merchants_status_check',
      sql`${t.status} in ('draft', 'pending_kyc', 'active', 'suspended', 'closed')`
    ),
    check('merchants_kyc_level_check', sql`${t.kycLevel} between 0 and 3`),
    check(
      'merchants_risk_rating_check',
      sql`${t.riskRating} is null or ${t.riskRating} in ('low', 'medium', 'high')`
    ),
    check('merchants_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('merchants_default_currency_check', sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    check('merchants_mcc_check', sql`${t.mcc} is null or ${t.mcc} ~ '^[0-9]{4}$'`),
  ]
);

export const merchantMembers = core.table(
  'merchant_members',
  {
    id: uuid('id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id),
    joinedAt: timestamptz('joined_at').notNull(),
    removedAt: timestamptz('removed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('merchant_members_merchant_user_key').on(t.merchantId, t.userId),
    index('merchant_members_user_idx').on(t.userId),
    // Exactly one active owner per merchant (spec 6.10: only the owner transfers ownership).
    uniqueIndex('merchant_members_one_owner_key')
      .on(t.merchantId)
      .where(sql`${t.role} = 'owner' and ${t.status} = 'active'`),
    check(
      'merchant_members_role_check',
      sql`${t.role} in ('owner', 'admin', 'developer', 'finance', 'support', 'viewer')`
    ),
    check('merchant_members_status_check', sql`${t.status} in ('active', 'removed')`),
    check(
      'merchant_members_removed_at_check',
      sql`(${t.status} = 'removed') = (${t.removedAt} is not null)`
    ),
  ]
);

export const invitations = core.table(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    email: citext('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invitations_ref_key').on(t.ref),
    uniqueIndex('invitations_token_hash_key').on(t.tokenHash),
    uniqueIndex('invitations_one_pending_key')
      .on(t.merchantId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index('invitations_merchant_created_idx').on(t.merchantId, t.createdAt.desc()),
    // `owner` invitations are created only for a merchant without an owner (admin-created
    // merchants); the one-owner index rejects a second owner at acceptance.
    check(
      'invitations_role_check',
      sql`${t.role} in ('owner', 'admin', 'developer', 'finance', 'support', 'viewer')`
    ),
    check(
      'invitations_single_outcome_check',
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`
    ),
  ]
);
