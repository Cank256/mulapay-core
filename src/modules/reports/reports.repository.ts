/** SQL for `core.reports`, `core.report_schedules` and their run history. */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { merchants, reportScheduleRuns, reportSchedules, reports, users } from '../../db/schema';

export type ReportRow = typeof reports.$inferSelect;
export type ScheduleRow = typeof reportSchedules.$inferSelect;
export type RunRow = typeof reportScheduleRuns.$inferSelect;
export type ReportPatch = Partial<
  Pick<
    typeof reports.$inferInsert,
    | 'status'
    | 'rowCount'
    | 'fileKey'
    | 'fileSize'
    | 'sha256'
    | 'attempts'
    | 'leaseExpiresAt'
    | 'startedAt'
    | 'finishedAt'
    | 'expiresAt'
    | 'error'
  >
>;
export type SchedulePatch = Partial<
  Pick<
    typeof reportSchedules.$inferInsert,
    | 'params'
    | 'period'
    | 'cron'
    | 'timezone'
    | 'recipients'
    | 'format'
    | 'active'
    | 'lastRunAt'
    | 'nextRunAt'
    | 'lastStatus'
    | 'consecutiveFailures'
    | 'disabledReason'
    | 'deletedAt'
  >
>;

/** Reports a staff member asked for: what the admin console may list and download. */
function staffRequested(): SQL {
  return sql`exists (select 1 from core.users u where u.id = ${reports.requestedBy} and u.type = 'staff')`;
}

export interface ReportWithRefs {
  readonly row: ReportRow;
  readonly merchantRef: string | null;
}

