/** SQL for `core.merchant_limits` and `core.kyc_level_limits`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { kycLevelLimits, merchantLimits, merchants } from '../../../db/schema';

export type LimitsRow = typeof merchantLimits.$inferSelect;
export type LevelLimitsRow = typeof kycLevelLimits.$inferSelect;

export interface LimitValues {
  readonly perTxnMaxMinor: bigint;
  readonly dailyVolumeMaxMinor: bigint;
  readonly monthlyVolumeMaxMinor: bigint;
  readonly payoutPerTxnMaxMinor: bigint;
  readonly dailyPayoutMaxMinor: bigint;
}

@Injectable()
export class MerchantLimitsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async find(
    merchantId: string,
    currency: string,
    tx: Executor = this.db
  ): Promise<LimitsRow | undefined> {
    const [row] = await tx
      .select()
      .from(merchantLimits)
      .where(and(eq(merchantLimits.merchantId, merchantId), eq(merchantLimits.currency, currency)))
      .limit(1);
    return row;
  }

  listForMerchant(merchantId: string, tx: Executor = this.db): Promise<LimitsRow[]> {
    return tx.select().from(merchantLimits).where(eq(merchantLimits.merchantId, merchantId));
  }

  /** The limits of the merchant's current KYC level, used until it has its own row. */
  async levelFallback(
    merchantId: string,
    currency: string,
    tx: Executor = this.db
  ): Promise<LevelLimitsRow | undefined> {
    const [row] = await tx
      .select({ limits: kycLevelLimits })
      .from(merchants)
      .innerJoin(
        kycLevelLimits,
        and(
          eq(kycLevelLimits.level, merchants.kycLevel),
          eq(kycLevelLimits.currency, currency),
          eq(kycLevelLimits.appliesWhen, 'approved')
        )
      )
      .where(eq(merchants.id, merchantId))
      .limit(1);
    return row?.limits;
  }

  /**
   * Copies the limits of `level` into the merchant's rows, for every currency the level
   * defines. A row that staff set by hand (`source = 'manual'`) is left alone. Returns the
   * number of currencies written.
   */
  async applyLevel(
    tx: Executor,
    merchantId: string,
    level: number,
    appliesWhen: 'approved' | 'expired'
  ): Promise<number> {
    const result = await tx.execute(sql`
      insert into core.merchant_limits
        (merchant_id, currency, per_txn_max_minor, daily_volume_max_minor, monthly_volume_max_minor,
         payout_per_txn_max_minor, daily_payout_max_minor, source, kyc_level)
      select ${merchantId}::uuid, currency, per_txn_max_minor, daily_volume_max_minor,
             monthly_volume_max_minor, payout_per_txn_max_minor, daily_payout_max_minor, 'kyc', level
        from core.kyc_level_limits
       where level = ${level} and applies_when = ${appliesWhen}
      on conflict (merchant_id, currency) do update
        set per_txn_max_minor = excluded.per_txn_max_minor,
            daily_volume_max_minor = excluded.daily_volume_max_minor,
            monthly_volume_max_minor = excluded.monthly_volume_max_minor,
            payout_per_txn_max_minor = excluded.payout_per_txn_max_minor,
            daily_payout_max_minor = excluded.daily_payout_max_minor,
            kyc_level = excluded.kyc_level
        where core.merchant_limits.source = 'kyc'`);
    return result.rowCount ?? 0;
  }

  /**
   * Live payment volume counted against a limit since `since`: payments that are in flight or
   * succeeded. Used to (re)build the Redis counters, never as the check itself.
   */
  async liveVolumeSince(
    merchantId: string,
    currency: string,
    since: Date,
    tx: Executor = this.db
  ): Promise<bigint> {
    const result = await tx.execute<{ total: string }>(sql`
      select coalesce(sum(amount_minor), 0)::text as total
        from core.transactions
       where created_at >= ${since} and merchant_id = ${merchantId} and environment = 'live'
         and currency = ${currency} and type = 'payment'
         and status in ('created', 'requires_action', 'processing', 'succeeded')`);
    return BigInt(result.rows[0]?.total ?? '0');
  }
}
