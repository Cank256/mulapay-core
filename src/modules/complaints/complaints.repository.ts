/** SQL for `core.complaints` and its messages. Merchant reads take the merchant's id (spec 8.4). */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import {
  complaintCategories,
  complaintMessages,
  complaints,
  merchants,
  transactionKeys,
  users,
} from '../../db/schema';

export type ComplaintRow = typeof complaints.$inferSelect;
export type NewComplaint = typeof complaints.$inferInsert;
export type MessageRow = typeof complaintMessages.$inferSelect;
export type CategoryRow = typeof complaintCategories.$inferSelect;
export type ComplaintPatch = Partial<
  Pick<
    NewComplaint,
    | 'status'
    | 'priority'
    | 'assignedTo'
    | 'assignedAt'
    | 'escalatedAt'
    | 'escalationReason'
    | 'resolution'
    | 'resolvedAt'
    | 'resolvedBy'
    | 'closedAt'
    | 'satisfactionScore'
    | 'breached'
    | 'breachedAt'
    | 'breachNotifiedAt'
  >
>;

export interface ComplaintWithRefs {
  readonly row: ComplaintRow;
  readonly merchantRef: string | null;
  readonly transactionRef: string | null;
  readonly assigneeRef: string | null;
}

export interface ComplaintFilter {
  /** Set for a merchant: only its own, and only complaints it can see (not customer-sourced). */
  readonly merchantId?: string;
  readonly merchantOnlyVisible?: boolean;
  readonly status?: string;
  readonly category?: string;
  readonly priority?: string;
  readonly assignedTo?: string;
  readonly unassigned?: boolean;
  readonly breached?: boolean;
  readonly source?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer', 'escalated'];

@Injectable()
export class ComplaintsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async category(code: string, tx: Executor = this.db): Promise<CategoryRow | undefined> {
    const [row] = await tx
      .select()
      .from(complaintCategories)
      .where(eq(complaintCategories.code, code))
      .limit(1);
    return row;
  }

  listCategories(onlyActive: boolean): Promise<CategoryRow[]> {
    return this.db
      .select()
      .from(complaintCategories)
      .where(onlyActive ? eq(complaintCategories.active, true) : undefined)
      .orderBy(asc(complaintCategories.code));
  }

