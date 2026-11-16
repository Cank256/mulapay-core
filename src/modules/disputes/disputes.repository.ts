/** SQL for `core.disputes`. Merchant-facing reads take a merchant scope (spec 8.4). */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { disputeNotes, disputes, merchants, transactionKeys, users } from '../../db/schema';
import type { DisputedTransaction } from './domain/dispute-state';

export type DisputeRow = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type DisputePatch = Partial<
  Pick<
    NewDispute,
    | 'status'
    | 'evidenceDueAt'
    | 'evidence'
    | 'internalNote'
    | 'outcome'
    | 'resolutionEntryRef'
    | 'resolutionNote'
    | 'resolvedBy'
    | 'resolvedAt'
    | 'assignedTo'
    | 'assignedAt'
    | 'dueSoonNotifiedAt'
    | 'overdueNotifiedAt'
  >
>;
export type DisputeNoteRow = typeof disputeNotes.$inferSelect;

export interface DisputeWithRefs {
  readonly row: DisputeRow;
  readonly merchantRef: string;
  readonly transactionRef: string;
  /** The investigator's staff ref, when one is assigned. */
  readonly assigneeRef: string | null;
}

export interface TransactionLookup extends DisputedTransaction {
  readonly id: string;
  readonly ref: string;
  readonly createdAt: Date;
}

@Injectable()
export class DisputesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewDispute): Promise<DisputeRow> {
    const [row] = await tx.insert(disputes).values(values).returning();
    if (!row) throw new Error('dispute insert returned no row');
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<DisputeRow | undefined> {
    const [row] = await tx.select().from(disputes).where(eq(disputes.ref, ref)).for('update');
    return row;
  }

