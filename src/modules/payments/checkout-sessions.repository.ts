/** SQL for `core.checkout_sessions`. Every merchant read takes a scope. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { checkoutSessions, payments } from '../../db/schema';

export type CheckoutSessionRow = typeof checkoutSessions.$inferSelect;
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;

export interface CheckoutSessionWithPayment {
  readonly session: CheckoutSessionRow;
  readonly paymentRef: string | null;
}

@Injectable()
export class CheckoutSessionsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewCheckoutSession): Promise<CheckoutSessionRow> {
    const [row] = await tx.insert(checkoutSessions).values(values).returning();
    if (!row) throw new Error('checkout session insert returned no row');
    return row;
  }

  async findByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<CheckoutSessionWithPayment | undefined> {
    const [row] = await executor
      .select({ session: checkoutSessions, paymentRef: payments.ref })
      .from(checkoutSessions)
      .leftJoin(payments, eq(payments.id, checkoutSessions.paymentId))
      .where(
        and(
          eq(checkoutSessions.ref, ref),
          eq(checkoutSessions.merchantId, scope.merchantId),
          eq(checkoutSessions.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  /**
   * A session by ref with no merchant scope: the payer holds a client secret, not an API key.
   * The caller verifies the secret and derives the scope from the row.
   */
  async findByRefUnscoped(
    ref: string,
    executor: Executor = this.db
  ): Promise<CheckoutSessionRow | undefined> {
    const [row] = await executor
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.ref, ref))
      .limit(1);
    return row;
  }

  /** Locks a session by ref, scoped to its merchant. Lock order: session, payment, transaction. */
  async lockByRef(
    tx: Executor,
    scope: MerchantScope,
    ref: string
  ): Promise<CheckoutSessionRow | undefined> {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.ref, ref),
          eq(checkoutSessions.merchantId, scope.merchantId),
          eq(checkoutSessions.environment, scope.environment)
        )
      )
      .for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<CheckoutSessionRow | undefined> {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, id))
      .for('update');
    return row;
  }

  /** Sets the payment of a session that has none; refuses a session that already has one. */
  async attachPayment(
    tx: Executor,
    id: string,
    paymentId: string
  ): Promise<CheckoutSessionRow | undefined> {
    const [row] = await tx
      .update(checkoutSessions)
      .set({ paymentId })
      .where(eq(checkoutSessions.id, id))
      .returning();
    return row;
  }

  async setStatus(
    tx: Executor,
    id: string,
    status: 'complete' | 'expired',
    now: Date
  ): Promise<CheckoutSessionRow> {
    const [row] = await tx
      .update(checkoutSessions)
      .set({ status, completedAt: status === 'complete' ? now : null })
      .where(eq(checkoutSessions.id, id))
      .returning();
    if (!row) throw new Error('checkout session update returned no row');
    return row;
  }

  /**
   * Open sessions past their expiry, oldest first. Not locked: the sweep locks each session
   * in its own transaction and checks again, so a session that changed meanwhile is skipped.
   */
  findDueForExpiry(
    now: Date,
    limit: number,
    executor: Executor = this.db
  ): Promise<CheckoutSessionRow[]> {
    return executor
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.status, 'open'), lte(checkoutSessions.expiresAt, now)))
      .orderBy(checkoutSessions.expiresAt)
      .limit(limit);
  }
}
