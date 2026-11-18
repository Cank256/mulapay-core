/**
 * SQL for `core.refunds`. A refund is read together with its transaction (one join on
 * `(transaction_id, created_at)`), the payment it refunds, and the refs of the payment's
 * link or session, so a list needs one query and not one per row.
 *
 * Merchant reads use the primary so a merchant can read back what it just wrote.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql, sum, type SQL } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { checkoutSessions, paymentLinks, payments, refunds, transactions } from '../../db/schema';
import type { TransactionRow } from '../transactions/transactions.repository';
import type { PaymentRow } from '../payments/payments.repository';

export type RefundRow = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
export type RefundPatch = Partial<Pick<NewRefund, 'status'>>;

/** A refund with the transaction it maps to, the payment it refunds, and payment's origin. */
export interface RefundDetail {
  readonly refund: RefundRow;
  readonly transaction: TransactionRow;
  readonly payment: PaymentRow;
  readonly paymentLinkRef: string | null;
  readonly checkoutSessionRef: string | null;
}

export interface RefundListFilter {
  readonly scope: MerchantScope;
  readonly from: Date;
  readonly to: Date;
  readonly status?: string;
  readonly currency?: string;
  readonly paymentRef?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

const detailColumns = {
  refund: refunds,
  transaction: transactions,
  payment: payments,
  paymentLinkRef: paymentLinks.ref,
  checkoutSessionRef: checkoutSessions.ref,
};

@Injectable()
export class RefundsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewRefund): Promise<RefundRow> {
    const [row] = await tx.insert(refunds).values(values).returning();
    if (!row) throw new Error('refund insert returned no row');
    return row;
  }

  private detailQuery(executor: Executor) {
    return executor
      .select(detailColumns)
      .from(refunds)
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, refunds.transactionId),
          eq(transactions.createdAt, refunds.createdAt)
        )
      )
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .leftJoin(paymentLinks, eq(paymentLinks.id, payments.paymentLinkId))
      .leftJoin(checkoutSessions, eq(checkoutSessions.id, payments.checkoutSessionId));
  }

  async findDetailByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<RefundDetail | undefined> {
    const [row] = await this.detailQuery(executor)
      .where(
        and(
          eq(refunds.ref, ref),
          eq(refunds.merchantId, scope.merchantId),
          eq(refunds.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  async findDetailById(
    id: string,
    executor: Executor = this.db
  ): Promise<RefundDetail | undefined> {
    const [row] = await this.detailQuery(executor).where(eq(refunds.id, id)).limit(1);
    return row;
  }

  async findById(tx: Executor, id: string): Promise<RefundRow | undefined> {
    const [row] = await tx.select().from(refunds).where(eq(refunds.id, id)).limit(1);
    return row;
  }

  async findByTransactionId(transactionId: string, tx: Executor): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.transactionId, transactionId))
      .limit(1);
    return row;
  }

  /** Lock refund by id (SELECT FOR UPDATE). */
  async lockById(tx: Executor, id: string): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.id, id))
      .for('update')
      .limit(1);
    return row;
  }

  async update(tx: Executor, id: string, patch: RefundPatch): Promise<RefundRow> {
    const [row] = await tx
      .update(refunds)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(refunds.id, id))
      .returning();
    if (!row) throw new Error('refund update returned no row');
    return row;
  }

  async list(filter: RefundListFilter, executor: Executor = this.db): Promise<RefundDetail[]> {
    const window = resolveWindow(filter.from, filter.to);
    const conditions: SQL[] = [
      eq(refunds.merchantId, filter.scope.merchantId),
      eq(refunds.environment, filter.scope.environment),
      gte(refunds.createdAt, window.from),
      lte(refunds.createdAt, window.to),
    ];
    if (filter.status) conditions.push(eq(refunds.status, filter.status));
    if (filter.currency) conditions.push(eq(refunds.currency, filter.currency));
    if (filter.paymentRef) conditions.push(eq(payments.ref, filter.paymentRef));
    if (filter.after) {
      conditions.push(olderThan(refunds.createdAt, refunds.ref, filter.after));
    }
    return this.detailQuery(executor)
      .where(and(...conditions))
      .orderBy(...newestFirst(refunds.createdAt, refunds.ref))
      .limit(filter.limit);
  }

  /** Sum of all refunds (any status) for a payment. */
  async totalRefundedForPayment(
    paymentId: string,
    executor: Executor = this.db
  ): Promise<bigint> {
    const [result] = await executor
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId));
    return result?.total ? BigInt(result.total) : 0n;
  }

  /** Sum of refunds in terminal success status for a payment. */
  async totalSucceededRefundsForPayment(
    paymentId: string,
    executor: Executor = this.db
  ): Promise<bigint> {
    const [result] = await executor
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'succeeded')));
    return result?.total ? BigInt(result.total) : 0n;
  }

  /** Check if any processing/pending refunds exist for a payment. */
  async hasActiveRefunds(paymentId: string, executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.paymentId, paymentId),
          sql`${refunds.status} in ('created', 'pending_approval', 'processing')`
        )
      )
      .limit(1);
    return row !== undefined;
  }
}
