/** SQL for `core.aml_blocklist`. Only keyed hashes are stored. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import type { CursorKey } from '../../../common/pagination/cursor';
import { amlBlocklist } from '../../../db/schema';

export type BlocklistRow = typeof amlBlocklist.$inferSelect;
export type NewBlocklistEntry = typeof amlBlocklist.$inferInsert;

@Injectable()
export class AmlBlocklistRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Null when an active entry for the same value already exists. */
  async insert(tx: Executor, values: NewBlocklistEntry): Promise<BlocklistRow | null> {
    const [row] = await tx.insert(amlBlocklist).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async findActive(
    entryType: string,
    valueHmac: string,
    tx: Executor = this.db
  ): Promise<BlocklistRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlBlocklist)
      .where(
        and(
          eq(amlBlocklist.entryType, entryType),
          eq(amlBlocklist.valueHmac, valueHmac),
          isNull(amlBlocklist.removedAt)
        )
      )
      .limit(1);
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<BlocklistRow | undefined> {
    const [row] = await tx.select().from(amlBlocklist).where(eq(amlBlocklist.ref, ref)).limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<BlocklistRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlBlocklist)
      .where(eq(amlBlocklist.ref, ref))
      .for('update');
    return row;
  }

  async markRemoved(tx: Executor, id: string, by: string, at: Date): Promise<BlocklistRow> {
    const [row] = await tx
      .update(amlBlocklist)
      .set({ removedAt: at, removedBy: by })
      .where(eq(amlBlocklist.id, id))
      .returning();
    if (!row) throw new Error('blocklist update returned no row');
    return row;
  }

  /** Every active entry, for rebuilding the Redis mirror. */
  listActive(tx: Executor = this.db): Promise<BlocklistRow[]> {
    return tx.select().from(amlBlocklist).where(isNull(amlBlocklist.removedAt));
  }

  list(filter: {
    entryType?: string;
    includeRemoved: boolean;
    after?: CursorKey;
    limit: number;
  }): Promise<BlocklistRow[]> {
    const conditions: SQL[] = [];
    if (filter.entryType) conditions.push(eq(amlBlocklist.entryType, filter.entryType));
    if (!filter.includeRemoved) conditions.push(isNull(amlBlocklist.removedAt));
    if (filter.after) {
      const keyset = or(
        lt(amlBlocklist.createdAt, filter.after.createdAt),
        and(
          eq(amlBlocklist.createdAt, filter.after.createdAt),
          lt(amlBlocklist.ref, filter.after.id)
        )
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select()
      .from(amlBlocklist)
      .where(and(...conditions))
      .orderBy(desc(amlBlocklist.createdAt), desc(amlBlocklist.ref))
      .limit(filter.limit + 1);
  }
}
