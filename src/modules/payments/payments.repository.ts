/**
 * SQL for `core.payments`. A payment is read together with its transaction (one join on
 * `(transaction_id, created_at)`, which resolves to a single partition) and the refs of the
 * link or session it came from, so a list needs one query and not one per row (spec 9.2).
 *
 * Merchant reads use the primary so a merchant can read back what it just wrote.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { checkoutSessions, paymentLinks, payments, transactions } from '../../db/schema';
import type { TransactionRow } from '../transactions/transactions.repository';

export type PaymentRow = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentPatch = Partial<Pick<NewPayment, 'status'>>;

/** A payment with the transaction it maps to and the refs of its origin. */
export interface PaymentDetail {
  readonly payment: PaymentRow;
  readonly transaction: TransactionRow;
  readonly paymentLinkRef: string | null;
  readonly checkoutSessionRef: string | null;
}

export interface PaymentListFilter {
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
  payment: payments,
  transaction: transactions,
  paymentLinkRef: paymentLinks.ref,
  checkoutSessionRef: checkoutSessions.ref,
};

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewPayment): Promise<PaymentRow> {
    const [row] = await tx.insert(payments).values(values).returning();
    if (!row) throw new Error('payment insert returned no row');
    return row;
  }

  private detailQuery(executor: Executor) {
    return executor
      .select(detailColumns)
      .from(payments)
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, payments.transactionId),
          eq(transactions.createdAt, payments.createdAt)
        )
      )
      .leftJoin(paymentLinks, eq(paymentLinks.id, payments.paymentLinkId))
      .leftJoin(checkoutSessions, eq(checkoutSessions.id, payments.checkoutSessionId));
  }

  async findDetailByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<PaymentDetail | undefined> {
    const [row] = await this.detailQuery(executor)
      .where(
        and(
          eq(payments.ref, ref),
          eq(payments.merchantId, scope.merchantId),
          eq(payments.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  async findDetailById(
    id: string,
    executor: Executor = this.db
  ): Promise<PaymentDetail | undefined> {
    const [row] = await this.detailQuery(executor).where(eq(payments.id, id)).limit(1);
    return row;
  }

  async findById(tx: Executor, id: string): Promise<PaymentRow | undefined> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
    return row;
  }

  /**
   * Find payment by transaction ID. Used by event handlers to locate the payment for a
   * gateway event (P4-09).
   */
  async findByTransactionId(
    transactionId: string,
    executor: Executor = this.db
  ): Promise<PaymentRow | undefined> {
    const [row] = await executor
      .select()
      .from(payments)
      .where(eq(payments.transactionId, transactionId))
      .limit(1);
    return row;
  }

  /** Locks one payment row. Lock order across the domain: session, payment, transaction. */
  async lockById(tx: Executor, id: string): Promise<PaymentRow | undefined> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, id)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: PaymentPatch): Promise<PaymentRow> {
    const [row] = await tx.update(payments).set(patch).where(eq(payments.id, id)).returning();
    if (!row) throw new Error('payment update returned no row');
    return row;
  }

  /** Newest first, keyset on `(created_at, ref)`; returns `limit + 1` rows. */
  list(filter: PaymentListFilter, executor: Executor = this.db): Promise<PaymentDetail[]> {
    const { scope } = filter;
    const conditions: (SQL | undefined)[] = [
      eq(payments.merchantId, scope.merchantId),
      eq(payments.environment, scope.environment),
      gte(payments.createdAt, filter.from),
      lte(payments.createdAt, filter.to),
      filter.status ? eq(payments.status, filter.status) : undefined,
      filter.currency ? eq(payments.currency, filter.currency) : undefined,
      filter.channel ? eq(payments.channel, filter.channel) : undefined,
    ];
    if (filter.after) {
      conditions.push(...olderThan(payments.createdAt, payments.ref, filter.after));
    }
    return this.detailQuery(executor)
      .where(and(...conditions))
      .orderBy(...newestFirst(payments.createdAt, payments.ref))
      .limit(filter.limit + 1);
  }

  /**
   * Payments that were never submitted to a provider and are past their expiry, oldest
   * first. Payments in `requires_action` or `processing` are not here: a provider operation
   * exists for them, so only the gateway (an event or the chase job) may say how it ended
   * (spec 17.5). Not locked: the lifecycle locks each payment and checks its status again.
   */
  async findDueForExpiry(
    now: Date,
    limit: number,
    executor: Executor = this.db
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.status, 'created'), lte(payments.expiresAt, now)))
      .orderBy(payments.expiresAt)
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