  async lockForMerchant(tx: Executor, scope: MerchantScope, ref: string) {
    const [row] = await tx
      .select()
      .from(disputes)
      .where(and(eq(disputes.ref, ref), eq(disputes.merchantId, scope.merchantId)))
      .for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: DisputePatch): Promise<DisputeRow> {
    const [row] = await tx.update(disputes).set(patch).where(eq(disputes.id, id)).returning();
    if (!row) throw new Error('dispute update returned no row');
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<DisputeWithRefs | undefined> {
    const [found] = await tx
      .select({
        row: disputes,
        merchantRef: merchants.ref,
        transactionRef: transactionKeys.ref,
        assigneeRef: users.ref,
      })
      .from(disputes)
      .innerJoin(merchants, eq(merchants.id, disputes.merchantId))
      .innerJoin(transactionKeys, eq(transactionKeys.id, disputes.transactionId))
      .leftJoin(users, eq(users.id, disputes.assignedTo))
      .where(eq(disputes.ref, ref))
      .limit(1);
    return found;
  }

  /** A dispute of this merchant and environment; another merchant's ref is "not found". */
  async findForMerchant(
    scope: MerchantScope,
    ref: string,
    tx: Executor = this.db
  ): Promise<DisputeWithRefs | undefined> {
    const [found] = await tx
      .select({
        row: disputes,
        merchantRef: merchants.ref,
        transactionRef: transactionKeys.ref,
        assigneeRef: users.ref,
      })
      .from(disputes)
      .innerJoin(merchants, eq(merchants.id, disputes.merchantId))
      .innerJoin(transactionKeys, eq(transactionKeys.id, disputes.transactionId))
      .leftJoin(users, eq(users.id, disputes.assignedTo))
      .where(
        and(
          eq(disputes.ref, ref),
          eq(disputes.merchantId, scope.merchantId),
          eq(disputes.environment, scope.environment)
        )
      )
      .limit(1);
    return found;
  }

  list(filter: {
    scope?: MerchantScope;
    merchantId?: string;
    status?: string;
    assignedTo?: string;
    unassigned?: boolean;
    /** Unresolved disputes whose evidence deadline has passed, or falls before `until`. */
    deadline?: { kind: 'overdue'; now: Date } | { kind: 'due_soon'; now: Date; until: Date };
    after?: CursorKey;
    limit: number;
  }): Promise<DisputeWithRefs[]> {
    const conditions: SQL[] = [];
    if (filter.scope) {
      conditions.push(eq(disputes.merchantId, filter.scope.merchantId));
      conditions.push(eq(disputes.environment, filter.scope.environment));
    }
    if (filter.merchantId) conditions.push(eq(disputes.merchantId, filter.merchantId));
    if (filter.status) conditions.push(eq(disputes.status, filter.status));
    if (filter.assignedTo) conditions.push(eq(disputes.assignedTo, filter.assignedTo));
    if (filter.unassigned) conditions.push(isNull(disputes.assignedTo));
    if (filter.deadline) {
      conditions.push(sql`${disputes.status} <> 'resolved'`, isNotNull(disputes.evidenceDueAt));
      if (filter.deadline.kind === 'overdue') {
        conditions.push(lt(disputes.evidenceDueAt, filter.deadline.now));
      } else {
        conditions.push(
          sql`${disputes.evidenceDueAt} >= ${filter.deadline.now}`,
          lte(disputes.evidenceDueAt, filter.deadline.until)
        );
      }
    }
    if (filter.after) {
      const keyset = or(
        lt(disputes.createdAt, filter.after.createdAt),
        and(eq(disputes.createdAt, filter.after.createdAt), lt(disputes.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({
        row: disputes,
        merchantRef: merchants.ref,
        transactionRef: transactionKeys.ref,
        assigneeRef: users.ref,
      })
      .from(disputes)
      .innerJoin(merchants, eq(merchants.id, disputes.merchantId))
      .innerJoin(transactionKeys, eq(transactionKeys.id, disputes.transactionId))
      .leftJoin(users, eq(users.id, disputes.assignedTo))
      .where(and(...conditions))
      .orderBy(desc(disputes.createdAt), desc(disputes.ref))
      .limit(filter.limit + 1);
  }

  async hasUnresolved(tx: Executor, transactionId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.transactionId, transactionId), sql`${disputes.status} <> 'resolved'`))
      .limit(1);
    return row !== undefined;
  }

  /** The transaction behind a public ref, with what the dispute rules need to know. */
  async loadTransaction(tx: Executor, ref: string): Promise<TransactionLookup | undefined> {
    const result = await tx.execute<{
      id: string;
      ref: string;
      merchant_id: string;
      environment: string;
      type: string;
      status: string;
      amount_minor: string;
      currency: string;
      provider: string | null;
      created_at: string;
    }>(sql`
      select t.id, t.ref, t.merchant_id, t.environment, t.type, t.status,
             t.amount_minor::text as amount_minor, t.currency, t.provider,
             to_json(t.created_at) #>> '{}' as created_at
        from core.transaction_keys k
        join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
       where k.ref = ${ref}`);
    const r = result.rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      ref: r.ref,
      merchantId: r.merchant_id,
      environment: r.environment,
      type: r.type,
      status: r.status,
      amountMinor: BigInt(r.amount_minor),
      currency: r.currency,
      provider: r.provider,
      createdAt: new Date(r.created_at),
    };
  }

  /**
   * The ref of the entry that posted the payment's success, if it exists and has not been
   * reversed. A payment whose entry was reversed already cannot be reversed again.
   */
  async reversibleCollectionEntry(
    tx: Executor,
    transactionId: string,
    transactionCreatedAt: Date
  ): Promise<string | undefined> {
    // Entries are stamped by the database and transactions by the application clock; a day of
    // slack keeps the partition bound correct however far the two disagree.
    const from = new Date(transactionCreatedAt.getTime() - 86_400_000);
    const result = await tx.execute<{ ref: string }>(sql`
      select e.ref from core.journal_entries e
       where e.transaction_id = ${transactionId} and e.kind = 'collection.succeeded'
         and e.created_at >= ${from}
         and not exists (select 1 from core.journal_entry_keys r where r.reverses_entry_id = e.id)
       order by e.created_at limit 1`);
    return result.rows[0]?.ref;
  }

  async insertNote(
    tx: Executor,
    values: typeof disputeNotes.$inferInsert
  ): Promise<DisputeNoteRow> {
    // Notes are read by time: a note written in the same millisecond as the one before it still comes after it.
    const [latest] = await tx
      .select({ at: max(disputeNotes.createdAt) })
      .from(disputeNotes)
      .where(eq(disputeNotes.disputeId, values.disputeId));
    const createdAt =
      values.createdAt instanceof Date && latest?.at && latest.at >= values.createdAt
        ? new Date(latest.at.getTime() + 1)
        : values.createdAt;
    const [row] = await tx
      .insert(disputeNotes)
      .values({ ...values, createdAt })
      .returning();
    if (!row) throw new Error('dispute note insert returned no row');
    return row;
  }

  notes(disputeId: string): Promise<Array<{ row: DisputeNoteRow; authorRef: string }>> {
    return this.db
      .select({ row: disputeNotes, authorRef: users.ref })
      .from(disputeNotes)
      .innerJoin(users, eq(users.id, disputeNotes.authorId))
      .where(eq(disputeNotes.disputeId, disputeId))
      .orderBy(asc(disputeNotes.createdAt), asc(disputeNotes.id));
  }

  /** Unresolved disputes whose deadline warning or lapse nobody has been told about yet. */
  async deadlineCandidates(now: Date, soonUntil: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ ref: disputes.ref })
      .from(disputes)
      .where(
        and(
          sql`${disputes.status} <> 'resolved'`,
          isNotNull(disputes.evidenceDueAt),
          or(
            and(isNull(disputes.dueSoonNotifiedAt), lte(disputes.evidenceDueAt, soonUntil)),
            and(isNull(disputes.overdueNotifiedAt), lt(disputes.evidenceDueAt, now))
          )
        )
      )
      .orderBy(asc(disputes.evidenceDueAt))
      .limit(limit);
    return rows.map((r) => r.ref);
  }
}
