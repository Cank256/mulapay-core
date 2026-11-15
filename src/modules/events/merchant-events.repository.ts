/** SQL for `core.merchant_events` (spec 5.2). Every read is scoped to merchant and environment. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { merchantEvents } from '../../db/schema';

export type MerchantEventRow = typeof merchantEvents.$inferSelect;

@Injectable()
export class MerchantEventsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, row: typeof merchantEvents.$inferInsert): Promise<MerchantEventRow> {
    const [inserted] = await tx.insert(merchantEvents).values(row).returning();
    if (!inserted) throw new Error('merchant event insert returned no row');
    return inserted;
  }

  async findByRef(scope: MerchantScope, ref: string): Promise<MerchantEventRow | undefined> {
    const [row] = await this.db
      .select()
      .from(merchantEvents)
      .where(
        and(
          eq(merchantEvents.merchantId, scope.merchantId),
          eq(merchantEvents.environment, scope.environment),
          eq(merchantEvents.ref, ref)
        )
      )
      .limit(1);
    return row;
  }

  /** The event by internal id; for workers, which run without a request scope. */
  async findById(id: string, executor: Executor = this.db): Promise<MerchantEventRow | undefined> {
    const [row] = await executor
      .select()
      .from(merchantEvents)
      .where(eq(merchantEvents.id, id))
      .limit(1);
    return row;
  }

  /** Public refs for internal ids, in one query. */
  async refsByIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: merchantEvents.id, ref: merchantEvents.ref })
      .from(merchantEvents)
      .where(inArray(merchantEvents.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.ref]));
  }

  /** Newest first. Fetches `limit + 1` rows so the caller can tell whether another page exists. */
  list(input: {
    scope: MerchantScope;
    type?: string;
    from: Date;
    to: Date;
    after?: CursorKey;
    limit: number;
  }): Promise<MerchantEventRow[]> {
    const { scope } = input;
    return this.db
      .select()
      .from(merchantEvents)
      .where(
        and(
          eq(merchantEvents.merchantId, scope.merchantId),
          eq(merchantEvents.environment, scope.environment),
          input.type ? eq(merchantEvents.type, input.type) : undefined,
          sql`${merchantEvents.createdAt} >= ${input.from}`,
          sql`${merchantEvents.createdAt} <= ${input.to}`,
          ...(input.after
            ? olderThan(merchantEvents.createdAt, merchantEvents.ref, input.after)
            : [])
        )
      )
      .orderBy(...newestFirst(merchantEvents.createdAt, merchantEvents.ref))
      .limit(input.limit + 1);
  }
}
