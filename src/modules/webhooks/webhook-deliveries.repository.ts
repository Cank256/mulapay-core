/**
 * SQL for `core.webhook_deliveries`, a table partitioned by month on `created_at` (spec 5.1).
 *
 * Every query carries a `created_at` bound so the planner prunes partitions: a lookup by
 * ref reads the single partition holding the ref's own creation time (a delivery's ref and
 * its `created_at` share a ULID time), lists take a window, and the recovery sweep looks
 * back 30 days. A delivery created at the event's time keeps the fan-out idempotent: the
 * same event and endpoint always produce the same `(dedupe_key, created_at)`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { ulidTimestamp } from '../../common/ids/ids';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { webhookDeliveries } from '../../db/schema';

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** How far back the recovery sweep looks for deliveries that lost their queue job. */
const RECOVERY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** A job that has not run this long after it was due is presumed lost. */
export const RECOVERY_GRACE_MS = 60_000;

/** The `created_at` of a delivery, read from its ref. Null when the ref is malformed. */
export function createdAtOfRef(ref: string): Date | null {
  const ms = ulidTimestamp(ref);
  return ms === null ? null : new Date(ms);
}

export interface DeliveryFilter {
  readonly scope: MerchantScope;
  readonly eventType?: string;
  readonly endpointId?: string;
  readonly statuses?: readonly string[];
  readonly from: Date;
  readonly to: Date;
}

@Injectable()
export class WebhookDeliveriesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts a delivery; false when its dedupe key already exists (a repeated fan-out). */
  async insert(tx: Executor, row: typeof webhookDeliveries.$inferInsert): Promise<boolean> {
    const inserted = await tx
      .insert(webhookDeliveries)
      .values(row)
      .onConflictDoNothing({ target: [webhookDeliveries.dedupeKey, webhookDeliveries.createdAt] })
      .returning({ id: webhookDeliveries.id });
    return inserted.length > 0;
  }

  /** The delivery for a dedupe key and event time (the original fan-out of an event). */
  async findByDedupeKey(
    tx: Executor,
    dedupeKey: string,
    createdAt: Date
  ): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.dedupeKey, dedupeKey), eq(webhookDeliveries.createdAt, createdAt))
      )
      .limit(1);
    return row;
  }

  /** A merchant's delivery by ref, or undefined for another merchant's or environment's. */
  async findByRef(scope: MerchantScope, ref: string): Promise<WebhookDeliveryRow | undefined> {
    const createdAt = createdAtOfRef(ref);
    if (!createdAt) return undefined;
    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.createdAt, createdAt),
          eq(webhookDeliveries.ref, ref),
          eq(webhookDeliveries.merchantId, scope.merchantId),
          eq(webhookDeliveries.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  /** A delivery by ref with no merchant scope: for the worker, which only holds the ref. */
  async findByRefInternal(ref: string, executor: Executor = this.db) {
    const createdAt = createdAtOfRef(ref);
    if (!createdAt) return undefined;
    const [row] = await executor
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.createdAt, createdAt), eq(webhookDeliveries.ref, ref)))
      .limit(1);
    return row;
  }

  /**
   * Takes a 30-second lease on a delivery that is due, so two workers holding the same job
   * do not both send it. Returns the delivery only to the worker that got the lease.
   */
  async lease(ref: string, now: Date, leaseMs: number): Promise<WebhookDeliveryRow | undefined> {
    const createdAt = createdAtOfRef(ref);
    if (!createdAt) return undefined;
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({ lockedUntil: new Date(now.getTime() + leaseMs) })
      .where(
        and(
          eq(webhookDeliveries.createdAt, createdAt),
          eq(webhookDeliveries.ref, ref),
          eq(webhookDeliveries.status, 'pending'),
          sql`${webhookDeliveries.nextAttemptAt} <= ${now}`,
          sql`(${webhookDeliveries.lockedUntil} is null or ${webhookDeliveries.lockedUntil} < ${now})`
        )
      )
      .returning();
    return row;
  }

  /**
   * Records the outcome of attempt `attempt`. The update applies only to the delivery still
   * pending at attempt `attempt - 1`, so a duplicate worker cannot record a second result.
   * Returns false when it did not apply.
   */
  async finishAttempt(
    tx: Executor,
    delivery: WebhookDeliveryRow,
    result: {
      readonly attempt: number;
      readonly status: 'pending' | 'succeeded' | 'failed' | 'exhausted';
      readonly httpStatus: number | null;
      readonly responseMs: number;
      readonly excerpt: string | null;
      readonly error: string | null;
      readonly nextAttemptAt: Date | null;
      readonly at: Date;
    }
  ): Promise<boolean> {
    const updated = await tx
      .update(webhookDeliveries)
      .set({
        attempt: result.attempt,
        status: result.status,
        httpStatus: result.httpStatus,
        responseMs: result.responseMs,
        responseBodyExcerpt: result.excerpt,
        error: result.error,
        nextAttemptAt: result.nextAttemptAt,
        lastAttemptAt: result.at,
        lockedUntil: null,
      })
      .where(
        and(
          eq(webhookDeliveries.id, delivery.id),
          eq(webhookDeliveries.createdAt, delivery.createdAt),
          eq(webhookDeliveries.status, 'pending'),
          eq(webhookDeliveries.attempt, delivery.attempt)
        )
      )
      .returning({ id: webhookDeliveries.id });
    return updated.length > 0;
  }

  /** Pending deliveries whose time has passed by more than the grace: candidates for recovery. */
  async listOverdue(now: Date, limit: number): Promise<WebhookDeliveryRow[]> {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          sql`${webhookDeliveries.createdAt} >= ${new Date(now.getTime() - RECOVERY_LOOKBACK_MS)}`,
          eq(webhookDeliveries.status, 'pending'),
          sql`${webhookDeliveries.nextAttemptAt} <= ${new Date(now.getTime() - RECOVERY_GRACE_MS)}`
        )
      )
      .orderBy(webhookDeliveries.nextAttemptAt)
      .limit(limit);
  }

  /** Newest first; `limit + 1` rows so the caller can tell whether another page exists. */
  list(
    filter: DeliveryFilter & { after?: CursorKey; limit: number }
  ): Promise<WebhookDeliveryRow[]> {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          ...this.filterConditions(filter),
          ...(filter.after
            ? olderThan(webhookDeliveries.createdAt, webhookDeliveries.ref, filter.after)
            : [])
        )
      )
      .orderBy(...newestFirst(webhookDeliveries.createdAt, webhookDeliveries.ref))
      .limit(filter.limit + 1);
  }

  /** Up to `limit` deliveries matching a replay request, newest first. */
  listForReplay(filter: DeliveryFilter, limit: number): Promise<WebhookDeliveryRow[]> {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(and(...this.filterConditions(filter)))
      .orderBy(...newestFirst(webhookDeliveries.createdAt, webhookDeliveries.ref))
      .limit(limit);
  }

  private filterConditions(filter: DeliveryFilter) {
    const { scope } = filter;
    return [
      eq(webhookDeliveries.merchantId, scope.merchantId),
      eq(webhookDeliveries.environment, scope.environment),
      sql`${webhookDeliveries.createdAt} >= ${filter.from}`,
      sql`${webhookDeliveries.createdAt} <= ${filter.to}`,
      filter.eventType ? eq(webhookDeliveries.eventType, filter.eventType) : undefined,
      filter.endpointId ? eq(webhookDeliveries.endpointId, filter.endpointId) : undefined,
      filter.statuses ? inArray(webhookDeliveries.status, [...filter.statuses]) : undefined,
    ];
  }
}
