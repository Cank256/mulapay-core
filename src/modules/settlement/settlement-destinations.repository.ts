/** SQL for `core.settlement_destinations`. Retired destinations stay for the audit trail. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { merchants, settlementDestinations } from '../../db/schema';

export type DestinationRow = typeof settlementDestinations.$inferSelect;
export type NewDestination = typeof settlementDestinations.$inferInsert;

@Injectable()
export class SettlementDestinationsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewDestination): Promise<DestinationRow> {
    const [row] = await tx.insert(settlementDestinations).values(values).returning();
    if (!row) throw new Error('destination insert returned no row');
    return row;
  }

  async findActive(
    tx: Executor,
    merchantId: string,
    currency: string
  ): Promise<DestinationRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementDestinations)
      .where(
        and(
          eq(settlementDestinations.merchantId, merchantId),
          eq(settlementDestinations.currency, currency),
          eq(settlementDestinations.status, 'active')
        )
      );
    return row;
  }

  async findById(tx: Executor, id: string): Promise<DestinationRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementDestinations)
      .where(eq(settlementDestinations.id, id));
    return row;
  }

  async retire(tx: Executor, id: string, at: Date): Promise<void> {
    await tx
      .update(settlementDestinations)
      .set({ status: 'retired', retiredAt: at })
      .where(eq(settlementDestinations.id, id));
  }

  listForMerchantRef(merchantRef: string, executor: Executor = this.db): Promise<DestinationRow[]> {
    return executor
      .select({ d: settlementDestinations })
      .from(settlementDestinations)
      .innerJoin(merchants, eq(merchants.id, settlementDestinations.merchantId))
      .where(eq(merchants.ref, merchantRef))
      .orderBy(desc(settlementDestinations.createdAt))
      .then((rows) => rows.map((r) => r.d));
  }
}
