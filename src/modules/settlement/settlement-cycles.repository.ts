/** SQL for `core.settlement_cycles` and the merchants assigned to them. Never deleted. */
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { merchants, settlementCycles } from '../../db/schema';

export type CycleRow = typeof settlementCycles.$inferSelect;
export type NewCycle = typeof settlementCycles.$inferInsert;
export type CyclePatch = Partial<
  Pick<
    NewCycle,
    'name' | 'schedule' | 'delayDays' | 'cutoffTime' | 'timezone' | 'minPayoutMinor' | 'active'
  >
>;

@Injectable()
export class SettlementCyclesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewCycle): Promise<CycleRow> {
    const [row] = await tx.insert(settlementCycles).values(values).returning();
    if (!row) throw new Error('cycle insert returned no row');
    return row;
  }

  async update(tx: Executor, id: string, patch: CyclePatch): Promise<CycleRow> {
    const [row] = await tx
      .update(settlementCycles)
      .set(patch)
      .where(eq(settlementCycles.id, id))
      .returning();
    if (!row) throw new Error('cycle update returned no row');
    return row;
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<CycleRow | undefined> {
    const [row] = await executor
      .select()
      .from(settlementCycles)
      .where(eq(settlementCycles.ref, ref));
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<CycleRow | undefined> {
    const [row] = await executor.select().from(settlementCycles).where(eq(settlementCycles.id, id));
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<CycleRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementCycles)
      .where(eq(settlementCycles.ref, ref))
      .for('update');
    return row;
  }

  list(onlyActive: boolean, executor: Executor = this.db): Promise<CycleRow[]> {
    return executor
      .select()
      .from(settlementCycles)
      .where(onlyActive ? eq(settlementCycles.active, true) : undefined)
      .orderBy(asc(settlementCycles.name));
  }

  /** Assigns a merchant to a cycle (or clears it). */
  async assignMerchant(tx: Executor, merchantId: string, cycleId: string | null): Promise<void> {
    await tx
      .update(merchants)
      .set({ settlementCycleId: cycleId })
      .where(eq(merchants.id, merchantId));
  }
}
