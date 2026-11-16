/** SQL for `core.approvals` and `core.approval_decisions`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import type { CursorKey } from '../../../common/pagination/cursor';
import { approvalDecisions, approvals, users } from '../../../db/schema';

export type ApprovalRow = typeof approvals.$inferSelect;
export type DecisionRow = typeof approvalDecisions.$inferSelect;

export interface ApprovalWithRefs {
  readonly row: ApprovalRow;
  readonly requestedByRef: string;
}

@Injectable()
export class ApprovalsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts; undefined when a pending request for the same subject and kind exists. */
  async insertIfNew(
    tx: Executor,
    values: typeof approvals.$inferInsert
  ): Promise<ApprovalRow | undefined> {
    const [row] = await tx.insert(approvals).values(values).onConflictDoNothing().returning();
    return row;
  }

  async findPending(
    tx: Executor,
    kind: string,
    resourceType: string,
    resourceId: string
  ): Promise<ApprovalRow | undefined> {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.kind, kind),
          eq(approvals.resourceType, resourceType),
          eq(approvals.resourceId, resourceId),
          eq(approvals.status, 'pending')
        )
      )
      .limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<ApprovalRow | undefined> {
    const [row] = await tx.select().from(approvals).where(eq(approvals.ref, ref)).for('update');
    return row;
  }

  async update(
    tx: Executor,
    id: string,
    patch: Partial<Pick<ApprovalRow, 'status' | 'decidedAt' | 'executedAt'>>
  ): Promise<ApprovalRow> {
    const [row] = await tx.update(approvals).set(patch).where(eq(approvals.id, id)).returning();
    if (!row) throw new Error('approval update returned no row');
    return row;
  }

  async insertDecision(tx: Executor, values: typeof approvalDecisions.$inferInsert): Promise<void> {
    await tx.insert(approvalDecisions).values(values);
  }

  async decisions(
    approvalId: string,
    tx: Executor = this.db
  ): Promise<Array<{ row: DecisionRow; approverRef: string }>> {
    return tx
      .select({ row: approvalDecisions, approverRef: users.ref })
      .from(approvalDecisions)
      .innerJoin(users, eq(users.id, approvalDecisions.approverId))
      .where(eq(approvalDecisions.approvalId, approvalId))
      .orderBy(asc(approvalDecisions.decidedAt));
  }

  async approveCount(tx: Executor, approvalId: string): Promise<number> {
    const rows = await tx
      .select({ id: approvalDecisions.id })
      .from(approvalDecisions)
      .where(
        and(eq(approvalDecisions.approvalId, approvalId), eq(approvalDecisions.decision, 'approve'))
      );
    return rows.length;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<ApprovalWithRefs | undefined> {
    const [found] = await tx
      .select({ row: approvals, requestedByRef: users.ref })
      .from(approvals)
      .innerJoin(users, eq(users.id, approvals.requestedBy))
      .where(eq(approvals.ref, ref))
      .limit(1);
    return found;
  }

  list(filter: {
    status?: string;
    kind?: string;
    after?: CursorKey;
    limit: number;
  }): Promise<ApprovalWithRefs[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(approvals.status, filter.status));
    if (filter.kind) conditions.push(eq(approvals.kind, filter.kind));
    if (filter.after) {
      const keyset = or(
        lt(approvals.requestedAt, filter.after.createdAt),
        and(eq(approvals.requestedAt, filter.after.createdAt), lt(approvals.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({ row: approvals, requestedByRef: users.ref })
      .from(approvals)
      .innerJoin(users, eq(users.id, approvals.requestedBy))
      .where(and(...conditions))
      .orderBy(desc(approvals.requestedAt), desc(approvals.ref))
      .limit(filter.limit + 1);
  }

  /** Pending approvals whose time has run out. */
  expiredPending(now: Date, limit: number): Promise<Array<{ ref: string }>> {
    return this.db
      .select({ ref: approvals.ref })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .limit(limit);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.status, 'pending'));
    return rows.length;
  }
}
