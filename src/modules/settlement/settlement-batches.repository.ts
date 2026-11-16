/**
 * SQL for settlement batches, items, status history, reserve entries and runs
 * (`settlement_*`, `reserve_entries`). Batches are never deleted; their amounts never
 * change (database guard), only their status and the payout they created.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import {
  merchants,
  settlementCycles,
  reserveEntries,
  settlementBatchEvents,
  settlementBatches,
  settlementItems,
  settlementRuns,
} from '../../db/schema';

export type BatchRow = typeof settlementBatches.$inferSelect;
export type NewBatch = typeof settlementBatches.$inferInsert;
export type BatchEventRow = typeof settlementBatchEvents.$inferSelect;
export type ItemRow = typeof settlementItems.$inferSelect;
export type NewItem = typeof settlementItems.$inferInsert;
export type ReserveEntryRow = typeof reserveEntries.$inferSelect;
export type RunRow = typeof settlementRuns.$inferSelect;
export type NewRun = typeof settlementRuns.$inferInsert;

export type BatchPatch = Partial<
  Pick<
    NewBatch,
    | 'status'
    | 'destinationId'
    | 'destinationFingerprint'
    | 'provider'
    | 'submittedBy'
    | 'submittedAt'
    | 'approvedBy'
    | 'approvedAt'
    | 'cancelledBy'
    | 'cancelReason'
    | 'payoutRef'
    | 'payoutTransactionId'
    | 'holdId'
    | 'releasedAt'
    | 'paidAt'
    | 'failureCode'
  >
>;

export interface BatchListFilter {
  readonly merchantId?: string;
  readonly cycleId?: string;
  readonly status?: string;
  /** Statuses a caller must not see (a merchant never sees drafts). */
  readonly excludeStatuses?: readonly string[];
  readonly after?: CursorKey;
  readonly limit: number;
}

const ITEM_CHUNK = 1000;