@Injectable()
export class ReportsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: typeof reports.$inferInsert): Promise<ReportRow> {
    const [row] = await tx.insert(reports).values(values).returning();
    if (!row) throw new Error('report insert returned no row');
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<ReportRow | undefined> {
    const [row] = await tx.select().from(reports).where(eq(reports.ref, ref)).for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<ReportRow | undefined> {
    const [row] = await tx.select().from(reports).where(eq(reports.id, id)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: ReportPatch): Promise<ReportRow> {
    const [row] = await tx.update(reports).set(patch).where(eq(reports.id, id)).returning();
    if (!row) throw new Error('report update returned no row');
    return row;
  }

  async findByRef(
    ref: string,
    filter: {
      merchantId?: string;
      environment?: string;
      platformOnly?: boolean;
      staffOnly?: boolean;
    } = {},
    tx: Executor = this.db
  ): Promise<ReportWithRefs | undefined> {
    const conditions: SQL[] = [eq(reports.ref, ref)];
    if (filter.staffOnly) conditions.push(staffRequested());
    if (filter.merchantId) conditions.push(eq(reports.merchantId, filter.merchantId));
    if (filter.environment) conditions.push(eq(reports.environment, filter.environment));
    if (filter.platformOnly) conditions.push(isNull(reports.merchantId));
    const [found] = await tx
      .select({ row: reports, merchantRef: merchants.ref })
      .from(reports)
      .leftJoin(merchants, eq(merchants.id, reports.merchantId))
      .where(and(...conditions))
      .limit(1);
    return found;
  }

  list(filter: {
    merchantId?: string;
    environment?: string;
    platform?: boolean;
    staffOnly?: boolean;
    type?: string;
    status?: string;
    after?: CursorKey;
    limit: number;
  }): Promise<ReportWithRefs[]> {
    const conditions: SQL[] = [];
    if (filter.staffOnly) conditions.push(staffRequested());
    if (filter.merchantId) conditions.push(eq(reports.merchantId, filter.merchantId));
    if (filter.environment) conditions.push(eq(reports.environment, filter.environment));
    if (filter.platform) conditions.push(isNull(reports.merchantId));
    if (filter.type) conditions.push(eq(reports.type, filter.type));
    if (filter.status) conditions.push(eq(reports.status, filter.status));
    if (filter.after) {
      const keyset = or(
        lt(reports.createdAt, filter.after.createdAt),
        and(eq(reports.createdAt, filter.after.createdAt), lt(reports.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({ row: reports, merchantRef: merchants.ref })
      .from(reports)
      .leftJoin(merchants, eq(merchants.id, reports.merchantId))
      .where(and(...conditions))
      .orderBy(desc(reports.createdAt), desc(reports.ref))
      .limit(filter.limit + 1);
  }

  /** Reports a merchant has queued or running: the concurrency limit. */
  async activeCount(tx: Executor, merchantId: string | null, requestedBy: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(reports)
      .where(
        and(
          merchantId ? eq(reports.merchantId, merchantId) : isNull(reports.merchantId),
          merchantId ? undefined : eq(reports.requestedBy, requestedBy),
          inArray(reports.status, ['queued', 'running'])
        )
      );
    return row?.n ?? 0;
  }

  async settlementExists(tx: Executor, merchantId: string, ref: string): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      select id from core.settlement_batches where merchant_id = ${merchantId} and ref = ${ref}`);
    return result.rows.length > 0;
  }

  /** Ready reports whose files have outlived their seven days. */
  expired(now: Date, limit: number): Promise<ReportRow[]> {
    return this.db
      .select()
      .from(reports)
      .where(and(eq(reports.status, 'ready'), lte(reports.expiresAt, now)))
      .orderBy(asc(reports.expiresAt))
      .limit(limit);
  }

  // -- schedules ---------------------------------------------------------------------------

  async insertSchedule(
    tx: Executor,
    values: typeof reportSchedules.$inferInsert
  ): Promise<ScheduleRow> {
    const [row] = await tx.insert(reportSchedules).values(values).returning();
    if (!row) throw new Error('schedule insert returned no row');
    return row;
  }

  async lockSchedule(tx: Executor, ref: string): Promise<ScheduleRow | undefined> {
    const [row] = await tx
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.ref, ref), isNull(reportSchedules.deletedAt)))
      .for('update');
    return row;
  }

  async lockScheduleById(tx: Executor, id: string): Promise<ScheduleRow | undefined> {
    const [row] = await tx
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, id))
      .for('update');
    return row;
  }

  async updateSchedule(tx: Executor, id: string, patch: SchedulePatch): Promise<ScheduleRow> {
    const [row] = await tx
      .update(reportSchedules)
      .set(patch)
      .where(eq(reportSchedules.id, id))
      .returning();
    if (!row) throw new Error('schedule update returned no row');
    return row;
  }

  async findSchedule(
    ref: string,
    filter: { merchantId?: string; environment?: string; platformOnly?: boolean } = {},
    tx: Executor = this.db
  ): Promise<ScheduleRow | undefined> {
    const conditions: SQL[] = [eq(reportSchedules.ref, ref), isNull(reportSchedules.deletedAt)];
    if (filter.merchantId) conditions.push(eq(reportSchedules.merchantId, filter.merchantId));
    if (filter.environment) conditions.push(eq(reportSchedules.environment, filter.environment));
    if (filter.platformOnly) conditions.push(isNull(reportSchedules.merchantId));
    const [row] = await tx
      .select()
      .from(reportSchedules)
      .where(and(...conditions))
      .limit(1);
    return row;
  }

  listSchedules(filter: {
    merchantId?: string;
    environment?: string;
    platform?: boolean;
    after?: CursorKey;
    limit: number;
  }): Promise<ScheduleRow[]> {
    const conditions: SQL[] = [isNull(reportSchedules.deletedAt)];
    if (filter.merchantId) conditions.push(eq(reportSchedules.merchantId, filter.merchantId));
    if (filter.environment) conditions.push(eq(reportSchedules.environment, filter.environment));
    if (filter.platform) conditions.push(isNull(reportSchedules.merchantId));
    if (filter.after) {
      const keyset = or(
        lt(reportSchedules.createdAt, filter.after.createdAt),
        and(
          eq(reportSchedules.createdAt, filter.after.createdAt),
          lt(reportSchedules.ref, filter.after.id)
        )
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select()
      .from(reportSchedules)
      .where(and(...conditions))
      .orderBy(desc(reportSchedules.createdAt), desc(reportSchedules.ref))
      .limit(filter.limit + 1);
  }

  /** Active schedules whose next run time has come. */
  dueSchedules(now: Date, limit: number): Promise<Array<{ ref: string }>> {
    return this.db
      .select({ ref: reportSchedules.ref })
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.active, true),
          isNull(reportSchedules.deletedAt),
          lte(reportSchedules.nextRunAt, now)
        )
      )
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(limit);
  }

  async insertRun(
    tx: Executor,
    values: typeof reportScheduleRuns.$inferInsert
  ): Promise<RunRow | undefined> {
    const [row] = await tx
      .insert(reportScheduleRuns)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async runForReport(tx: Executor, reportId: string): Promise<RunRow | undefined> {
    const [row] = await tx
      .select()
      .from(reportScheduleRuns)
      .where(eq(reportScheduleRuns.reportId, reportId))
      .for('update');
    return row;
  }

  async updateRun(
    tx: Executor,
    id: string,
    patch: Partial<Pick<RunRow, 'status' | 'error' | 'finishedAt' | 'reportId'>>
  ): Promise<void> {
    await tx.update(reportScheduleRuns).set(patch).where(eq(reportScheduleRuns.id, id));
  }

  history(scheduleId: string, limit: number): Promise<RunRow[]> {
    return this.db
      .select()
      .from(reportScheduleRuns)
      .where(eq(reportScheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(reportScheduleRuns.dueAt))
      .limit(limit);
  }

  /** Active members' emails of a merchant, to check a schedule's recipients. */
  async memberEmails(
    tx: Executor,
    merchantId: string,
    emails: readonly string[]
  ): Promise<string[]> {
    if (emails.length === 0) return [];
    const result = await tx.execute<{ email: string }>(sql`
      select u.email::text as email from core.merchant_members m
        join core.users u on u.id = m.user_id and u.status = 'active'
       where m.merchant_id = ${merchantId} and m.status = 'active'
         and lower(u.email::text) in (select lower(jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb)))`);
    return result.rows.map((r) => r.email.toLowerCase());
  }

  async staffEmails(tx: Executor, emails: readonly string[]): Promise<string[]> {
    if (emails.length === 0) return [];
    const result = await tx.execute<{ email: string }>(sql`
      select u.email::text as email from core.users u
       where u.status = 'active' and u.type = 'staff'
         and lower(u.email::text) in (select lower(jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb)))`);
    return result.rows.map((r) => r.email.toLowerCase());
  }

  /** User ids behind recipient emails, for notifications. */
  async userIdsByEmail(tx: Executor, emails: readonly string[]): Promise<string[]> {
    if (emails.length === 0) return [];
    const result = await tx.execute<{ id: string }>(sql`
      select u.id from core.users u
       where u.status = 'active'
         and lower(u.email::text) in (select lower(jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb)))`);
    return result.rows.map((r) => r.id);
  }

  async userRef(id: string | null, tx: Executor = this.db): Promise<string | null> {
    if (!id) return null;
    const [row] = await tx.select({ ref: users.ref }).from(users).where(eq(users.id, id)).limit(1);
    return row?.ref ?? null;
  }
}
