/** SQL for `core.holds`. Rows change only through the guarded transitions (migration 0004). */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { holds } from '../../db/schema';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';
export type HoldRow = typeof holds.$inferSelect;
export type NewHold = typeof holds.$inferInsert;
@Injectable()
export class HoldsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}
  async insert(tx: Executor, row: NewHold): Promise<HoldRow> {
    const [inserted] = await tx.insert(holds).values(row).returning();
    return inserted as HoldRow;
  }
  async findByKey(
    tx: Executor,
    environment: LedgerEnvironment,
    idempotencyKey: string
  ): Promise<HoldRow | undefined> {
    const [row] = await tx
      .select()
      .from(holds)
      .where(and(eq(holds.environment, environment), eq(holds.idempotencyKey, idempotencyKey)));
    return row;
  }
  async lockById(tx: Executor, id: string): Promise<HoldRow | undefined> {
    const [row] = await tx.select().from(holds).where(eq(holds.id, id)).for('update');
    return row;
  }
  async findByRef(
    merchantId: string,
    environment: LedgerEnvironment,
    ref: string,
    tx: Executor = this.db
  ): Promise<HoldRow | undefined> {
    const [row] = await tx
      .select()
      .from(holds)
      .where(
        and(
          eq(holds.merchantId, merchantId),
          eq(holds.environment, environment),
          eq(holds.ref, ref)
        )
      );
    return row;
  }
  async markCaptured(tx: Executor, id: string, key: string, at: Date): Promise<HoldRow> {
    return this.end(tx, id, { state: 'captured', capturedAt: at, captureKey: key });
  }
  async markReleased(tx: Executor, id: string, key: string, at: Date): Promise<HoldRow> {
    return this.end(tx, id, { state: 'released', releasedAt: at, releaseKey: key });
  }
  async markExpired(tx: Executor, id: string, at: Date): Promise<HoldRow> {
    return this.end(tx, id, { state: 'expired', expiredAt: at });
  }
  private async end(tx: Executor, id: string, set: Partial<NewHold>): Promise<HoldRow> {
    const [row] = await tx.update(holds).set(set).where(eq(holds.id, id)).returning();
    return row as HoldRow;
  }
  /** Ids of active holds past their expiry, oldest first. Uses `holds_expiry_idx`. */
  async findDueForExpiry(now: Date, limit: number, tx: Executor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ id: holds.id })
      .from(holds)
      .where(and(eq(holds.state, 'active'), isNotNull(holds.expiresAt), lte(holds.expiresAt, now)))
      .orderBy(asc(holds.expiresAt))
      .limit(limit);
    return rows.map((r) => r.id);
  }
  async listActive(
    merchantId: string,
    environment: LedgerEnvironment,
    limit: number,
    tx: Executor = this.db
  ): Promise<HoldRow[]> {
    return tx
      .select()
      .from(holds)
      .where(
        and(
          eq(holds.merchantId, merchantId),
          eq(holds.environment, environment),
          eq(holds.state, 'active')
        )
      )
      .orderBy(desc(holds.createdAt), desc(holds.ref))
      .limit(limit);
  }

  /**
   * A merchant's holds newest first, optionally one state. The keyset compares `created_at`
   * at millisecond precision (the precision of a cursor) on both sides, so a page boundary
   * can neither skip nor repeat a row. Fetches `limit + 1` so the caller can tell whether
   * another page exists.
   */
  async list(input: {
    merchantId: string;
    environment: LedgerEnvironment;
    state?: string;
    after?: { createdAt: Date; ref: string };
    limit: number;
  }): Promise<HoldRow[]> {
    const ms = sql`date_trunc('milliseconds', ${holds.createdAt})`;
    return this.db
      .select()
      .from(holds)
      .where(
        and(
          eq(holds.merchantId, input.merchantId),
          eq(holds.environment, input.environment),
          input.state ? eq(holds.state, input.state) : undefined,
          input.after
            ? sql`(${ms}, ${holds.ref}) < (${input.after.createdAt}::timestamptz, ${input.after.ref})`
            : undefined
        )
      )
      .orderBy(sql`${ms} desc`, desc(holds.ref))
      .limit(input.limit + 1);
  }
}
