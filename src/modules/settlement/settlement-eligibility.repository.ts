/**
 * Read queries behind the payable calculation (spec 6.9): who is eligible, what they earned
 * in a period, and what is held. Transaction reads carry a `created_at` bound so Postgres
 * prunes partitions (a payment completes at most `PAYMENT_EXPIRY_MINUTES` after creation,
 * and that setting is capped at 7 days, so 8 days of slack is enough).
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';

const SLACK_MS = 8 * 86_400_000;

export interface EligibleMerchant {
  readonly id: string;
  readonly ref: string;
  readonly status: string;
}

export interface PeriodTotals {
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly refundMinor: bigint;
}

export interface PeriodTransaction {
  readonly id: string;
  readonly ref: string;
  readonly type: 'payment' | 'refund';
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly completedAt: Date;
}

export interface ActiveHoldTotals {
  readonly disputeMinor: bigint;
  readonly amlMinor: bigint;
}

@Injectable()
export class SettlementEligibilityRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /**
   * Merchants on this cycle that may be settled: `active`, or `suspended` (spec 6.10:
   * suspension allows settlement of balance already earned). Keyset by id.
   */
  async eligibleMerchants(
    cycleId: string,
    afterId: string | null,
    limit: number,
    executor: Executor = this.db
  ): Promise<EligibleMerchant[]> {
    const result = await executor.execute<{ id: string; ref: string; status: string }>(sql`
      select id, ref, status from core.merchants
       where settlement_cycle_id = ${cycleId}
         and status in ('active', 'suspended')
         and (${afterId}::uuid is null or id > ${afterId}::uuid)
       order by id
       limit ${limit}`);
    return result.rows;
  }

  async periodTotals(
    tx: Executor,
    merchantId: string,
    currency: string,
    start: Date,
    end: Date
  ): Promise<PeriodTotals> {
    const result = await tx.execute<{ gross: string; fee: string; refund: string }>(sql`
      select coalesce(sum(amount_minor) filter (where type = 'payment'), 0)::text as gross,
             coalesce(sum(fee_minor) filter (where type = 'payment'), 0)::text as fee,
             coalesce(sum(amount_minor) filter (where type = 'refund'), 0)::text as refund
        from core.transactions
       where created_at >= ${new Date(start.getTime() - SLACK_MS)} and created_at < ${end}
         and merchant_id = ${merchantId} and environment = 'live' and currency = ${currency}
         and status = 'succeeded' and type in ('payment', 'refund')
         and completed_at >= ${start} and completed_at < ${end}`);
    const row = result.rows[0] ?? { gross: '0', fee: '0', refund: '0' };
    return {
      grossMinor: BigInt(row.gross),
      feeMinor: BigInt(row.fee),
      refundMinor: BigInt(row.refund),
    };
  }

  /** One page of the transactions behind the totals, ordered by (completed_at, id). */
  async periodTransactions(
    tx: Executor,
    merchantId: string,
    currency: string,
    start: Date,
    end: Date,
    after: { completedAt: Date; id: string } | null,
    limit: number
  ): Promise<PeriodTransaction[]> {
    const result = await tx.execute<{
      id: string;
      ref: string;
      type: 'payment' | 'refund';
      amount: string;
      fee: string;
      completed_at: string;
    }>(sql`
      select id, ref, type, amount_minor::text as amount, fee_minor::text as fee,
             to_json(completed_at) #>> '{}' as completed_at
        from core.transactions
       where created_at >= ${new Date(start.getTime() - SLACK_MS)} and created_at < ${end}
         and merchant_id = ${merchantId} and environment = 'live' and currency = ${currency}
         and status = 'succeeded' and type in ('payment', 'refund')
         and completed_at >= ${start} and completed_at < ${end}
         and (${after?.completedAt ?? null}::timestamptz is null
              or (completed_at, id) > (${after?.completedAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
       order by completed_at, id
       limit ${limit}`);
    return result.rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      type: r.type,
      amountMinor: BigInt(r.amount),
      feeMinor: BigInt(r.fee),
      completedAt: new Date(r.completed_at),
    }));
  }

  /**
   * Active holds placed for disputes and AML (spec 6.9). Phase 7 places them with a reason
   * that starts `dispute:` or `aml:`; every other active hold already lowers `available`.
   */
  async activeHolds(tx: Executor, merchantId: string, currency: string): Promise<ActiveHoldTotals> {
    const result = await tx.execute<{ dispute: string; aml: string }>(sql`
      select coalesce(sum(amount_minor) filter (where reason like 'dispute:%'), 0)::text as dispute,
             coalesce(sum(amount_minor) filter (where reason like 'aml:%'), 0)::text as aml
        from core.holds
       where merchant_id = ${merchantId} and environment = 'live'
         and currency = ${currency} and state = 'active'`);
    const row = result.rows[0] ?? { dispute: '0', aml: '0' };
    return { disputeMinor: BigInt(row.dispute), amlMinor: BigInt(row.aml) };
  }

  /** The settlement payout's transaction, by id, optionally locked. */
  async payoutTransaction(tx: Executor, id: string, lock: boolean) {
    const result = await tx.execute<{
      id: string;
      created_at: string;
      status: string;
      outcome_unknown: boolean;
      amount_minor: string;
      currency: string;
      provider: string | null;
      ref: string;
      gateway_reference_id: string | null;
      provider_transaction_id: string | null;
    }>(
      lock
        ? sql`select t.id, to_json(t.created_at) #>> '{}' as created_at, t.status, t.outcome_unknown,
                     t.amount_minor::text as amount_minor, t.currency, t.provider, t.ref,
                     t.gateway_reference_id, t.provider_transaction_id
                from core.transaction_keys k
                join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
               where k.id = ${id} for update of t`
        : sql`select t.id, to_json(t.created_at) #>> '{}' as created_at, t.status, t.outcome_unknown,
                     t.amount_minor::text as amount_minor, t.currency, t.provider, t.ref,
                     t.gateway_reference_id, t.provider_transaction_id
                from core.transaction_keys k
                join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
               where k.id = ${id}`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      createdAtText: row.created_at,
      ref: row.ref,
      status: row.status as 'created' | 'processing' | 'succeeded' | 'failed',
      outcomeUnknown: row.outcome_unknown,
      amountMinor: BigInt(row.amount_minor),
      currency: row.currency,
      provider: row.provider,
      gatewayReferenceId: row.gateway_reference_id,
      providerTransactionId: row.provider_transaction_id,
    };
  }
}
