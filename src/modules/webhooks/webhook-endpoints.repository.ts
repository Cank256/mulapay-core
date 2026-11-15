/** SQL for `core.webhook_endpoints` (spec 5.2). Reads for merchants are scoped by merchant and environment. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { webhookEndpoints } from '../../db/schema';

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

/** Endpoints a merchant may keep per environment. */
export const MAX_ENDPOINTS_PER_ENVIRONMENT = 20;

@Injectable()
export class WebhookEndpointsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(
    tx: Executor,
    row: typeof webhookEndpoints.$inferInsert
  ): Promise<WebhookEndpointRow> {
    const [inserted] = await tx.insert(webhookEndpoints).values(row).returning();
    if (!inserted) throw new Error('webhook endpoint insert returned no row');
    return inserted;
  }

  /** Live endpoints of the scope, newest first. Soft-deleted endpoints are not listed. */
  list(scope: MerchantScope): Promise<WebhookEndpointRow[]> {
    return this.db
      .select()
      .from(webhookEndpoints)
      .where(this.scoped(scope))
      .orderBy(desc(webhookEndpoints.createdAt))
      .limit(MAX_ENDPOINTS_PER_ENVIRONMENT);
  }

  async findByRef(scope: MerchantScope, ref: string): Promise<WebhookEndpointRow | undefined> {
    const [row] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(and(this.scoped(scope), eq(webhookEndpoints.ref, ref)))
      .limit(1);
    return row;
  }

  async lockByRef(
    tx: Executor,
    scope: MerchantScope,
    ref: string
  ): Promise<WebhookEndpointRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(this.scoped(scope), eq(webhookEndpoints.ref, ref)))
      .for('update');
    return row;
  }

  /** Locks the merchant's endpoints of one environment so the endpoint limit cannot be raced. */
  async countLive(tx: Executor, scope: MerchantScope): Promise<number> {
    const result = await tx.execute<{ count: string }>(sql`
      select count(*) as count from (
        select 1 from core.webhook_endpoints
         where merchant_id = ${scope.merchantId} and environment = ${scope.environment}
           and deleted_at is null
         for update) locked`);
    return Number(result.rows[0]?.count ?? 0);
  }

  async findById(
    id: string,
    executor: Executor = this.db
  ): Promise<WebhookEndpointRow | undefined> {
    const [row] = await executor
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return row;
  }

  /** Public refs for internal ids, in one query, deleted endpoints included. */
  async refsByIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: webhookEndpoints.id, ref: webhookEndpoints.ref })
      .from(webhookEndpoints)
      .where(inArray(webhookEndpoints.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.ref]));
  }

  /** Active endpoints of a merchant and environment: the fan-out targets of an event. */
  listActive(tx: Executor, merchantId: string, environment: string): Promise<WebhookEndpointRow[]> {
    return tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.merchantId, merchantId),
          eq(webhookEndpoints.environment, environment),
          eq(webhookEndpoints.status, 'active'),
          isNull(webhookEndpoints.deletedAt)
        )
      );
  }

  async update(
    tx: Executor,
    id: string,
    patch: Partial<typeof webhookEndpoints.$inferInsert>
  ): Promise<WebhookEndpointRow> {
    const [row] = await tx
      .update(webhookEndpoints)
      .set(patch)
      .where(eq(webhookEndpoints.id, id))
      .returning();
    if (!row) throw new Error('webhook endpoint update matched no row');
    return row;
  }

  /** A delivery got a 2xx: the consecutive failure count starts over. */
  async recordSuccess(tx: Executor, id: string, at: Date): Promise<void> {
    await tx
      .update(webhookEndpoints)
      .set({ failureCount: 0, lastSuccessAt: at })
      .where(eq(webhookEndpoints.id, id));
  }

  /** Counts one failed attempt and returns the endpoint as it is now. */
  async recordFailure(tx: Executor, id: string, at: Date): Promise<WebhookEndpointRow> {
    const [row] = await tx
      .update(webhookEndpoints)
      .set({ failureCount: sql`${webhookEndpoints.failureCount} + 1`, lastFailureAt: at })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    if (!row) throw new Error('webhook endpoint failure matched no row');
    return row;
  }

  /**
   * Disables an endpoint that is still `active`. Returns the row only for the call that
   * made the change, so exactly one caller announces it.
   */
  async autoDisable(tx: Executor, id: string, at: Date): Promise<WebhookEndpointRow | undefined> {
    const [row] = await tx
      .update(webhookEndpoints)
      .set({ status: 'auto_disabled', disabledAt: at })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.status, 'active')))
      .returning();
    return row;
  }

  private scoped(scope: MerchantScope) {
    return and(
      eq(webhookEndpoints.merchantId, scope.merchantId),
      eq(webhookEndpoints.environment, scope.environment),
      isNull(webhookEndpoints.deletedAt)
    );
  }
}
