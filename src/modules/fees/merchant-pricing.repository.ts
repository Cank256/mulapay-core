/**
 * Repository for merchant fee plans and pricing rules (Phase 4).
 *
 * Loads fee plans and rules from the database. Fee plans are cached in-memory
 * (future optimization) and rules are matched by specificity, priority, and tier.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/connection';
import { DB_CORE_RO } from '../../db/db.provider';
import { feePlanRules, feePlans } from '../../db/schema';
import type { Logger } from '../../common/logging/logger.types';
import { ROOT_LOGGER } from '../../common/logging/logger.provider';

export interface FeePlan {
  id: string;
  ref: string;
  name: string;
  description: string | null;
  merchantId: string | null;
  isDefault: boolean;
  version: number;
  active: boolean;
}

export interface FeePlanRule {
  id: string;
  feePlanId: string;
  operationType: 'payment' | 'payout' | 'refund';
  provider: string | null;
  currency: string | null;
  channel: string | null;
  percentBps: number;
  fixedMinor: bigint;
  minMinor: bigint;
  maxMinor: bigint;
  tierFromMinor: bigint;
  priority: number;
  active: boolean;
}

export interface RuleMatchCriteria {
  feePlanId: string;
  operationType: 'payment' | 'payout' | 'refund';
  currency: string;
  provider: string | null;
  channel: string | null;
  amountMinor: bigint;
}

/**
 * Repository for fee plans and pricing rules.
 *
 * Rules are matched by:
 * 1. Specificity (exact matches preferred over wildcards)
 * 2. Tier (amount >= tier_from_minor, highest matching tier wins)
 * 3. Priority (higher priority = applied first)
 *
 * Example: A rule for (provider=mtn, currency=UGX, tier=1000000) beats a rule for
 * (provider=null, currency=UGX, tier=0) when amount >= 1000000 and provider=mtn.
 */
@Injectable()
export class MerchantPricingRepository {
  constructor(
    @Inject(DB_CORE_RO) private readonly db: Database,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Get merchant's active fee plan, or the default platform plan if merchant has none.
   *
   * Returns null only if neither merchant plan nor default plan exists (should never
   * happen in production after seed data).
   */
  async getMerchantFeePlan(merchantId: string): Promise<FeePlan | null> {
    // Try merchant-specific plan first
    const merchantPlan = await this.db
      .select()
      .from(feePlans)
      .where(and(eq(feePlans.merchantId, merchantId), eq(feePlans.active, true)))
      .limit(1);

    if (merchantPlan.length > 0) {
      return this.mapFeePlan(merchantPlan[0]!);
    }

    // Fall back to default platform plan
    const defaultPlan = await this.db
      .select()
      .from(feePlans)
      .where(and(isNull(feePlans.merchantId), eq(feePlans.isDefault, true), eq(feePlans.active, true)))
      .limit(1);

    if (defaultPlan.length > 0) {
      return this.mapFeePlan(defaultPlan[0]!);
    }

    return null;
  }

  /**
   * Find the best matching fee rule for a transaction.
   *
   * Matching logic:
   * 1. Filter by operation_type (required match)
   * 2. Filter by tier: amount >= tier_from_minor
   * 3. Match filters (provider, currency, channel): null = wildcard
   * 4. Order by specificity (most specific first), then priority DESC, then tier DESC
   * 5. Return first match
   *
   * Specificity scoring:
   * - Exact provider match = +4
   * - Exact currency match = +2
   * - Exact channel match = +1
   * - Higher tier = +0 (handled by separate ordering)
   *
   * Returns null if no rule matches.
   */
  async findMatchingRule(criteria: RuleMatchCriteria): Promise<FeePlanRule | null> {
    const rows = await this.db
      .select()
      .from(feePlanRules)
      .where(
        and(
          eq(feePlanRules.feePlanId, criteria.feePlanId),
          eq(feePlanRules.operationType, criteria.operationType),
          eq(feePlanRules.active, true),
          // Amount must be >= tier threshold
          lte(feePlanRules.tierFromMinor, criteria.amountMinor.toString()),
          // Provider: exact match or null (wildcard)
          or(
            isNull(feePlanRules.provider),
            criteria.provider ? eq(feePlanRules.provider, criteria.provider) : sql`false`
          ),
          // Currency: exact match or null (wildcard)
          or(isNull(feePlanRules.currency), eq(feePlanRules.currency, criteria.currency)),
          // Channel: exact match or null (wildcard)
          or(
            isNull(feePlanRules.channel),
            criteria.channel ? eq(feePlanRules.channel, criteria.channel) : sql`true`
          )
        )
      )
      // Order by: specificity (computed), priority DESC, tier DESC
      .orderBy(
        // Specificity: count non-null filters (higher = more specific)
        desc(
          sql`(case when ${feePlanRules.provider} is not null then 4 else 0 end +
               case when ${feePlanRules.currency} is not null then 2 else 0 end +
               case when ${feePlanRules.channel} is not null then 1 else 0 end)`
        ),
        desc(feePlanRules.priority),
        desc(feePlanRules.tierFromMinor),
        asc(feePlanRules.id) // stable tie-breaker
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.mapFeePlanRule(rows[0]!);
  }

  /**
   * Get all active rules for a fee plan (for admin/reporting).
   */
  async getRulesForPlan(feePlanId: string): Promise<FeePlanRule[]> {
    const rows = await this.db
      .select()
      .from(feePlanRules)
      .where(and(eq(feePlanRules.feePlanId, feePlanId), eq(feePlanRules.active, true)))
      .orderBy(
        desc(feePlanRules.priority),
        asc(feePlanRules.operationType),
        desc(feePlanRules.tierFromMinor)
      );

    return rows.map((row) => this.mapFeePlanRule(row));
  }

  private mapFeePlan(row: typeof feePlans.$inferSelect): FeePlan {
    return {
      id: row.id,
      ref: row.ref,
      name: row.name,
      description: row.description,
      merchantId: row.merchantId,
      isDefault: row.isDefault,
      version: row.version,
      active: row.active,
    };
  }

  private mapFeePlanRule(row: typeof feePlanRules.$inferSelect): FeePlanRule {
    return {
      id: row.id,
      feePlanId: row.feePlanId,
      operationType: row.operationType as 'payment' | 'payout' | 'refund',
      provider: row.provider,
      currency: row.currency,
      channel: row.channel,
      percentBps: row.percentBps,
      fixedMinor: BigInt(row.fixedMinor),
      minMinor: BigInt(row.minMinor),
      maxMinor: BigInt(row.maxMinor),
      tierFromMinor: BigInt(row.tierFromMinor),
      priority: row.priority,
      active: row.active,
    };
  }
}
