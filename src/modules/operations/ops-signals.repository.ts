/** SQL for the monitors and the operations overview: signal state, stuck transactions, suspense, rollups. */
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { opsSignals } from '../../db/schema';

export type SignalRow = typeof opsSignals.$inferSelect;

export interface StuckTransaction {
  readonly ref: string;
  readonly type: string;
  readonly merchantRef: string;
  readonly environment: string;
  readonly provider: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly outcomeUnknown: boolean;
  readonly gatewayExternalId: string | null;
  readonly startedAt: Date;
  readonly createdAt: Date;
}

export interface SuspenseBalance {
  readonly environment: string;
  readonly currency: string;
  readonly balanceMinor: bigint;
}

/** Transactions are partitioned by month: every query carries a `created_at` lower bound. */
const STUCK_LOOKBACK_DAYS = 30;

@Injectable()
export class OpsSignalsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async lockSignal(tx: Executor, key: string): Promise<SignalRow | undefined> {
    const [row] = await tx
      .select()
      .from(opsSignals)
      .where(eq(opsSignals.signalKey, key))
      .for('update');
    return row;
  }

  async saveSignal(
    tx: Executor,
    row: { key: string; activeSince: Date | null; observedAt: Date; value: Record<string, unknown> }
  ): Promise<void> {
    await tx
      .insert(opsSignals)
      .values({
        signalKey: row.key,
        activeSince: row.activeSince,
        lastObservedAt: row.observedAt,
        lastValue: row.value,
      })
      .onConflictDoUpdate({
        target: opsSignals.signalKey,
        set: { activeSince: row.activeSince, lastObservedAt: row.observedAt, lastValue: row.value },
      });
  }

  async activeSignals(): Promise<Array<{ key: string; activeSince: Date }>> {
    const rows = await this.db.execute<{ signal_key: string; active_since: string }>(sql`
      select signal_key, to_json(active_since) #>> '{}' as active_since
        from core.ops_signals where active_since is not null order by active_since`);
    return rows.rows.map((r) => ({ key: r.signal_key, activeSince: new Date(r.active_since) }));
  }

  /** Processing transactions older than `olderThan`, oldest first. */
  async stuck(
    now: Date,
    olderThan: Date,
    after: CursorKey | undefined,
    limit: number
  ): Promise<StuckTransaction[]> {
    const from = new Date(now.getTime() - STUCK_LOOKBACK_DAYS * 86_400_000);
    const cursorStart = after?.createdAt ?? new Date(0);
    const cursorRef = after?.id ?? '';
    const result = await this.db.execute<Record<string, unknown>>(sql`
      select t.ref, t.type, m.ref as merchant_ref, t.environment, t.provider,
             t.amount_minor::text as amount_minor, t.currency, t.outcome_unknown,
             t.gateway_external_id,
             to_json(coalesce(t.initiated_at, t.created_at)) #>> '{}' as started_at,
             to_json(t.created_at) #>> '{}' as created_at
        from core.transactions t
        join core.merchants m on m.id = t.merchant_id
       where t.created_at >= ${from} and t.status = 'processing'
         and coalesce(t.initiated_at, t.created_at) <= ${olderThan}
         and (coalesce(t.initiated_at, t.created_at), t.ref) > (${cursorStart}, ${cursorRef})
       order by coalesce(t.initiated_at, t.created_at), t.ref
       limit ${limit + 1}`);
    return result.rows.map(toStuck);
  }

  /** Count and oldest start of stuck transactions, by type, for gauges and the incident monitor. */
  async stuckSummary(
    now: Date,
    olderThan: Date
  ): Promise<Array<{ type: string; n: number; oldest: Date }>> {
    const from = new Date(now.getTime() - STUCK_LOOKBACK_DAYS * 86_400_000);
    const result = await this.db.execute<{ type: string; n: string; oldest: string }>(sql`
      select t.type, count(*)::text as n,
             to_json(min(coalesce(t.initiated_at, t.created_at))) #>> '{}' as oldest
        from core.transactions t
       where t.created_at >= ${from} and t.status = 'processing'
         and coalesce(t.initiated_at, t.created_at) <= ${olderThan}
       group by t.type`);
    return result.rows.map((r) => ({ type: r.type, n: Number(r.n), oldest: new Date(r.oldest) }));
  }

  /** Non-zero suspense balances per environment and currency (debit positive). */
  async suspense(): Promise<SuspenseBalance[]> {
    const result = await this.db.execute<{
      environment: string;
      currency: string;
      balance: string;
    }>(sql`
      select a.environment, b.currency, (b.posted_debits_minor - b.posted_credits_minor)::text as balance
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       where a.purpose = 'suspense' and b.posted_debits_minor <> b.posted_credits_minor
       order by a.environment, b.currency`);
    return result.rows.map((r) => ({
      environment: r.environment,
      currency: r.currency,
      balanceMinor: BigInt(r.balance),
    }));
  }

  /**
   * Platform totals for a UTC day, per environment and currency, from the rollups only
   * (spec 9.2 rule 4): the operations overview never aggregates transactions.
   */
  async rollupTotals(
    day: string,
    environment: string
  ): Promise<
    Array<{
      currency: string;
      paymentCount: number;
      paymentMinor: bigint;
      successCount: number;
      failureCount: number;
      refundMinor: bigint;
      payoutMinor: bigint;
    }>
  > {
    const result = await this.db.execute<Record<string, string>>(sql`
      select currency, sum(payment_count)::text as payment_count, sum(payment_minor)::text as payment_minor,
             sum(success_count)::text as success_count, sum(failure_count)::text as failure_count,
             sum(refund_minor)::text as refund_minor, sum(payout_minor)::text as payout_minor
        from core.daily_merchant_rollups
       where environment = ${environment} and date = ${day}::date
       group by currency order by currency`);
    return result.rows.map((r) => ({
      currency: r.currency ?? '',
      paymentCount: Number(r.payment_count),
      paymentMinor: BigInt(r.payment_minor ?? '0'),
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
      refundMinor: BigInt(r.refund_minor ?? '0'),
      payoutMinor: BigInt(r.payout_minor ?? '0'),
    }));
  }

  async incidentCounts(): Promise<Array<{ severity: string; n: number }>> {
    const result = await this.db.execute<{ severity: string; n: string }>(sql`
      select severity, count(*)::text as n from core.incidents where status <> 'resolved' group by severity`);
    return result.rows.map((r) => ({ severity: r.severity, n: Number(r.n) }));
  }

  async pendingApprovals(): Promise<number> {
    const result = await this.db.execute<{ n: string }>(
      sql`select count(*)::text as n from core.approvals where status = 'pending'`
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async breachedComplaints(): Promise<number> {
    const result = await this.db.execute<{ n: string }>(sql`
      select count(*)::text as n from core.complaints
       where breached and status in ('open', 'in_progress', 'awaiting_customer', 'escalated')`);
    return Number(result.rows[0]?.n ?? 0);
  }
}

function toStuck(r: Record<string, unknown>): StuckTransaction {
  return {
    ref: r.ref as string,
    type: r.type as string,
    merchantRef: r.merchant_ref as string,
    environment: r.environment as string,
    provider: (r.provider as string | null) ?? null,
    amountMinor: BigInt(r.amount_minor as string),
    currency: r.currency as string,
    outcomeUnknown: r.outcome_unknown as boolean,
    gatewayExternalId: (r.gateway_external_id as string | null) ?? null,
    startedAt: new Date(r.started_at as string),
    createdAt: new Date(r.created_at as string),
  };
}
