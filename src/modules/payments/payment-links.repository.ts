/** SQL for `core.payment_links`. Every merchant read takes a scope. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { paymentLinks } from '../../db/schema';

export type PaymentLinkRow = typeof paymentLinks.$inferSelect;
export type NewPaymentLink = typeof paymentLinks.$inferInsert;
export type PaymentLinkPatch = Partial<
  Pick<
    NewPaymentLink,
    'title' | 'description' | 'successUrl' | 'maxUses' | 'expiresAt' | 'metadata' | 'active'
  >
>;

export interface PaymentLinkListFilter {
  readonly scope: MerchantScope;
  readonly active?: boolean;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class PaymentLinksRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewPaymentLink): Promise<PaymentLinkRow> {
    const [row] = await tx.insert(paymentLinks).values(values).returning();
    if (!row) throw new Error('payment link insert returned no row');
    return row;
  }

  async findByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<PaymentLinkRow | undefined> {
    const [row] = await executor
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.ref, ref),
          eq(paymentLinks.merchantId, scope.merchantId),
          eq(paymentLinks.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  /**
   * A link by its public slug, with no merchant scope: the payer has no credentials, and the
   * slug is what identifies the link. The caller derives the scope from the row.
   */
  async findBySlug(
    slug: string,
    executor: Executor = this.db
  ): Promise<PaymentLinkRow | undefined> {
    const [row] = await executor
      .select()
      .from(paymentLinks)
      .where(eq(paymentLinks.slug, slug))
      .limit(1);
    return row;
  }

  async lockByRef(
    tx: Executor,
    scope: MerchantScope,
    ref: string
  ): Promise<PaymentLinkRow | undefined> {
    const [row] = await tx
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.ref, ref),
          eq(paymentLinks.merchantId, scope.merchantId),
          eq(paymentLinks.environment, scope.environment)
        )
      )
      .for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: PaymentLinkPatch): Promise<PaymentLinkRow> {
    const [row] = await tx
      .update(paymentLinks)
      .set(patch)
      .where(eq(paymentLinks.id, id))
      .returning();
    if (!row) throw new Error('payment link update returned no row');
    return row;
  }

  /**
   * Takes one use of an available link, atomically. The conditions are in the statement, so
   * two payers racing for the last use cannot both get it: the row lock serialises them and
   * the second one re-evaluates `used_count < max_uses` against the committed count.
   * Returns undefined when the link is inactive, expired, exhausted or not this merchant's.
   */
  async takeUse(
    tx: Executor,
    scope: MerchantScope,
    ref: string,
    now: Date
  ): Promise<PaymentLinkRow | undefined> {
    const [row] = await tx
      .update(paymentLinks)
      .set({ usedCount: sql`${paymentLinks.usedCount} + 1` })
      .where(
        and(
          eq(paymentLinks.ref, ref),
          eq(paymentLinks.merchantId, scope.merchantId),
          eq(paymentLinks.environment, scope.environment),
          eq(paymentLinks.active, true),
          sql`(${paymentLinks.expiresAt} is null or ${paymentLinks.expiresAt} > ${now})`,
          sql`(${paymentLinks.maxUses} is null or ${paymentLinks.usedCount} < ${paymentLinks.maxUses})`
        )
      )
      .returning();
    return row;
  }

  list(filter: PaymentLinkListFilter, executor: Executor = this.db): Promise<PaymentLinkRow[]> {
    const { scope } = filter;
    const conditions: (SQL | undefined)[] = [
      eq(paymentLinks.merchantId, scope.merchantId),
      eq(paymentLinks.environment, scope.environment),
      filter.active !== undefined ? eq(paymentLinks.active, filter.active) : undefined,
    ];
    if (filter.after) {
      conditions.push(...olderThan(paymentLinks.createdAt, paymentLinks.ref, filter.after));
    }
    return executor
      .select()
      .from(paymentLinks)
      .where(and(...conditions))
      .orderBy(...newestFirst(paymentLinks.createdAt, paymentLinks.ref))
      .limit(filter.limit + 1);
  }
}
