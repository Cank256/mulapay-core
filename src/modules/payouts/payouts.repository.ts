/**
 * SQL for `core.payouts`. A payout is read together with its transaction, similar to payments.
 * Merchant reads use the primary replica so a merchant can read back what it just wrote.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { payouts, transactions } from '../../db/schema';
import type { TransactionRow } from '../transactions/transactions.repository';

export type PayoutRow = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type PayoutPatch = Partial<Pick<NewPayout, 'status'>>;

/** A payout with the transaction it maps to. */
export interface PayoutDetail {
  readonly payout: PayoutRow;
  readonly transaction: TransactionRow;
}

export interface PayoutListFilter {
  readonly scope: MerchantScope;
  readonly from: Date;
  readonly to: Date;
  readonly status?: string;
  readonly currency?: string;
  readonly channel?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

const detailColumns = {
  payout: payouts,
  transaction: transactions,
};

@Injectable()
export class PayoutsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewPayout): Promise<PayoutRow> {
    const [row] = await tx.insert(payouts).values(values).returning();
    if (!row) throw new Error('payout insert returned no row');
    return row;
  }

  private detailQuery(executor: Executor) {
    return executor
      .select(detailColumns)
      .from(payouts)
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, payouts.transactionId),
          eq(transactions.createdAt, payouts.createdAt)
        )
      );
  }

  async findDetailByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<PayoutDetail | undefined> {
    const [row] = await this.detailQuery(executor)
      .where(
        and(
          eq(payouts.ref, ref),
          eq(payouts.merchantId, scope.merchantId),
          eq(payouts.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  async findDetailById(
    id: string,
    executor: Executor = this.db
  ): Promise<PayoutDetail | undefined> {
    const [row] = await this.detailQuery(executor).where(eq(payouts.id, id)).limit(1);
    return row;
  }

  async findById(tx: Executor, id: string): Promise<PayoutRow | undefined> {
    const [row] = await tx.select().from(payouts).where(eq(payouts.id, id)).limit(1);
    return row;
  }

  /**
   * Find a payout by ref without merchant scoping. For admin use only — never expose to
   * merchant-scoped routes.
   */
  async findDetailByRefAdmin(
    ref: string,
    executor: Executor = this.db
  ): Promise<PayoutDetail | undefined> {
    const [row] = await this.detailQuery(executor).where(eq(payouts.ref, ref)).limit(1);
    return row;
  }

  /**
   * Find payout by transaction ID. Used by event handlers to locate the payout for a
   * gateway event.
   */
  async findByTransactionId(
    transactionId: string,
    executor: Executor = this.db
  ): Promise<PayoutRow | undefined> {
    const [row] = await executor
      .select()
      .from(payouts)
      .where(eq(payouts.transactionId, transactionId))
      .limit(1);
    return row;
  }

  /** Locks one payout row. */
  async lockById(tx: Executor, id: string): Promise<PayoutRow | undefined> {
    const [row] = await tx.select().from(payouts).where(eq(payouts.id, id)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: PayoutPatch): Promise<PayoutRow> {
    const [row] = await tx.update(payouts).set(patch).where(eq(payouts.id, id)).returning();
    if (!row) throw new Error('payout update returned no row');
    return row;
  }

  /** Newest first, keyset on `(created_at, ref)`. The caller passes `limit + 1`. */
  list(filter: PayoutListFilter, executor: Executor = this.db): Promise<PayoutDetail[]> {
    const { scope } = filter;
    const conditions: (SQL | undefined)[] = [
      eq(payouts.merchantId, scope.merchantId),
      eq(payouts.environment, scope.environment),
      gte(payouts.createdAt, filter.from),
      lte(payouts.createdAt, filter.to),
      filter.status ? eq(payouts.status, filter.status) : undefined,
      filter.currency ? eq(payouts.currency, filter.currency) : undefined,
      filter.channel ? eq(payouts.channel, filter.channel) : undefined,
    ];
    if (filter.after) {
      conditions.push(...olderThan(payouts.createdAt, payouts.ref, filter.after));
    }
    return this.detailQuery(executor)
      .where(and(...conditions))
      .orderBy(...newestFirst(payouts.createdAt, payouts.ref))
      .limit(filter.limit);
  }

  /**
   * Payouts due for expiry: created but never submitted, past expiration time.
   * Not locked: the lifecycle locks each and checks status again.
   */
  async findDueForExpiry(_now: Date, _limit: number): Promise<string[]> {
    // Payouts don't have expiresAt in the schema yet.
    // For now, return empty array since payouts don't auto-expire in the same way.
    return [];
  }

  /** List payouts without merchant scoping — admin use only. The caller passes `limit + 1`. */
  async listAdmin(filter: {
    status?: string;
    currency?: string;
    merchantId?: string;
    from: Date;
    to: Date;
    after?: CursorKey;
    limit: number;
  }): Promise<PayoutDetail[]> {
    const conditions: (SQL | undefined)[] = [
      gte(payouts.createdAt, filter.from),
      lte(payouts.createdAt, filter.to),
      filter.status ? eq(payouts.status, filter.status) : undefined,
      filter.currency ? eq(payouts.currency, filter.currency) : undefined,
      filter.merchantId ? eq(payouts.merchantId, filter.merchantId) : undefined,
    ];
    if (filter.after) {
      conditions.push(...olderThan(payouts.createdAt, payouts.ref, filter.after));
    }
    return this.detailQuery(this.db)
      .where(and(...conditions))
      .orderBy(...newestFirst(payouts.createdAt, payouts.ref))
      .limit(filter.limit);
  }
}
