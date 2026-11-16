/** SQL for `core.incidents`. Phase 6 only opens incidents; Phase 8 adds the lifecycle. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { incidents } from '../../db/schema';

export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;

@Injectable()
export class IncidentsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts, or returns undefined when an unresolved incident with the dedupe key exists. */
  async insertIfNew(tx: Executor, values: NewIncident): Promise<IncidentRow | undefined> {
    const [row] = await tx.insert(incidents).values(values).onConflictDoNothing().returning();
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

  async findByRef(ref: string, executor: Executor = this.db): Promise<IncidentRow | undefined> {
    const [row] = await executor.select().from(incidents).where(eq(incidents.ref, ref)).limit(1);
    return row;
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
}
