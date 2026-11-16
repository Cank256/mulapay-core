/** SQL for `core.incidents`, their updates and postmortems. */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { incidentPostmortems, incidentUpdates, incidents, merchants, users } from '../../db/schema';

export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
export type UpdateRow = typeof incidentUpdates.$inferSelect;
export type PostmortemRow = typeof incidentPostmortems.$inferSelect;
export type IncidentPatch = Partial<
  Pick<
    NewIncident,
    | 'title'
    | 'severity'
    | 'status'
    | 'impact'
    | 'affectedServices'
    | 'affectedMerchants'
    | 'commander'
    | 'public'
    | 'publicMessage'
    | 'resolvedAt'
  >
>;

export interface IncidentFilter {
  readonly status?: string;
  readonly open?: boolean;
  readonly severity?: string;
  readonly source?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class IncidentsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts, or returns undefined when an unresolved incident with the dedupe key exists. */
  async insertIfNew(tx: Executor, values: NewIncident): Promise<IncidentRow | undefined> {
    const [row] = await tx.insert(incidents).values(values).onConflictDoNothing().returning();
    return row;
  }

  async insert(tx: Executor, values: NewIncident): Promise<IncidentRow> {
    const [row] = await tx.insert(incidents).values(values).returning();
    if (!row) throw new Error('incident insert returned no row');
    return row;
  }

