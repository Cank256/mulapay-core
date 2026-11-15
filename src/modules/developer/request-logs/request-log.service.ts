/**
 * API request logs (spec 6.11): one row per authenticated public API call, written
 * asynchronously.
 *
 * `record` is called from the response hook and only buffers; the worker's `flush` stores
 * the buffer in batches. What is kept: request id, merchant, environment, API key, method,
 * path without the query string, route template, status, error code, idempotency key,
 * latency, client address and user agent. Request and response bodies, headers (other than
 * the two named) and query strings are never kept.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../../common/auth/merchant-scope';
import type { Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import { resolveWindow } from '../../../common/pagination/window';
import { CLOCK } from '../../../common/tokens';
import { FLUSH_BATCH_SIZE, RequestLogBuffer, type RequestLogEntry } from './request-log.buffer';
import { RequestLogRepository } from './request-log.repository';
import { toRequestLogView, type RequestLogView } from './request-log.views';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const MAX_FLUSH_BATCHES = 20;

export interface RecordedRequest {
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
  readonly apiKeyId: string;
  readonly method: string;
  /** Request target; the query string is removed here. */
  readonly url: string;
  readonly route: string;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly requestId: string;
  readonly idempotencyKey: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  readonly errorCode: string | undefined;
}

export interface ListRequestLogsQuery {
  readonly statusCode?: number;
  readonly method?: string;
  readonly requestId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class RequestLogService {
  constructor(
    private readonly buffer: RequestLogBuffer,
    private readonly repository: RequestLogRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Buffers one entry. The identifiers are generated now, so a repeated insert is a no-op. */
  record(request: RecordedRequest): void {
    const now = this.clock.now();
    const entry: RequestLogEntry = {
      id: uuidv7(now),
      ref: publicId('requestLog', now),
      merchantId: request.merchantId,
      environment: request.environment,
      apiKeyId: request.apiKeyId,
      method: request.method,
      path: (request.url.split('?')[0] ?? request.url).slice(0, 2048),
      route: request.route.slice(0, 256),
      statusCode: request.statusCode,
      latencyMs: Math.max(0, request.latencyMs),
      requestId: request.requestId.slice(0, 128),
      idempotencyKey:
        request.idempotencyKey && IDEMPOTENCY_KEY.test(request.idempotencyKey)
          ? request.idempotencyKey
          : null,
      ip: request.ip?.slice(0, 64) ?? null,
      userAgent: request.userAgent?.slice(0, 512) ?? null,
      errorCode: request.errorCode ?? null,
      createdAt: now.toISOString(),
    };
    this.buffer.push(entry);
  }

  /**
   * Stores what is buffered, in batches of FLUSH_BATCH_SIZE, finishing batches a dead worker
   * left behind first. Safe to run concurrently and repeatedly. Returns entries stored.
   */
  async flush(): Promise<number> {
    const now = this.clock.now();
    let stored = 0;
    for (const id of await this.buffer.orphans(now)) stored += await this.store(id);
    for (let i = 0; i < MAX_FLUSH_BATCHES; i++) {
      const id = await this.buffer.claim(FLUSH_BATCH_SIZE, this.clock.now());
      if (!id) break;
      stored += await this.store(id);
    }
    return stored;
  }

  private async store(batchId: string): Promise<number> {
    const entries = await this.buffer.read(batchId);
    const inserted = await this.repository.insertBatch(entries);
    await this.buffer.finish(batchId);
    return inserted;
  }

  async get(scope: MerchantScope, ref: string): Promise<RequestLogView> {
    const row = await this.repository.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    return toRequestLogView(row);
  }

  async list(scope: MerchantScope, query: ListRequestLogsQuery): Promise<Page<RequestLogView>> {
    const window = resolveWindow(query, this.clock.now());
    const fingerprint = filterFingerprint({
      environment: scope.environment,
      statusCode: query.statusCode,
      method: query.method,
      requestId: query.requestId,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.list({ scope, ...query, ...window, after });
    const page = toPage(rows, query.limit, fingerprint, ({ log }) => ({
      createdAt: log.createdAt,
      id: log.ref,
    }));
    return { items: page.items.map(toRequestLogView), nextCursor: page.nextCursor };
  }
}
