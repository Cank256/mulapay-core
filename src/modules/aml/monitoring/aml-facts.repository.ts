/**
 * SQL for AML monitoring: the terminal transaction under review, the facts table the rules
 * aggregate over, and a merchant-level lock.
 *
 * Reads `core.transactions` and `core.payments` (owned by the payments domain) but writes
 * only `core.aml_transaction_facts`. Every `transactions` read carries a `created_at` bound so
 * the planner prunes partitions (spec 5.1).
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { amlTransactionFacts, merchants } from '../../../db/schema';
import type { RuleFacts } from '../domain/rule-evaluation';
import type { TerminalStatus } from '../domain/rule-params';

export interface MonitoredRow {
  readonly id: string;
  readonly ref: string;
  readonly merchantId: string;
  readonly environment: string;
  readonly type: string;
  readonly status: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly channel: string;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly paymentRef: string | null;
  readonly msisdnEnc: string | null;
}

@Injectable()
export class AmlFactsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async loadTransaction(tx: Executor, transactionId: string): Promise<MonitoredRow | undefined> {
    const result = await tx.execute<{
      id: string;
      ref: string;
      merchant_id: string;
      environment: string;
      type: string;
      status: string;
      amount_minor: string;
      currency: string;
      channel: string;
      completed_at: string | null;
      created_at: string;
      payment_ref: string | null;
      msisdn_enc: string | null;
    }>(sql`
      select t.id, t.ref, t.merchant_id, t.environment, t.type, t.status,
             t.amount_minor::text as amount_minor, t.currency, t.channel,
             to_json(t.completed_at) #>> '{}' as completed_at,
             to_json(t.created_at) #>> '{}' as created_at,
             p.ref as payment_ref, p.payment_method ->> 'msisdnEnc' as msisdn_enc
        from core.transaction_keys k
        join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
        left join core.payments p on p.transaction_id = t.id and p.created_at = t.created_at
       where k.id = ${transactionId}`);
    const r = result.rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      ref: r.ref,
      merchantId: r.merchant_id,
      environment: r.environment,
      type: r.type,
      status: r.status,
      amountMinor: BigInt(r.amount_minor),
      currency: r.currency,
      channel: r.channel,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
      createdAt: new Date(r.created_at),
      paymentRef: r.payment_ref,
      msisdnEnc: r.msisdn_enc,
    };
  }

  /** Serialises monitoring per merchant, so two concurrent jobs see each other's facts. */
  async lockMerchant(tx: Executor, merchantId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`aml:${merchantId}`}, 0))`
    );
  }

  async merchantCreatedAt(tx: Executor, merchantId: string): Promise<Date | undefined> {
    const [row] = await tx
      .select({ createdAt: merchants.createdAt })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    return row?.createdAt;
  }

  /** False when the transaction had been monitored already. */
  async insertFact(
    tx: Executor,
    values: typeof amlTransactionFacts.$inferInsert
  ): Promise<boolean> {
    const rows = await tx
      .insert(amlTransactionFacts)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: amlTransactionFacts.transactionId });
    return rows.length > 0;
  }

  /** The questions the rules ask, answered for one merchant, currency and counterparty. */
  factsFor(
    tx: Executor,
    subject: {
      merchantId: string;
      currency: string;
      completedAt: Date;
      counterpartyHmac: string | null;
    }
  ): RuleFacts {
    const bounds = (windowSeconds: number) => ({
      from: new Date(subject.completedAt.getTime() - windowSeconds * 1000),
      to: subject.completedAt,
    });
    const statusList = (statuses: readonly TerminalStatus[]) =>
      sql.join(
        statuses.map((s) => sql`${s}`),
        sql`, `
      );
    return {
      windowTotals: async (windowSeconds, statuses) => {
        const { from, to } = bounds(windowSeconds);
        const result = await tx.execute<{ n: string; total: string }>(sql`
          select count(*)::text as n, coalesce(sum(amount_minor), 0)::text as total
            from core.aml_transaction_facts
           where merchant_id = ${subject.merchantId} and currency = ${subject.currency}
             and completed_at > ${from} and completed_at <= ${to}
             and status in (${statusList(statuses)})`);
        const row = result.rows[0];
        return { count: Number(row?.n ?? 0), sumMinor: BigInt(row?.total ?? '0') };
      },
      countInBand: async (windowSeconds, statuses, fromMinor, toMinor) => {
        const { from, to } = bounds(windowSeconds);
        const result = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from core.aml_transaction_facts
           where merchant_id = ${subject.merchantId} and currency = ${subject.currency}
             and completed_at > ${from} and completed_at <= ${to}
             and status in (${statusList(statuses)})
             and amount_minor between ${fromMinor.toString()}::bigint and ${toMinor.toString()}::bigint`);
        return Number(result.rows[0]?.n ?? 0);
      },
      countRound: async (windowSeconds, statuses, unitMinor, minMinor) => {
        const { from, to } = bounds(windowSeconds);
        const result = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from core.aml_transaction_facts
           where merchant_id = ${subject.merchantId} and currency = ${subject.currency}
             and completed_at > ${from} and completed_at <= ${to}
             and status in (${statusList(statuses)})
             and amount_minor >= ${minMinor.toString()}::bigint
             and amount_minor % ${unitMinor.toString()}::bigint = 0`);
        return Number(result.rows[0]?.n ?? 0);
      },
      counterpartyPayments: async (windowSeconds, statuses, scope) => {
        if (subject.counterpartyHmac === null) return { count: 0, merchants: 0 };
        const { from, to } = bounds(windowSeconds);
        const result = await tx.execute<{ n: string; m: string }>(sql`
          select count(*)::text as n, count(distinct merchant_id)::text as m
            from core.aml_transaction_facts
           where counterparty_hmac = ${subject.counterpartyHmac}
             and currency = ${subject.currency}
             and completed_at > ${from} and completed_at <= ${to}
             and status in (${statusList(statuses)})
             and (${scope} = 'platform' or merchant_id = ${subject.merchantId})`);
        return { count: Number(result.rows[0]?.n ?? 0), merchants: Number(result.rows[0]?.m ?? 0) };
      },
    };
  }
}