  async insert(tx: Executor, values: NewComplaint): Promise<ComplaintRow> {
    const [row] = await tx.insert(complaints).values(values).returning();
    if (!row) throw new Error('complaint insert returned no row');
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<ComplaintRow | undefined> {
    const [row] = await tx.select().from(complaints).where(eq(complaints.ref, ref)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: ComplaintPatch): Promise<ComplaintRow> {
    const [row] = await tx.update(complaints).set(patch).where(eq(complaints.id, id)).returning();
    if (!row) throw new Error('complaint update returned no row');
    return row;
  }

  async insertMessage(
    tx: Executor,
    values: typeof complaintMessages.$inferInsert
  ): Promise<MessageRow> {
    // A thread is read by time: a reply written in the same millisecond as the message before it still comes after it.
    const [latest] = await tx
      .select({ at: max(complaintMessages.createdAt) })
      .from(complaintMessages)
      .where(eq(complaintMessages.complaintId, values.complaintId));
    const createdAt =
      values.createdAt instanceof Date && latest?.at && latest.at >= values.createdAt
        ? new Date(latest.at.getTime() + 1)
        : values.createdAt;
    const [row] = await tx
      .insert(complaintMessages)
      .values({ ...values, createdAt })
      .returning();
    if (!row) throw new Error('message insert returned no row');
    return row;
  }

  /** The thread, oldest first. A merchant never receives internal notes. */
  messages(
    complaintId: string,
    includeInternal: boolean
  ): Promise<Array<{ row: MessageRow; authorRef: string | null }>> {
    return this.db
      .select({ row: complaintMessages, authorRef: users.ref })
      .from(complaintMessages)
      .leftJoin(users, eq(users.id, complaintMessages.authorId))
      .where(
        and(
          eq(complaintMessages.complaintId, complaintId),
          includeInternal ? undefined : eq(complaintMessages.internal, false)
        )
      )
      .orderBy(asc(complaintMessages.createdAt), asc(complaintMessages.id));
  }

  private base(tx: Executor) {
    return tx
      .select({
        row: complaints,
        merchantRef: merchants.ref,
        transactionRef: transactionKeys.ref,
        assigneeRef: users.ref,
      })
      .from(complaints)
      .leftJoin(merchants, eq(merchants.id, complaints.merchantId))
      .leftJoin(transactionKeys, eq(transactionKeys.id, complaints.transactionId))
      .leftJoin(users, eq(users.id, complaints.assignedTo));
  }

  async findByRef(
    ref: string,
    options: { merchantId?: string; merchantOnlyVisible?: boolean } = {},
    tx: Executor = this.db
  ): Promise<ComplaintWithRefs | undefined> {
    const conditions: SQL[] = [eq(complaints.ref, ref)];
    if (options.merchantId) conditions.push(eq(complaints.merchantId, options.merchantId));
    if (options.merchantOnlyVisible) conditions.push(ne(complaints.source, 'customer'));
    const [found] = await this.base(tx)
      .where(and(...conditions))
      .limit(1);
    return found;
  }

  list(filter: ComplaintFilter): Promise<ComplaintWithRefs[]> {
    const conditions: SQL[] = [];
    if (filter.merchantId) conditions.push(eq(complaints.merchantId, filter.merchantId));
    if (filter.merchantOnlyVisible) conditions.push(ne(complaints.source, 'customer'));
    if (filter.status) conditions.push(eq(complaints.status, filter.status));
    if (filter.category) conditions.push(eq(complaints.category, filter.category));
    if (filter.priority) conditions.push(eq(complaints.priority, filter.priority));
    if (filter.source) conditions.push(eq(complaints.source, filter.source));
    if (filter.assignedTo) conditions.push(eq(complaints.assignedTo, filter.assignedTo));
    if (filter.unassigned) conditions.push(isNull(complaints.assignedTo));
    if (filter.breached !== undefined) conditions.push(eq(complaints.breached, filter.breached));
    if (filter.after) {
      const keyset = or(
        lt(complaints.createdAt, filter.after.createdAt),
        and(eq(complaints.createdAt, filter.after.createdAt), lt(complaints.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.base(this.db)
      .where(and(...conditions))
      .orderBy(desc(complaints.createdAt), desc(complaints.ref))
      .limit(filter.limit + 1);
  }

  /** The breach queue: breached and still unresolved, the longest overdue first. */
  breachQueue(after: CursorKey | undefined, limit: number): Promise<ComplaintWithRefs[]> {
    const conditions: SQL[] = [
      eq(complaints.breached, true),
      inArray(complaints.status, OPEN_STATUSES),
    ];
    if (after) {
      const keyset = or(
        sql`${complaints.slaDueAt} > ${after.createdAt}`,
        and(eq(complaints.slaDueAt, after.createdAt), lt(complaints.ref, after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.base(this.db)
      .where(and(...conditions))
      .orderBy(asc(complaints.slaDueAt), desc(complaints.ref))
      .limit(limit + 1);
  }

  /** Unresolved complaints past their deadline that nobody has marked breached yet. */
  overdueIds(now: Date, limit: number): Promise<Array<{ ref: string }>> {
    return this.db
      .select({ ref: complaints.ref })
      .from(complaints)
      .where(
        and(
          eq(complaints.breached, false),
          inArray(complaints.status, OPEN_STATUSES),
          lte(complaints.slaDueAt, now)
        )
      )
      .orderBy(asc(complaints.slaDueAt))
      .limit(limit);
  }

  async openCounts(): Promise<Array<{ priority: string; breached: boolean; n: number }>> {
    const result = await this.db.execute<{ priority: string; breached: boolean; n: string }>(sql`
      select priority, breached, count(*)::text as n from core.complaints
       where status in ('open', 'in_progress', 'awaiting_customer', 'escalated')
       group by priority, breached`);
    return result.rows.map((r) => ({ priority: r.priority, breached: r.breached, n: Number(r.n) }));
  }

  /** A transaction of this merchant, by public ref. */
  async transactionOf(
    ref: string,
    merchantId: string,
    tx: Executor = this.db
  ): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .select({ id: transactionKeys.id })
      .from(transactionKeys)
      .where(and(eq(transactionKeys.ref, ref), eq(transactionKeys.merchantId, merchantId)))
      .limit(1);
    return row;
  }

  /** Any transaction by public ref, with its merchant (staff recording a complaint). */
  async anyTransaction(
    ref: string,
    tx: Executor = this.db
  ): Promise<{ id: string; merchantId: string } | undefined> {
    const [row] = await tx
      .select({ id: transactionKeys.id, merchantId: transactionKeys.merchantId })
      .from(transactionKeys)
      .where(eq(transactionKeys.ref, ref))
      .limit(1);
    return row;
  }
}
