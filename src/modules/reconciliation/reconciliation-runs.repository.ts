/** SQL for `core.reconciliation_runs`. Runs are never deleted. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { reconciliationRuns } from '../../db/schema';

export type RunRow = typeof reconciliationRuns.$inferSelect;
export type NewRun = typeof reconciliationRuns.$inferInsert;

export interface RunListFilter {
  readonly kind?: string;
  readonly status?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class ReconciliationRunsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts the run, or returns undefined if its run key or single-flight slot is taken. */
  async insertIfFree(tx: Executor, values: NewRun): Promise<RunRow | undefined> {
    const [row] = await tx
      .insert(reconciliationRuns)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async findByKey(tx: Executor, kind: string, runKey: string): Promise<RunRow | undefined> {
    const [row] = await tx
      .select()
      .from(reconciliationRuns)
      .where(and(eq(reconciliationRuns.kind, kind), eq(reconciliationRuns.runKey, runKey)))
      .for('update');
    return row;
  }

  async findRunning(tx: Executor, kind: string, scopeKey: string): Promise<RunRow | undefined> {
    const [row] = await tx
      .select()
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.kind, kind),
          eq(reconciliationRuns.scopeKey, scopeKey),
          eq(reconciliationRuns.status, 'running')
        )
      )
      .for('update');
    return row;
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<RunRow | undefined> {
    const [row] = await executor
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.ref, ref))
      .limit(1);
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<RunRow | undefined> {
    const [row] = await executor
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, id))
      .limit(1);
    return row;
  }

  /** Marks a running run whose lease ended as failed, freeing its single-flight slot. */
  async abandon(tx: Executor, id: string, now: Date): Promise<void> {
    await tx
      .update(reconciliationRuns)
      .set({ status: 'failed', finishedAt: now, error: 'lease_expired' })
      .where(
        and(
          eq(reconciliationRuns.id, id),
          eq(reconciliationRuns.status, 'running'),
          lte(reconciliationRuns.leaseExpiresAt, now)
        )
      );
  }

  /** Takes a failed run again: same key, one more attempt. */
  async retake(
    tx: Executor,
    id: string,
    patch: { now: Date; leaseExpiresAt: Date; triggeredBy: string }
  ): Promise<RunRow | undefined> {
    const [row] = await tx
      .update(reconciliationRuns)
      .set({
        status: 'running',
        attempts: sql`${reconciliationRuns.attempts} + 1`,
        startedAt: patch.now,
        finishedAt: null,
        leaseExpiresAt: patch.leaseExpiresAt,
        triggeredBy: patch.triggeredBy,
        error: null,
      })
      .where(and(eq(reconciliationRuns.id, id), eq(reconciliationRuns.status, 'failed')))
      .returning();
    return row;
  }

  async finish(
    tx: Executor,
    id: string,
    patch: {
      status: 'completed' | 'failed';
      now: Date;
      checkedCount: number;
      matchedCount: number;
      exceptionCount: number;
      summary: Record<string, unknown>;
      error?: string;
    }
  ): Promise<RunRow> {
    const [row] = await tx
      .update(reconciliationRuns)
      .set({
        status: patch.status,
        finishedAt: patch.now,
        checkedCount: patch.checkedCount,
        matchedCount: patch.matchedCount,
        exceptionCount: patch.exceptionCount,
        summary: patch.summary,
        error: patch.error ?? null,
      })
      .where(and(eq(reconciliationRuns.id, id), eq(reconciliationRuns.status, 'running')))
      .returning();
    if (!row) throw new Error('reconciliation run is no longer running');
    return row;
  }

  list(filter: RunListFilter, executor: Executor = this.db): Promise<RunRow[]> {
    const conditions: (SQL | undefined)[] = [
      filter.kind ? eq(reconciliationRuns.kind, filter.kind) : undefined,
      filter.status ? eq(reconciliationRuns.status, filter.status) : undefined,
      ...(filter.after
        ? olderThan(reconciliationRuns.createdAt, reconciliationRuns.ref, filter.after)
        : []),
    ];
    return executor
      .select()
      .from(reconciliationRuns)
      .where(and(...conditions))
      .orderBy(...newestFirst(reconciliationRuns.createdAt, reconciliationRuns.ref))
      .limit(filter.limit + 1);
  }

  /** The newest run of each kind, for the status board. */
  async latestPerKind(executor: Executor = this.db): Promise<RunRow[]> {
    const result = await executor.execute<{ id: string }>(sql`
      select distinct on (kind) id from core.reconciliation_runs
       order by kind, started_at desc`);
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    return executor.select().from(reconciliationRuns).where(inArray(reconciliationRuns.id, ids));
  }
}
