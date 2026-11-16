/** SQL for `core.aml_alerts`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import type { CursorKey } from '../../../common/pagination/cursor';
import { amlAlerts, merchants, transactionKeys } from '../../../db/schema';

export type AlertRow = typeof amlAlerts.$inferSelect;
export type NewAlert = typeof amlAlerts.$inferInsert;
export type AlertPatch = Partial<
  Pick<
    NewAlert,
    | 'status'
    | 'assignedTo'
    | 'escalatedAt'
    | 'escalationReason'
    | 'resolvedBy'
    | 'resolvedAt'
    | 'resolutionNote'
    | 'holdId'
  >
>;

export interface AlertFilter {
  readonly statuses?: readonly string[];
  readonly severity?: string;
  readonly merchantId?: string;
  readonly assignedTo?: string;
  readonly ruleCode?: string;
  /** Only alerts past `due_at` and not yet escalated or closed, as of this time. */
  readonly overdueAt?: Date;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class AmlAlertsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Null when the rule already raised an alert for this transaction. */
  async insert(tx: Executor, values: NewAlert): Promise<AlertRow | null> {
    const [row] = await tx
      .insert(amlAlerts)
      .values(values)
      .onConflictDoNothing({
        target: [amlAlerts.ruleCode, amlAlerts.transactionId],
        where: sql`${amlAlerts.transactionId} is not null`,
      })
      .returning();
    return row ?? null;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<AlertRow | undefined> {
    const [row] = await tx.select().from(amlAlerts).where(eq(amlAlerts.ref, ref)).limit(1);
    return row;
  }

  async findByRuleAndTransaction(
    ruleCode: string,
    transactionId: string,
    tx: Executor = this.db
  ): Promise<AlertRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlAlerts)
      .where(and(eq(amlAlerts.ruleCode, ruleCode), eq(amlAlerts.transactionId, transactionId)))
      .limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<AlertRow | undefined> {
    const [row] = await tx.select().from(amlAlerts).where(eq(amlAlerts.ref, ref)).for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<AlertRow | undefined> {
    const [row] = await tx.select().from(amlAlerts).where(eq(amlAlerts.id, id)).for('update');
    return row;
  }

  findByRefs(merchantId: string, refs: readonly string[], tx: Executor = this.db) {
    if (refs.length === 0) return Promise.resolve([] as AlertRow[]);
    return tx
      .select()
      .from(amlAlerts)
      .where(and(eq(amlAlerts.merchantId, merchantId), inArray(amlAlerts.ref, [...refs])));
  }

  async update(tx: Executor, id: string, patch: AlertPatch): Promise<AlertRow> {
    const [row] = await tx.update(amlAlerts).set(patch).where(eq(amlAlerts.id, id)).returning();
    if (!row) throw new Error('alert update returned no row');
    return row;
  }

  /** Ids of alerts past their SLA, oldest due first. */
  async overdueIds(now: Date, limit: number, tx: Executor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ id: amlAlerts.id })
      .from(amlAlerts)
      .where(and(inArray(amlAlerts.status, ['open', 'investigating']), lte(amlAlerts.dueAt, now)))
      .orderBy(amlAlerts.dueAt)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async openCountsBySeverity(
    tx: Executor = this.db
  ): Promise<Array<{ severity: string; n: number }>> {
    const rows = await tx
      .select({ severity: amlAlerts.severity, n: sql<number>`count(*)::int` })
      .from(amlAlerts)
      .where(inArray(amlAlerts.status, ['open', 'investigating', 'escalated']))
      .groupBy(amlAlerts.severity);
    return rows;
  }

  list(filter: AlertFilter) {
    const conditions: SQL[] = [];
    if (filter.statuses?.length) conditions.push(inArray(amlAlerts.status, [...filter.statuses]));
    if (filter.severity) conditions.push(eq(amlAlerts.severity, filter.severity));
    if (filter.merchantId) conditions.push(eq(amlAlerts.merchantId, filter.merchantId));
    if (filter.assignedTo) conditions.push(eq(amlAlerts.assignedTo, filter.assignedTo));
    if (filter.ruleCode) conditions.push(eq(amlAlerts.ruleCode, filter.ruleCode));
    if (filter.overdueAt) {
      conditions.push(inArray(amlAlerts.status, ['open', 'investigating']));
      conditions.push(lte(amlAlerts.dueAt, filter.overdueAt));
    }
    if (filter.after) {
      const keyset = or(
        lt(amlAlerts.createdAt, filter.after.createdAt),
        and(eq(amlAlerts.createdAt, filter.after.createdAt), lt(amlAlerts.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({ row: amlAlerts, merchantRef: merchants.ref, transactionRef: transactionKeys.ref })
      .from(amlAlerts)
      .innerJoin(merchants, eq(merchants.id, amlAlerts.merchantId))
      .leftJoin(transactionKeys, eq(transactionKeys.id, amlAlerts.transactionId))
      .where(and(...conditions))
      .orderBy(desc(amlAlerts.createdAt), desc(amlAlerts.ref))
      .limit(filter.limit + 1);
  }

  async detail(ref: string, tx: Executor = this.db) {
    const [found] = await tx
      .select({ row: amlAlerts, merchantRef: merchants.ref, transactionRef: transactionKeys.ref })
      .from(amlAlerts)
      .innerJoin(merchants, eq(merchants.id, amlAlerts.merchantId))
      .leftJoin(transactionKeys, eq(transactionKeys.id, amlAlerts.transactionId))
      .where(eq(amlAlerts.ref, ref))
      .limit(1);
    return found;
  }
}
