/**
 * The Redis side of API request logging (spec 6.11, 9.2 rule 10).
 *
 * A request pushes one JSON entry onto `apilog:buffer` and returns. The worker drains the
 * list in batches of up to 500 every 2 seconds and inserts them in one statement.
 *
 * Nothing is lost on a crash and nothing is written twice:
 *  - the drain moves a batch atomically into its own list (`apilog:batch:{id}`) and records
 *    the batch in the `apilog:batches` registry in the same script, so a batch is always
 *    findable;
 *  - the insert is `ON CONFLICT DO NOTHING` on ids generated when the request finished, so
 *    inserting a batch twice stores each row once;
 *  - a batch older than 30 seconds that nobody finished (its worker died) is inserted by
 *    the next drain.
 *
 * Request bodies, headers and query strings are never part of an entry. If the buffer holds
 * more than MAX_BUFFER entries (the database or worker is down) new entries are dropped and
 * `core_api_request_logs_dropped_total` rises, because logs must never take the API down.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { toLoggableError } from '../../../common/logging/redaction';
import { REDIS } from '../../../common/redis/redis.module';
import { apiRequestLogsDropped } from '../../../common/telemetry/metrics';
import { ROOT_LOGGER } from '../../../common/tokens';

export const BUFFER_KEY = 'apilog:buffer';
const REGISTRY_KEY = 'apilog:batches';
export const FLUSH_BATCH_SIZE = 500;
export const MAX_BUFFER = 200_000;
const ORPHAN_AFTER_MS = 30_000;

/** What is kept about one request. Strings are bounded by the producer. */
export interface RequestLogEntry {
  readonly id: string;
  readonly ref: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
  readonly apiKeyId: string;
  readonly method: string;
  readonly path: string;
  readonly route: string;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly requestId: string;
  readonly idempotencyKey: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

const PUSH_SCRIPT = `
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('LPUSH', KEYS[1], ARGV[1])
return 1`;

const CLAIM_SCRIPT = `
local moved = 0
for i = 1, tonumber(ARGV[1]) do
  local value = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
  if not value then break end
  moved = moved + 1
end
if moved > 0 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2]) end
return moved`;

@Injectable()
export class RequestLogBuffer {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Buffers an entry. Never throws and never waits for more than one Redis round trip. */
  push(entry: RequestLogEntry): void {
    this.redis
      .eval(PUSH_SCRIPT, 1, BUFFER_KEY, JSON.stringify(entry), MAX_BUFFER)
      .then((accepted) => {
        if (accepted === 0) apiRequestLogsDropped.inc({ reason: 'buffer_full' });
      })
      .catch((error: unknown) => {
        apiRequestLogsDropped.inc({ reason: 'redis_unavailable' });
        this.logger.warn({ err: toLoggableError(error) }, 'request log not buffered');
      });
  }

  async length(): Promise<number> {
    return this.redis.llen(BUFFER_KEY);
  }

  /**
   * Moves up to `size` buffered entries into a batch of their own. Returns null when the
   * buffer is empty, otherwise the batch's id.
   */
  async claim(size: number, now: Date): Promise<string | null> {
    const id = randomUUID();
    const moved = (await this.redis.eval(
      CLAIM_SCRIPT,
      3,
      BUFFER_KEY,
      batchKey(id),
      REGISTRY_KEY,
      size,
      id,
      now.getTime()
    )) as number;
    return moved > 0 ? id : null;
  }

  /** The entries of a batch. Unreadable entries are skipped and counted, not retried forever. */
  async read(id: string): Promise<RequestLogEntry[]> {
    const raw = await this.redis.lrange(batchKey(id), 0, -1);
    const entries: RequestLogEntry[] = [];
    for (const item of raw) {
      try {
        entries.push(JSON.parse(item) as RequestLogEntry);
      } catch {
        apiRequestLogsDropped.inc({ reason: 'corrupt' });
      }
    }
    return entries;
  }

  /** Forgets a batch after its entries are stored. */
  async finish(id: string): Promise<void> {
    await this.redis.multi().del(batchKey(id)).zrem(REGISTRY_KEY, id).exec();
  }

  /** Ids of batches whose worker stopped before finishing them. */
  async orphans(now: Date): Promise<string[]> {
    return this.redis.zrangebyscore(REGISTRY_KEY, '-inf', now.getTime() - ORPHAN_AFTER_MS);
  }
}

function batchKey(id: string): string {
  return `apilog:batch:${id}`;
}
