/** SQL for `core.aml_blocks` and the holds each block placed. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { amlBlockHolds, amlBlocks, merchants } from '../../../db/schema';

export type BlockRow = typeof amlBlocks.$inferSelect;
export type NewBlock = typeof amlBlocks.$inferInsert;
export type BlockHoldRow = typeof amlBlockHolds.$inferSelect;

@Injectable()
export class AmlBlocksRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Null when the merchant already has an active block. */
  async insert(tx: Executor, values: NewBlock): Promise<BlockRow | null> {
    const [row] = await tx
      .insert(amlBlocks)
      .values(values)
      .onConflictDoNothing({
        target: amlBlocks.merchantId,
        where: sql`${amlBlocks.status} = 'active'`,
      })
      .returning();
    return row ?? null;
  }

  async findActive(merchantId: string, tx: Executor = this.db): Promise<BlockRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlBlocks)
      .where(and(eq(amlBlocks.merchantId, merchantId), eq(amlBlocks.status, 'active')))
      .limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<BlockRow | undefined> {
    const [row] = await tx.select().from(amlBlocks).where(eq(amlBlocks.ref, ref)).for('update');
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db) {
    const [row] = await tx
      .select({ block: amlBlocks, merchantRef: merchants.ref })
      .from(amlBlocks)
      .innerJoin(merchants, eq(merchants.id, amlBlocks.merchantId))
      .where(eq(amlBlocks.ref, ref))
      .limit(1);
    return row;
  }

  async markLifted(
    tx: Executor,
    id: string,
    by: string,
    note: string,
    at: Date
  ): Promise<BlockRow> {
    const [row] = await tx
      .update(amlBlocks)
      .set({ status: 'lifted', liftedAt: at, liftedBy: by, liftNote: note })
      .where(eq(amlBlocks.id, id))
      .returning();
    if (!row) throw new Error('block update returned no row');
    return row;
  }

  async insertHold(tx: Executor, values: typeof amlBlockHolds.$inferInsert): Promise<void> {
    await tx.insert(amlBlockHolds).values(values);
  }

  holdsOf(blockId: string, tx: Executor = this.db): Promise<BlockHoldRow[]> {
    return tx.select().from(amlBlockHolds).where(eq(amlBlockHolds.blockId, blockId));
  }

  list(filter: { merchantId?: string; status?: string; limit: number }) {
    const conditions = [
      filter.merchantId ? eq(amlBlocks.merchantId, filter.merchantId) : undefined,
      filter.status ? eq(amlBlocks.status, filter.status) : undefined,
    ];
    return this.db
      .select({ block: amlBlocks, merchantRef: merchants.ref })
      .from(amlBlocks)
      .innerJoin(merchants, eq(merchants.id, amlBlocks.merchantId))
      .where(and(...conditions))
      .orderBy(desc(amlBlocks.createdAt))
      .limit(filter.limit);
  }

  async isSuspended(merchantId: string, tx: Executor = this.db): Promise<boolean> {
    return (await this.findActive(merchantId, tx)) !== undefined;
  }
}