@Injectable()
export class SettlementBatchesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewBatch): Promise<BatchRow> {
    const [row] = await tx.insert(settlementBatches).values(values).returning();
    if (!row) throw new Error('settlement batch insert returned no row');
    return row;
  }

  async insertItems(tx: Executor, items: readonly NewItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += ITEM_CHUNK) {
      await tx.insert(settlementItems).values(items.slice(i, i + ITEM_CHUNK));
    }
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<BatchRow | undefined> {
    const [row] = await executor
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.ref, ref))
      .limit(1);
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<BatchRow | undefined> {
    const [row] = await executor
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, id))
      .limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<BatchRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.ref, ref))
      .for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<BatchRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, id))
      .for('update');
    return row;
  }

  async lockByPayoutRef(tx: Executor, payoutRef: string): Promise<BatchRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.payoutRef, payoutRef))
      .for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: BatchPatch): Promise<BatchRow> {
    const [row] = await tx
      .update(settlementBatches)
      .set(patch)
      .where(eq(settlementBatches.id, id))
      .returning();
    if (!row) throw new Error('settlement batch update returned no row');
    return row;
  }

  /** The end of the merchant's latest live batch: the next batch starts there. */
  async watermark(
    tx: Executor,
    merchantId: string,
    cycleId: string,
    currency: string
  ): Promise<Date | undefined> {
    const result = await tx.execute<{ period_end: string | null }>(sql`
      select to_json(max(period_end)) #>> '{}' as period_end
        from core.settlement_batches
       where merchant_id = ${merchantId} and cycle_id = ${cycleId} and currency = ${currency}
         and status not in ('cancelled', 'failed')`);
    const value = result.rows[0]?.period_end;
    return value ? new Date(value) : undefined;
  }

  list(filter: BatchListFilter, executor: Executor = this.db): Promise<BatchRow[]> {
    const t = settlementBatches;
    const conditions: (SQL | undefined)[] = [
      filter.merchantId ? eq(t.merchantId, filter.merchantId) : undefined,
      filter.cycleId ? eq(t.cycleId, filter.cycleId) : undefined,
      filter.status ? eq(t.status, filter.status) : undefined,
      filter.excludeStatuses?.length
        ? notInArray(t.status, [...filter.excludeStatuses])
        : undefined,
      ...(filter.after ? olderThan(t.createdAt, t.ref, filter.after) : []),
    ];
    return executor
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(...newestFirst(t.createdAt, t.ref))
      .limit(filter.limit + 1);
  }

  /** Releasing batches whose payout was created before `before`: candidates for the sweep. */
  releasingBefore(before: Date, limit: number, executor: Executor = this.db): Promise<BatchRow[]> {
    return executor
      .select()
      .from(settlementBatches)
      .where(
        and(eq(settlementBatches.status, 'releasing'), lte(settlementBatches.releasedAt, before))
      )
      .orderBy(asc(settlementBatches.releasedAt))
      .limit(limit);
  }

  itemsOf(
    batchId: string,
    after: { kind: string; occurredAt: Date | null; id: string } | undefined,
    limit: number,
    executor: Executor = this.db
  ): Promise<ItemRow[]> {
    const t = settlementItems;
    return executor
      .select()
      .from(t)
      .where(
        and(
          eq(t.batchId, batchId),
          after
            ? sql`(${t.kind}, coalesce(${t.occurredAt}, 'epoch'::timestamptz), ${t.id}) > (${after.kind}, ${after.occurredAt ?? new Date(0)}, ${after.id})`
            : undefined
        )
      )
      .orderBy(asc(t.kind), sql`coalesce(${t.occurredAt}, 'epoch'::timestamptz)`, asc(t.id))
      .limit(limit + 1);
  }

  async addEvent(tx: Executor, values: typeof settlementBatchEvents.$inferInsert): Promise<void> {
    await tx.insert(settlementBatchEvents).values(values);
  }

  async hasEventKey(tx: Executor, batchId: string, eventKey: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: settlementBatchEvents.id })
      .from(settlementBatchEvents)
      .where(
        and(
          eq(settlementBatchEvents.batchId, batchId),
          eq(settlementBatchEvents.eventKey, eventKey)
        )
      )
      .limit(1);
    return row !== undefined;
  }

  eventsOf(batchId: string, executor: Executor = this.db): Promise<BatchEventRow[]> {
    return executor
      .select()
      .from(settlementBatchEvents)
      .where(eq(settlementBatchEvents.batchId, batchId))
      .orderBy(asc(settlementBatchEvents.createdAt), asc(settlementBatchEvents.id));
  }

  /** Public refs of the merchants and cycles a page of batches belongs to. */
  async refsFor(
    rows: readonly BatchRow[],
    executor: Executor = this.db
  ): Promise<{ merchants: Map<string, string>; cycles: Map<string, string> }> {
    const merchantIds = [...new Set(rows.map((r) => r.merchantId))];
    const cycleIds = [...new Set(rows.map((r) => r.cycleId))];
    const m = merchantIds.length
      ? await executor
          .select({ id: merchants.id, ref: merchants.ref })
          .from(merchants)
          .where(inArray(merchants.id, merchantIds))
      : [];
    const c = cycleIds.length
      ? await executor
          .select({ id: settlementCycles.id, ref: settlementCycles.ref })
          .from(settlementCycles)
          .where(inArray(settlementCycles.id, cycleIds))
      : [];
    return {
      merchants: new Map(m.map((x) => [x.id, x.ref])),
      cycles: new Map(c.map((x) => [x.id, x.ref])),
    };
  }

  async merchantIdByRef(ref: string, executor: Executor = this.db): Promise<string | undefined> {
    const [row] = await executor
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.ref, ref));
    return row?.id;
  }

  // ---- reserve entries ----

  /** Reserve whose hold period ended and that no batch has claimed, oldest first. */
  dueReserve(
    tx: Executor,
    merchantId: string,
    currency: string,
    asOf: Date
  ): Promise<ReserveEntryRow[]> {
    return tx
      .select()
      .from(reserveEntries)
      .where(
        and(
          eq(reserveEntries.merchantId, merchantId),
          eq(reserveEntries.currency, currency),
          isNull(reserveEntries.releasedAt),
          isNull(reserveEntries.releaseBatchId),
          lte(reserveEntries.holdUntil, asOf)
        )
      )
      .orderBy(asc(reserveEntries.holdUntil), asc(reserveEntries.id))
      .for('update');
  }

  async claimReserve(tx: Executor, ids: readonly string[], batchId: string): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(reserveEntries)
      .set({ releaseBatchId: batchId })
      .where(and(inArray(reserveEntries.id, [...ids]), isNull(reserveEntries.releasedAt)));
  }

  /** A cancelled or failed batch gives back the reserve it claimed. */
  async unclaimReserve(tx: Executor, batchId: string): Promise<void> {
    await tx
      .update(reserveEntries)
      .set({ releaseBatchId: null })
      .where(and(eq(reserveEntries.releaseBatchId, batchId), isNull(reserveEntries.releasedAt)));
  }

  async releaseClaimed(tx: Executor, batchId: string, at: Date): Promise<ReserveEntryRow[]> {
    return tx
      .update(reserveEntries)
      .set({ releasedAt: at })
      .where(and(eq(reserveEntries.releaseBatchId, batchId), isNull(reserveEntries.releasedAt)))
      .returning();
  }

  async insertReserve(tx: Executor, values: typeof reserveEntries.$inferInsert): Promise<void> {
    await tx.insert(reserveEntries).values(values);
  }

  claimedReserveOf(batchId: string, executor: Executor = this.db): Promise<ReserveEntryRow[]> {
    return executor.select().from(reserveEntries).where(eq(reserveEntries.releaseBatchId, batchId));
  }

  /** Unreleased reserve of a merchant, for the dashboard and reports. */
  openReserve(
    merchantId: string,
    currency: string,
    executor: Executor = this.db
  ): Promise<ReserveEntryRow[]> {
    return executor
      .select()
      .from(reserveEntries)
      .where(
        and(
          eq(reserveEntries.merchantId, merchantId),
          eq(reserveEntries.currency, currency),
          isNull(reserveEntries.releasedAt)
        )
      )
      .orderBy(asc(reserveEntries.holdUntil));
  }

  // ---- runs ----

  async insertRunIfNew(tx: Executor, values: NewRun): Promise<RunRow | undefined> {
    const [row] = await tx.insert(settlementRuns).values(values).onConflictDoNothing().returning();
    return row;
  }

  async lockRun(tx: Executor, cycleId: string, periodEnd: Date): Promise<RunRow | undefined> {
    const [row] = await tx
      .select()
      .from(settlementRuns)
      .where(and(eq(settlementRuns.cycleId, cycleId), eq(settlementRuns.periodEnd, periodEnd)))
      .for('update');
    return row;
  }

  async retakeRun(tx: Executor, id: string, now: Date, triggeredBy: string): Promise<RunRow> {
    const [row] = await tx
      .update(settlementRuns)
      .set({
        status: 'running',
        attempts: sql`${settlementRuns.attempts} + 1`,
        startedAt: now,
        finishedAt: null,
        triggeredBy,
      })
      .where(eq(settlementRuns.id, id))
      .returning();
    if (!row) throw new Error('settlement run retake returned no row');
    return row;
  }

  async finishRun(
    tx: Executor,
    id: string,
    patch: {
      status: 'completed' | 'failed';
      now: Date;
      merchantsConsidered: number;
      batchesCreated: number;
      rolledOver: number;
      nothingToSettle: number;
      failedMerchants: number;
      summary: Record<string, unknown>;
    }
  ): Promise<RunRow> {
    const [row] = await tx
      .update(settlementRuns)
      .set({
        status: patch.status,
        finishedAt: patch.now,
        merchantsConsidered: patch.merchantsConsidered,
        batchesCreated: patch.batchesCreated,
        rolledOver: patch.rolledOver,
        nothingToSettle: patch.nothingToSettle,
        failedMerchants: patch.failedMerchants,
        summary: patch.summary,
      })
      .where(eq(settlementRuns.id, id))
      .returning();
    if (!row) throw new Error('settlement run finish returned no row');
    return row;
  }

  async findRunByRef(ref: string, executor: Executor = this.db): Promise<RunRow | undefined> {
    const [row] = await executor.select().from(settlementRuns).where(eq(settlementRuns.ref, ref));
    return row;
  }

  listRuns(
    cycleId: string | undefined,
    limit: number,
    executor: Executor = this.db
  ): Promise<RunRow[]> {
    return executor
      .select()
      .from(settlementRuns)
      .where(cycleId ? eq(settlementRuns.cycleId, cycleId) : undefined)
      .orderBy(...newestFirst(settlementRuns.createdAt, settlementRuns.ref))
      .limit(limit);
  }
}
