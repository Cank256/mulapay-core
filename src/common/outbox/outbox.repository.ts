/** SQL for `core.outbox` (spec 5.2, 8.8). */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { outbox } from '../../db/schema';
import type { Executor } from '../db/database.types';
import { DB_RW } from '../db/tokens';

export type OutboxRow = typeof outbox.$inferSelect;

/** Rows that used this many attempts stay in the table for an operator (spec 8.8). */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** A claim older than this is abandoned by its worker and may be taken again (spec 8.8). */
export const OUTBOX_CLAIM_SECONDS = 60;

@Injectable()
export class OutboxRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts a row; a second insert with the same dedupe key is ignored. True if inserted. */
  async insert(tx: Executor, row: typeof outbox.$inferInsert): Promise<boolean> {
    const inserted = await tx
      .insert(outbox)
      .values(row)
      .onConflictDoNothing({ target: outbox.dedupeKey })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }

  /**
   * Claims up to `limit` due rows with `FOR UPDATE SKIP LOCKED`, so concurrent dispatchers
   * never take the same row, and counts the attempt. A row claimed more than
   * OUTBOX_CLAIM_SECONDS ago is taken again: its worker died. Only rows of `eventTypes`
   * are claimed, so a dispatcher never touches (or fails) a row it has no handler for.
   */
  async claim(
    now: Date,
    worker: string,
    limit: number,
    eventTypes: readonly string[]
  ): Promise<OutboxRow[]> {
    if (eventTypes.length === 0) return [];
    const result = await this.db.execute<Record<string, unknown>>(sql`
      update core.outbox o
         set locked_at = ${now}, locked_by = ${worker}, attempts = o.attempts + 1
       where o.id in (
         select id from core.outbox
          where published_at is null
            and available_at <= ${now}
            and attempts < ${OUTBOX_MAX_ATTEMPTS}
            and event_type in (${sql.join(
              eventTypes.map((type) => sql`${type}`),
              sql`, `
            )})
            and (locked_at is null or locked_at < ${now}::timestamptz - make_interval(secs => ${OUTBOX_CLAIM_SECONDS}))
          order by available_at
          limit ${limit}
          for update skip locked)
      returning o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.dedupe_key,
                o.available_at, o.attempts, o.locked_at, o.locked_by, o.published_at,
                o.last_error, o.created_at`);
    return result.rows.map(toRow);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.db.execute(
      sql`update core.outbox set published_at = ${at}, last_error = null where id = ${id}`
    );
  }

  /** Releases the claim and schedules the next try. */
  async markFailed(id: string, error: string, retryAt: Date): Promise<void> {
    await this.db.execute(sql`
      update core.outbox
         set locked_at = null, locked_by = null, last_error = ${error.slice(0, 500)},
             available_at = ${retryAt}
       where id = ${id} and published_at is null`);
  }

  /** Rows waiting or stuck, for the dispatcher's metrics and the operations runbook. */
  async pendingCount(): Promise<{ pending: number; exhausted: number }> {
    const result = await this.db.execute<{ pending: string; exhausted: string }>(sql`
      select count(*) filter (where attempts < ${OUTBOX_MAX_ATTEMPTS}) as pending,
             count(*) filter (where attempts >= ${OUTBOX_MAX_ATTEMPTS}) as exhausted
        from core.outbox where published_at is null`);
    const row = result.rows[0];
    return { pending: Number(row?.pending ?? 0), exhausted: Number(row?.exhausted ?? 0) };
  }
}

function toRow(raw: Record<string, unknown>): OutboxRow {
  return {
    id: raw.id as string,
    aggregateType: raw.aggregate_type as string,
    aggregateId: raw.aggregate_id as string,
    eventType: raw.event_type as string,
    payload: raw.payload,
    dedupeKey: raw.dedupe_key as string,
    availableAt: new Date(raw.available_at as string),
    attempts: raw.attempts as number,
    lockedAt: raw.locked_at ? new Date(raw.locked_at as string) : null,
    lockedBy: raw.locked_by as string | null,
    publishedAt: raw.published_at ? new Date(raw.published_at as string) : null,
    lastError: raw.last_error as string | null,
    createdAt: new Date(raw.created_at as string),
  };
}