  /** Records that the open incident for `dedupeKey` was detected again. */
  async touch(tx: Executor, dedupeKey: string, at: Date): Promise<IncidentRow | undefined> {
    const [row] = await tx
      .update(incidents)
      .set({
        detectionCount: sql`${incidents.detectionCount} + 1`,
        lastDetectedAt: at,
      })
      .where(and(eq(incidents.dedupeKey, dedupeKey), ne(incidents.status, 'resolved')))
      .returning();
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<IncidentRow | undefined> {
    const [row] = await tx.select().from(incidents).where(eq(incidents.ref, ref)).for('update');
    return row;
  }

  async lockByDedupeKey(tx: Executor, dedupeKey: string): Promise<IncidentRow | undefined> {
    const [row] = await tx
      .select()
      .from(incidents)
      .where(and(eq(incidents.dedupeKey, dedupeKey), ne(incidents.status, 'resolved')))
      .for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: IncidentPatch): Promise<IncidentRow> {
    const [row] = await tx.update(incidents).set(patch).where(eq(incidents.id, id)).returning();
    if (!row) throw new Error('incident update returned no row');
    return row;
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<IncidentRow | undefined> {
    const [row] = await executor.select().from(incidents).where(eq(incidents.ref, ref)).limit(1);
    return row;
  }

  /** True when an unresolved incident exists whose dedupe key starts with `prefix`. */
  async hasOpenWithPrefix(prefix: string, executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(like(incidents.dedupeKey, `${prefix}%`), ne(incidents.status, 'resolved')))
      .limit(1);
    return row !== undefined;
  }

  async listOpen(
    severity: string | undefined,
    limit: number,
    executor: Executor = this.db
  ): Promise<IncidentRow[]> {
    return executor
      .select()
      .from(incidents)
      .where(
        and(
          ne(incidents.status, 'resolved'),
          severity ? eq(incidents.severity, severity) : undefined
        )
      )
      .orderBy(sql`${incidents.detectedAt} desc`)
      .limit(limit);
  }

  list(filter: IncidentFilter): Promise<Array<{ row: IncidentRow; commanderRef: string | null }>> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(incidents.status, filter.status));
    if (filter.open === true) conditions.push(ne(incidents.status, 'resolved'));
    if (filter.open === false) conditions.push(eq(incidents.status, 'resolved'));
    if (filter.severity) conditions.push(eq(incidents.severity, filter.severity));
    if (filter.source) conditions.push(eq(incidents.source, filter.source));
    if (filter.after) {
      const keyset = or(
        lt(incidents.detectedAt, filter.after.createdAt),
        and(eq(incidents.detectedAt, filter.after.createdAt), lt(incidents.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({ row: incidents, commanderRef: users.ref })
      .from(incidents)
      .leftJoin(users, eq(users.id, incidents.commander))
      .where(and(...conditions))
      .orderBy(desc(incidents.detectedAt), desc(incidents.ref))
      .limit(filter.limit + 1);
  }

  async commanderRef(id: string | null, executor: Executor = this.db): Promise<string | null> {
    if (!id) return null;
    const [row] = await executor
      .select({ ref: users.ref })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row?.ref ?? null;
  }

  async merchantRefs(ids: readonly string[], executor: Executor = this.db): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await executor
      .select({ ref: merchants.ref })
      .from(merchants)
      .where(inArray(merchants.id, [...ids]));
    return rows.map((r) => r.ref).sort();
  }

  async merchantIds(refs: readonly string[], executor: Executor = this.db): Promise<string[]> {
    if (refs.length === 0) return [];
    const rows = await executor
      .select({ id: merchants.id })
      .from(merchants)
      .where(inArray(merchants.ref, [...refs]));
    return rows.map((r) => r.id);
  }

  async insertUpdate(
    tx: Executor,
    values: typeof incidentUpdates.$inferInsert
  ): Promise<UpdateRow> {
    // A timeline is read by time: an entry written in the same millisecond as the one before it
    // (a status change right after the opening, say) still comes after it.
    const [latest] = await tx
      .select({ at: max(incidentUpdates.createdAt) })
      .from(incidentUpdates)
      .where(eq(incidentUpdates.incidentId, values.incidentId));
    const createdAt =
      values.createdAt instanceof Date && latest?.at && latest.at >= values.createdAt
        ? new Date(latest.at.getTime() + 1)
        : values.createdAt;
    const [row] = await tx
      .insert(incidentUpdates)
      .values({ ...values, createdAt })
      .returning();
    if (!row) throw new Error('incident update insert returned no row');
    return row;
  }

  updates(
    incidentId: string,
    options: { publicOnly: boolean }
  ): Promise<Array<{ row: UpdateRow; authorRef: string | null }>> {
    return this.db
      .select({ row: incidentUpdates, authorRef: users.ref })
      .from(incidentUpdates)
      .leftJoin(users, eq(users.id, incidentUpdates.authorId))
      .where(
        and(
          eq(incidentUpdates.incidentId, incidentId),
          options.publicOnly ? eq(incidentUpdates.public, true) : undefined
        )
      )
      .orderBy(asc(incidentUpdates.createdAt), asc(incidentUpdates.id));
  }

  /** Public updates of many incidents at once (no N+1 on the status feed). */
  publicUpdatesOf(incidentIds: readonly string[]): Promise<UpdateRow[]> {
    if (incidentIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(incidentUpdates)
      .where(
        and(inArray(incidentUpdates.incidentId, [...incidentIds]), eq(incidentUpdates.public, true))
      )
      .orderBy(asc(incidentUpdates.createdAt), asc(incidentUpdates.id));
  }

  /** Public incidents that are open, or were resolved since `resolvedSince`. */
  publicIncidents(resolvedSince: Date): Promise<IncidentRow[]> {
    return this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.public, true),
          or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, resolvedSince))
        )
      )
      .orderBy(desc(incidents.detectedAt))
      .limit(50);
  }

  async lockPostmortem(tx: Executor, incidentId: string): Promise<PostmortemRow | undefined> {
    const [row] = await tx
      .select()
      .from(incidentPostmortems)
      .where(eq(incidentPostmortems.incidentId, incidentId))
      .for('update');
    return row;
  }

  async postmortem(
    incidentId: string,
    executor: Executor = this.db
  ): Promise<PostmortemRow | undefined> {
    const [row] = await executor
      .select()
      .from(incidentPostmortems)
      .where(eq(incidentPostmortems.incidentId, incidentId))
      .limit(1);
    return row;
  }

  async insertPostmortem(
    tx: Executor,
    values: typeof incidentPostmortems.$inferInsert
  ): Promise<PostmortemRow> {
    const [row] = await tx.insert(incidentPostmortems).values(values).returning();
    if (!row) throw new Error('postmortem insert returned no row');
    return row;
  }

  async updatePostmortem(
    tx: Executor,
    id: string,
    patch: Partial<
      Pick<
        typeof incidentPostmortems.$inferInsert,
        'summary' | 'rootCause' | 'timeline' | 'actionItems' | 'publishedAt'
      >
    >
  ): Promise<PostmortemRow> {
    const [row] = await tx
      .update(incidentPostmortems)
      .set(patch)
      .where(eq(incidentPostmortems.id, id))
      .returning();
    if (!row) throw new Error('postmortem update returned no row');
    return row;
  }
}
