/**
 * SQL for `core.api_request_logs`, partitioned by month on `created_at`. Every query carries
 * a `created_at` bound; a lookup by ref reads the single partition of the ref's own time.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { MerchantScope } from '../../../common/auth/merchant-scope';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { ulidTimestamp } from '../../../common/ids/ids';
import type { CursorKey } from '../../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../../common/pagination/keyset';
import { apiKeys, apiRequestLogs } from '../../../db/schema';
import type { RequestLogEntry } from './request-log.buffer';

export interface RequestLogRow {
  readonly log: typeof apiRequestLogs.$inferSelect;
  readonly apiKeyRef: string;
}

export interface RequestLogFilter {
  readonly scope: MerchantScope;
  readonly statusCode?: number;
  readonly method?: string;
  readonly requestId?: string;
  readonly from: Date;
  readonly to: Date;
}

@Injectable()
export class RequestLogRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Stores a batch. Re-inserting the same ids stores nothing new. Returns rows inserted. */
  async insertBatch(entries: readonly RequestLogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const inserted = await this.db
      .insert(apiRequestLogs)
      .values(
        entries.map((entry) => ({
          id: entry.id,
          ref: entry.ref,
          merchantId: entry.merchantId,
          environment: entry.environment,
          apiKeyId: entry.apiKeyId,
          method: entry.method,
          path: entry.path,
          route: entry.route,
          statusCode: entry.statusCode,
          latencyMs: entry.latencyMs,
          requestId: entry.requestId,
          idempotencyKey: entry.idempotencyKey,
          ip: entry.ip,
          userAgent: entry.userAgent,
          errorCode: entry.errorCode,
          createdAt: new Date(entry.createdAt),
        }))
      )
      .onConflictDoNothing({ target: [apiRequestLogs.id, apiRequestLogs.createdAt] })
      .returning({ id: apiRequestLogs.id });
    return inserted.length;
  }

  async findByRef(scope: MerchantScope, ref: string): Promise<RequestLogRow | undefined> {
    const ms = ulidTimestamp(ref);
    if (ms === null) return undefined;
    const [row] = await this.db
      .select({ log: apiRequestLogs, apiKeyRef: apiKeys.ref })
      .from(apiRequestLogs)
      .innerJoin(apiKeys, eq(apiKeys.id, apiRequestLogs.apiKeyId))
      .where(
        and(
          eq(apiRequestLogs.createdAt, new Date(ms)),
          eq(apiRequestLogs.ref, ref),
          eq(apiRequestLogs.merchantId, scope.merchantId),
          eq(apiRequestLogs.environment, scope.environment)
        )
      )
      .limit(1);
    return row;
  }

  /** Newest first; `limit + 1` rows so the caller can tell whether another page exists. */
  list(filter: RequestLogFilter & { after?: CursorKey; limit: number }): Promise<RequestLogRow[]> {
    const { scope } = filter;
    return this.db
      .select({ log: apiRequestLogs, apiKeyRef: apiKeys.ref })
      .from(apiRequestLogs)
      .innerJoin(apiKeys, eq(apiKeys.id, apiRequestLogs.apiKeyId))
      .where(
        and(
          eq(apiRequestLogs.merchantId, scope.merchantId),
          eq(apiRequestLogs.environment, scope.environment),
          sql`${apiRequestLogs.createdAt} >= ${filter.from}`,
          sql`${apiRequestLogs.createdAt} <= ${filter.to}`,
          filter.statusCode ? eq(apiRequestLogs.statusCode, filter.statusCode) : undefined,
          filter.method ? eq(apiRequestLogs.method, filter.method) : undefined,
          filter.requestId ? eq(apiRequestLogs.requestId, filter.requestId) : undefined,
          ...(filter.after
            ? olderThan(apiRequestLogs.createdAt, apiRequestLogs.ref, filter.after)
            : [])
        )
      )
      .orderBy(...newestFirst(apiRequestLogs.createdAt, apiRequestLogs.ref))
      .limit(filter.limit + 1);
  }
}
