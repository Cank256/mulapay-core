/**
 * SQL for `core.transactions`, its registry `core.transaction_keys` and its event log
 * `core.transaction_events` (spec 5.1, 6.5).
 *
 * `transactions` is partitioned by `created_at`, so no query here scans it without either
 * the primary key `(id, created_at)` or a `created_at` window (spec 9.2 rule 6):
 *
 *  - a lookup by public ref goes through the registry, which yields `created_at`, and then
 *    reads exactly one partition by primary key;
 *  - lists always carry a window (default 90 days, at most 366).
 *
 * Every method that reads merchant data takes a scope and filters on its merchant and
 * environment. Merchant reads use the primary, not the replica: a merchant that has just
 * created a payment must be able to read it back.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, or, type SQL } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { transactionEvents, transactionKeys, transactions } from '../../db/schema';

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionEventRow = typeof transactionEvents.$inferSelect;
export type NewTransactionEvent = typeof transactionEvents.$inferInsert;

/** The columns a payment lifecycle step may change. Everything else is immutable. */
export type TransactionPatch = Partial<
  Pick<
    NewTransaction,
    | 'status'
    | 'feeMinor'
    | 'netMinor'
    | 'provider'
    | 'gatewayOperationId'
    | 'gatewayReferenceId'
    | 'providerTransactionId'
    | 'failureCode'
    | 'failureReason'
    | 'outcomeUnknown'
    | 'initiatedAt'
    | 'completedAt'
  >
>;

export interface TransactionListFilter {
  readonly scope: MerchantScope;
  /** Inclusive window on `created_at`; always set so partitions are pruned. */
  readonly from: Date;
  readonly to: Date;
  readonly type?: string;
  readonly status?: string;
  readonly currency?: string;
  readonly provider?: string;
  readonly channel?: string;
  readonly minAmountMinor?: bigint;
  readonly maxAmountMinor?: bigint;
  /** Exact match on the transaction ref, the gateway external id or the provider id. */
  readonly reference?: string;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class TransactionsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewTransaction): Promise<TransactionRow> {
    const [row] = await tx.insert(transactions).values(values).returning();
    if (!row) throw new Error('transaction insert returned no row');
    return row;
  }

  /** Locks one transaction row by primary key, which also prunes to one partition. */
  async lock(tx: Executor, id: string, createdAt: Date): Promise<TransactionRow | undefined> {
    const [row] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.createdAt, createdAt)))
      .for('update');
    return row;
  }

  async update(
    tx: Executor,
    id: string,
    createdAt: Date,
    patch: TransactionPatch
  ): Promise<TransactionRow> {
    const [row] = await tx
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.createdAt, createdAt)))
      .returning();
    if (!row) throw new Error('transaction update returned no row');
    return row;
  }

  /** One transaction of this merchant and environment by public ref, or undefined. */
  async findByRef(
    scope: MerchantScope,
    ref: string,
    executor: Executor = this.db
  ): Promise<TransactionRow | undefined> {
    const [row] = await executor
      .select({ transaction: transactions })
      .from(transactionKeys)
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, transactionKeys.id),
          eq(transactions.createdAt, transactionKeys.transactionCreatedAt)
        )
      )
      .where(
        and(
          eq(transactionKeys.ref, ref),
          eq(transactionKeys.merchantId, scope.merchantId),
          eq(transactionKeys.environment, scope.environment)
        )
      )
      .limit(1);
    return row?.transaction;
  }

  /** Newest first, keyset on `(created_at, ref)`; returns `limit + 1` rows. */
  list(filter: TransactionListFilter, executor: Executor = this.db): Promise<TransactionRow[]> {
    const { scope } = filter;
    const conditions: (SQL | undefined)[] = [
      eq(transactions.merchantId, scope.merchantId),
      eq(transactions.environment, scope.environment),
      gte(transactions.createdAt, filter.from),
      lte(transactions.createdAt, filter.to),
      filter.type ? eq(transactions.type, filter.type) : undefined,
      filter.status ? eq(transactions.status, filter.status) : undefined,
      filter.currency ? eq(transactions.currency, filter.currency) : undefined,
      filter.provider ? eq(transactions.provider, filter.provider) : undefined,
      filter.channel ? eq(transactions.channel, filter.channel) : undefined,
      filter.minAmountMinor !== undefined
        ? gte(transactions.amountMinor, filter.minAmountMinor)
        : undefined,
      filter.maxAmountMinor !== undefined
        ? lte(transactions.amountMinor, filter.maxAmountMinor)
        : undefined,
      filter.reference
        ? or(
            eq(transactions.ref, filter.reference),
            eq(transactions.gatewayExternalId, filter.reference),
            eq(transactions.providerTransactionId, filter.reference)
          )
        : undefined,
    ];
    if (filter.after) {
      conditions.push(...olderThan(transactions.createdAt, transactions.ref, filter.after));
    }
    return executor
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(...newestFirst(transactions.createdAt, transactions.ref))
      .limit(filter.limit + 1);
  }

  /** Inserts an event unless its key was already recorded; returns the row or undefined. */
  async insertEvent(
    tx: Executor,
    values: NewTransactionEvent
  ): Promise<TransactionEventRow | undefined> {
    const [row] = await tx
      .insert(transactionEvents)
      .values(values)
      .onConflictDoNothing({
        target: [transactionEvents.transactionId, transactionEvents.eventKey],
      })
      .returning();
    return row;
  }

  async findEvent(
    tx: Executor,
    transactionId: string,
    eventKey: string
  ): Promise<TransactionEventRow | undefined> {
    const [row] = await tx
      .select()
      .from(transactionEvents)
      .where(
        and(
          eq(transactionEvents.transactionId, transactionId),
          eq(transactionEvents.eventKey, eventKey)
        )
      )
      .limit(1);
    return row;
  }

  /** Events of one transaction, oldest first. Bounded: a payment has a handful. */
  listEvents(
    scope: MerchantScope,
    transactionId: string,
    executor: Executor = this.db
  ): Promise<TransactionEventRow[]> {
    return executor
      .select()
      .from(transactionEvents)
      .where(
        and(
          eq(transactionEvents.transactionId, transactionId),
          eq(transactionEvents.merchantId, scope.merchantId),
          eq(transactionEvents.environment, scope.environment)
        )
      )
      .orderBy(asc(transactionEvents.createdAt), asc(transactionEvents.id))
      .limit(200);
  }
}
