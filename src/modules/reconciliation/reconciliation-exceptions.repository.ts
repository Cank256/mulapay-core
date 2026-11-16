/**
 * SQL for the exception queue: `reconciliation_exceptions`, its notes and resolution
 * requests. Exceptions are never deleted; a resolved one never changes (database guard).
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import {
  reconciliationExceptionNotes,
  reconciliationExceptions,
  reconciliationResolutionRequests,
} from '../../db/schema';

export type ExceptionRow = typeof reconciliationExceptions.$inferSelect;
export type NewException = typeof reconciliationExceptions.$inferInsert;
export type NoteRow = typeof reconciliationExceptionNotes.$inferSelect;
export type ResolutionRequestRow = typeof reconciliationResolutionRequests.$inferSelect;
export type NewResolutionRequest = typeof reconciliationResolutionRequests.$inferInsert;

export interface ExceptionListFilter {
  readonly status?: string;
  readonly openOnly?: boolean;
  readonly kind?: string;
  readonly severity?: string;
  readonly assignedTo?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

export interface OpenCount {
  readonly kind: string;
  readonly severity: string;
  readonly count: number;
}

@Injectable()
export class ReconciliationExceptionsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts a new exception, or undefined when an open one has the same dedupe key. */
  async insertIfNew(tx: Executor, values: NewException): Promise<ExceptionRow | undefined> {
    const [row] = await tx
      .insert(reconciliationExceptions)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** The same discrepancy seen again: counts it and refreshes what was observed. */
  async markSeenAgain(
    tx: Executor,
    dedupeKey: string,
    seen: { runId: string; at: Date; actual: Record<string, unknown>; amountMinor: bigint | null }
  ): Promise<ExceptionRow | undefined> {
    const [row] = await tx
      .update(reconciliationExceptions)
      .set({
        occurrences: sql`${reconciliationExceptions.occurrences} + 1`,
        lastSeenAt: seen.at,
        lastRunId: seen.runId,
        actual: seen.actual,
        amountMinor: seen.amountMinor,
      })
      .where(
        and(
          eq(reconciliationExceptions.dedupeKey, dedupeKey),
          inArray(reconciliationExceptions.status, ['open', 'investigating'])
        )
      )
      .returning();
    return row;
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<ExceptionRow | undefined> {
    const [row] = await executor
      .select()
      .from(reconciliationExceptions)
      .where(eq(reconciliationExceptions.ref, ref))
      .limit(1);
    return row;
  }

  async refById(tx: Executor, id: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ ref: reconciliationExceptions.ref })
      .from(reconciliationExceptions)
      .where(eq(reconciliationExceptions.id, id));
    return row?.ref;
  }

  async lockByRef(tx: Executor, ref: string): Promise<ExceptionRow | undefined> {
    const [row] = await tx
      .select()
      .from(reconciliationExceptions)
      .where(eq(reconciliationExceptions.ref, ref))
      .for('update');
    return row;
  }

  async update(
    tx: Executor,
    id: string,
    patch: Partial<
      Pick<
        NewException,
        | 'status'
        | 'assignedTo'
        | 'assignedAt'
        | 'resolution'
        | 'resolutionNote'
        | 'resolvedBy'
        | 'resolvedAt'
        | 'resolutionEntryRef'
      >
    >
  ): Promise<ExceptionRow> {
    const [row] = await tx
      .update(reconciliationExceptions)
      .set(patch)
      .where(eq(reconciliationExceptions.id, id))
      .returning();
    if (!row) throw new Error('exception update returned no row');
    return row;
  }

  list(filter: ExceptionListFilter, executor: Executor = this.db): Promise<ExceptionRow[]> {
    const t = reconciliationExceptions;
    const conditions: (SQL | undefined)[] = [
      filter.status ? eq(t.status, filter.status) : undefined,
      filter.openOnly ? inArray(t.status, ['open', 'investigating']) : undefined,
      filter.kind ? eq(t.kind, filter.kind) : undefined,
      filter.severity ? eq(t.severity, filter.severity) : undefined,
      filter.assignedTo ? eq(t.assignedTo, filter.assignedTo) : undefined,
      ...(filter.after ? olderThan(t.createdAt, t.ref, filter.after) : []),
    ];
    return executor
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(...newestFirst(t.createdAt, t.ref))
      .limit(filter.limit + 1);
  }

  /** Open and investigating exceptions by kind and severity. */
  async openCounts(executor: Executor = this.db): Promise<OpenCount[]> {
    const result = await executor.execute<{ kind: string; severity: string; count: number }>(sql`
      select kind, severity, count(*)::int as count
        from core.reconciliation_exceptions
       where status in ('open', 'investigating')
       group by kind, severity`);
    return result.rows;
  }

  /** The oldest open exception's age basis, for "unresolved discrepancies" reporting. */
  async oldestOpen(executor: Executor = this.db): Promise<Date | undefined> {
    const result = await executor.execute<{ first_seen_at: string | null }>(sql`
      select min(first_seen_at)::text as first_seen_at
        from core.reconciliation_exceptions where status in ('open', 'investigating')`);
    const value = result.rows[0]?.first_seen_at;
    return value ? new Date(value) : undefined;
  }

  async addNote(
    tx: Executor,
    values: typeof reconciliationExceptionNotes.$inferInsert
  ): Promise<NoteRow> {
    const [row] = await tx.insert(reconciliationExceptionNotes).values(values).returning();
    if (!row) throw new Error('note insert returned no row');
    return row;
  }

  listNotes(exceptionId: string, executor: Executor = this.db): Promise<NoteRow[]> {
    return executor
      .select()
      .from(reconciliationExceptionNotes)
      .where(eq(reconciliationExceptionNotes.exceptionId, exceptionId))
      .orderBy(reconciliationExceptionNotes.createdAt, reconciliationExceptionNotes.id);
  }

  async insertRequest(tx: Executor, values: NewResolutionRequest): Promise<ResolutionRequestRow> {
    const [row] = await tx.insert(reconciliationResolutionRequests).values(values).returning();
    if (!row) throw new Error('resolution request insert returned no row');
    return row;
  }

  async lockRequestByRef(tx: Executor, ref: string): Promise<ResolutionRequestRow | undefined> {
    const [row] = await tx
      .select()
      .from(reconciliationResolutionRequests)
      .where(eq(reconciliationResolutionRequests.ref, ref))
      .for('update');
    return row;
  }

  async decideRequest(
    tx: Executor,
    id: string,
    patch: {
      status: 'approved' | 'rejected';
      decidedBy: string;
      decidedAt: Date;
      decisionNote: string | null;
      entryRef: string | null;
    }
  ): Promise<ResolutionRequestRow> {
    const [row] = await tx
      .update(reconciliationResolutionRequests)
      .set(patch)
      .where(eq(reconciliationResolutionRequests.id, id))
      .returning();
    if (!row) throw new Error('resolution request update returned no row');
    return row;
  }

  requestsForException(
    exceptionId: string,
    executor: Executor = this.db
  ): Promise<ResolutionRequestRow[]> {
    return executor
      .select()
      .from(reconciliationResolutionRequests)
      .where(eq(reconciliationResolutionRequests.exceptionId, exceptionId))
      .orderBy(desc(reconciliationResolutionRequests.requestedAt));
  }

  listPendingRequests(
    limit: number,
    executor: Executor = this.db
  ): Promise<ResolutionRequestRow[]> {
    return executor
      .select()
      .from(reconciliationResolutionRequests)
      .where(eq(reconciliationResolutionRequests.status, 'pending'))
      .orderBy(desc(reconciliationResolutionRequests.requestedAt))
      .limit(limit);
  }

  /** Resolved and written-off exceptions, newest resolution first: the resolution history. */
  history(limit: number, executor: Executor = this.db): Promise<ExceptionRow[]> {
    return executor
      .select()
      .from(reconciliationExceptions)
      .where(inArray(reconciliationExceptions.status, ['resolved', 'written_off']))
      .orderBy(desc(reconciliationExceptions.resolvedAt))
      .limit(limit);
  }
}
