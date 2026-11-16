/** SQL for `core.aml_cases`, its alerts' membership, notes and STR packages. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import type { CursorKey } from '../../../common/pagination/cursor';
import { amlAlerts, amlCaseNotes, amlCases, amlStrPackages, merchants } from '../../../db/schema';

export type CaseRow = typeof amlCases.$inferSelect;
export type NewCase = typeof amlCases.$inferInsert;
export type CasePatch = Partial<
  Pick<
    NewCase,
    | 'status'
    | 'severity'
    | 'title'
    | 'summary'
    | 'assignedTo'
    | 'outcome'
    | 'closedBy'
    | 'closedAt'
    | 'strFiledAt'
    | 'strReference'
  >
>;
export type NoteRow = typeof amlCaseNotes.$inferSelect;
export type StrPackageRow = typeof amlStrPackages.$inferSelect;

export interface CaseFilter {
  readonly status?: string;
  readonly merchantId?: string;
  readonly assignedTo?: string;
  readonly open?: boolean;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class AmlCasesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewCase): Promise<CaseRow> {
    const [row] = await tx.insert(amlCases).values(values).returning();
    if (!row) throw new Error('case insert returned no row');
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<CaseRow | undefined> {
    const [row] = await tx.select().from(amlCases).where(eq(amlCases.ref, ref)).limit(1);
    return row;
  }

  async findById(id: string, tx: Executor = this.db): Promise<CaseRow | undefined> {
    const [row] = await tx.select().from(amlCases).where(eq(amlCases.id, id)).limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<CaseRow | undefined> {
    const [row] = await tx.select().from(amlCases).where(eq(amlCases.ref, ref)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: CasePatch): Promise<CaseRow> {
    const [row] = await tx.update(amlCases).set(patch).where(eq(amlCases.id, id)).returning();
    if (!row) throw new Error('case update returned no row');
    return row;
  }

  /** Attaches alerts that belong to no case yet; returns the alerts it attached. */
  async attachAlerts(
    tx: Executor,
    caseId: string,
    merchantId: string,
    alertIds: readonly string[]
  ): Promise<string[]> {
    if (alertIds.length === 0) return [];
    const rows = await tx
      .update(amlAlerts)
      .set({ caseId })
      .where(
        and(
          inArray(amlAlerts.id, [...alertIds]),
          eq(amlAlerts.merchantId, merchantId),
          isNull(amlAlerts.caseId)
        )
      )
      .returning({ id: amlAlerts.id });
    return rows.map((r) => r.id);
  }

  alertsOf(caseId: string, tx: Executor = this.db) {
    return tx
      .select()
      .from(amlAlerts)
      .where(eq(amlAlerts.caseId, caseId))
      .orderBy(asc(amlAlerts.createdAt));
  }

  async insertNote(tx: Executor, values: typeof amlCaseNotes.$inferInsert): Promise<NoteRow> {
    const [row] = await tx.insert(amlCaseNotes).values(values).returning();
    if (!row) throw new Error('note insert returned no row');
    return row;
  }

  notes(caseId: string, tx: Executor = this.db): Promise<NoteRow[]> {
    return tx
      .select()
      .from(amlCaseNotes)
      .where(eq(amlCaseNotes.caseId, caseId))
      .orderBy(asc(amlCaseNotes.createdAt));
  }

  async insertStrPackage(
    tx: Executor,
    values: typeof amlStrPackages.$inferInsert
  ): Promise<StrPackageRow> {
    const [row] = await tx.insert(amlStrPackages).values(values).returning();
    if (!row) throw new Error('STR package insert returned no row');
    return row;
  }

  strPackages(caseId: string, tx: Executor = this.db): Promise<StrPackageRow[]> {
    return tx
      .select()
      .from(amlStrPackages)
      .where(eq(amlStrPackages.caseId, caseId))
      .orderBy(desc(amlStrPackages.createdAt));
  }

  list(filter: CaseFilter) {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(amlCases.status, filter.status));
    if (filter.merchantId) conditions.push(eq(amlCases.merchantId, filter.merchantId));
    if (filter.assignedTo) conditions.push(eq(amlCases.assignedTo, filter.assignedTo));
    if (filter.open) {
      const open = or(eq(amlCases.status, 'open'), eq(amlCases.status, 'investigating'));
      if (open) conditions.push(open);
    }
    if (filter.after) {
      const keyset = or(
        lt(amlCases.createdAt, filter.after.createdAt),
        and(eq(amlCases.createdAt, filter.after.createdAt), lt(amlCases.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({ row: amlCases, merchantRef: merchants.ref })
      .from(amlCases)
      .innerJoin(merchants, eq(merchants.id, amlCases.merchantId))
      .where(and(...conditions))
      .orderBy(desc(amlCases.createdAt), desc(amlCases.ref))
      .limit(filter.limit + 1);
  }
}
