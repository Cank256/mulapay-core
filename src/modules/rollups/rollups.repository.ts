/** SQL for `core.daily_merchant_rollups`: the aggregation and the dashboard reads. */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_REPLICA, DB_RW } from '../../common/db/tokens';

/** A transaction that completes on day D was created at most this long before D (partition prune). */
const CREATED_LOOKBACK_DAYS = 35;

export interface RollupSeriesRow {
  readonly day: string;
  readonly currency: string;
  readonly paymentCount: number;
  readonly paymentMinor: bigint;
  readonly refundCount: number;
  readonly refundMinor: bigint;
  readonly payoutCount: number;
  readonly payoutMinor: bigint;
  readonly feeMinor: bigint;
  readonly successCount: number;
  readonly failureCount: number;
}

export interface RollupChannelRow {
  readonly channel: string;
  readonly provider: string;
  readonly currency: string;
  readonly paymentCount: number;
  readonly paymentMinor: bigint;
  readonly successCount: number;
  readonly failureCount: number;
}

@Injectable()
export class RollupsRepository {
  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(DB_REPLICA) private readonly replica: Executor
  ) {}

  /**
   * Recomputes one UTC day of rollups from the transactions that reached a final state that
   * day. Replaces the day's rows for every merchant slice that has transactions, so running it
   * again gives the same numbers (idempotent). A day is the UTC date of `completed_at`.
   *
   * A payment counts once: succeeded payments are the volume and the successes, failed, expired
   * and cancelled payments the failures. Refunds and payouts count and sum when they succeed.
   * The fee is the fee charged on succeeded payments.
   */
  async recomputeDay(day: string): Promise<number> {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const createdFrom = new Date(start.getTime() - CREATED_LOOKBACK_DAYS * 86_400_000);
    const result = await this.db.execute(sql`
      insert into core.daily_merchant_rollups
        (merchant_id, environment, date, currency, channel, provider, payment_count, payment_minor,
         refund_count, refund_minor, payout_count, payout_minor, fee_minor, success_count, failure_count, computed_at)
      select t.merchant_id, t.environment, ${day}::date, t.currency, t.channel, coalesce(t.provider, 'none'),
             count(*) filter (where t.type = 'payment' and t.status = 'succeeded'),
             coalesce(sum(t.amount_minor) filter (where t.type = 'payment' and t.status = 'succeeded'), 0),
             count(*) filter (where t.type = 'refund' and t.status = 'succeeded'),
             coalesce(sum(t.amount_minor) filter (where t.type = 'refund' and t.status = 'succeeded'), 0),
             count(*) filter (where t.type = 'payout' and t.status = 'succeeded'),
             coalesce(sum(t.amount_minor) filter (where t.type = 'payout' and t.status = 'succeeded'), 0),
             coalesce(sum(t.fee_minor) filter (where t.type = 'payment' and t.status = 'succeeded'), 0),
             count(*) filter (where t.type = 'payment' and t.status = 'succeeded'),
             count(*) filter (where t.type = 'payment' and t.status in ('failed', 'expired', 'cancelled')),
             now()
        from core.transactions t
       where t.created_at >= ${createdFrom} and t.created_at < ${end}
         and t.status in ('succeeded', 'failed', 'expired', 'cancelled')
         and coalesce(t.completed_at, t.updated_at) >= ${start}
         and coalesce(t.completed_at, t.updated_at) < ${end}
       group by t.merchant_id, t.environment, t.currency, t.channel, coalesce(t.provider, 'none')
      on conflict (merchant_id, environment, date, currency, channel, provider) do update set
        payment_count = excluded.payment_count, payment_minor = excluded.payment_minor,
        refund_count = excluded.refund_count, refund_minor = excluded.refund_minor,
        payout_count = excluded.payout_count, payout_minor = excluded.payout_minor,
        fee_minor = excluded.fee_minor, success_count = excluded.success_count,
        failure_count = excluded.failure_count, computed_at = excluded.computed_at`);
    return result.rowCount ?? 0;
  }

  /** Daily rows per currency for a merchant, from the rollups only. */
  async series(input: {
    merchantId: string;
    environment: string;
    from: string;
    to: string;
    currency?: string;
  }): Promise<RollupSeriesRow[]> {
    const result = await this.replica.execute<Record<string, string>>(sql`
      select date::text as day, currency,
             sum(payment_count)::text as payment_count, sum(payment_minor)::text as payment_minor,
             sum(refund_count)::text as refund_count, sum(refund_minor)::text as refund_minor,
             sum(payout_count)::text as payout_count, sum(payout_minor)::text as payout_minor,
             sum(fee_minor)::text as fee_minor, sum(success_count)::text as success_count,
             sum(failure_count)::text as failure_count
        from core.daily_merchant_rollups
       where merchant_id = ${input.merchantId} and environment = ${input.environment}
         and date >= ${input.from}::date and date <= ${input.to}::date
         and (${input.currency ?? null}::text is null or currency = ${input.currency ?? null})
       group by date, currency
       order by date, currency`);
    return result.rows.map((r) => ({
      day: r.day ?? '',
      currency: r.currency ?? '',
      paymentCount: Number(r.payment_count),
      paymentMinor: BigInt(r.payment_minor ?? '0'),
      refundCount: Number(r.refund_count),
      refundMinor: BigInt(r.refund_minor ?? '0'),
      payoutCount: Number(r.payout_count),
      payoutMinor: BigInt(r.payout_minor ?? '0'),
      feeMinor: BigInt(r.fee_minor ?? '0'),
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
    }));
  }

  async channels(input: {
    merchantId: string;
    environment: string;
    from: string;
    to: string;
    currency?: string;
  }): Promise<RollupChannelRow[]> {
    const result = await this.replica.execute<Record<string, string>>(sql`
      select channel, provider, currency, sum(payment_count)::text as payment_count,
             sum(payment_minor)::text as payment_minor, sum(success_count)::text as success_count,
             sum(failure_count)::text as failure_count
        from core.daily_merchant_rollups
       where merchant_id = ${input.merchantId} and environment = ${input.environment}
         and date >= ${input.from}::date and date <= ${input.to}::date
         and (${input.currency ?? null}::text is null or currency = ${input.currency ?? null})
       group by channel, provider, currency
       order by currency, channel, provider`);
    return result.rows.map((r) => ({
      channel: r.channel ?? '',
      provider: r.provider ?? '',
      currency: r.currency ?? '',
      paymentCount: Number(r.payment_count),
      paymentMinor: BigInt(r.payment_minor ?? '0'),
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
    }));
  }
}
