/**
 * `last_used_at` for API keys, kept off the request path (spec 8.3, 9.2 rule 10).
 *
 * A request does one fire-and-forget `ZADD GT` into `apikey:last-used`; the worker pops
 * the set every 10 seconds and writes the latest time per key in one statement. A crash
 * between pop and write loses at most 10 seconds of a purely informational timestamp.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Executor } from '../db/database.types';
import { DB_RW } from '../db/tokens';
import { toLoggableError } from '../logging/redaction';
import { REDIS } from '../redis/redis.module';
import { ROOT_LOGGER } from '../tokens';

const SET_KEY = 'apikey:last-used';
const FLUSH_BATCH = 1000;

@Injectable()
export class ApiKeyUsageTracker {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Records that `apiKeyId` (the internal id) was used at `at`. Never throws, never waits. */
  touch(apiKeyId: string, at: Date): void {
    this.redis.zadd(SET_KEY, 'GT', at.getTime(), apiKeyId).catch((error: unknown) => {
      this.logger.warn({ err: toLoggableError(error) }, 'api key usage not recorded');
    });
  }

  /** Writes pending usage to Postgres. Returns how many keys were updated. */
  async flush(): Promise<number> {
    const popped = await this.redis.zpopmin(SET_KEY, FLUSH_BATCH);
    if (popped.length === 0) return 0;
    const ids: string[] = [];
    const times: string[] = [];
    for (let i = 0; i < popped.length; i += 2) {
      ids.push(String(popped[i]));
      times.push(new Date(Number(popped[i + 1])).toISOString());
    }
    try {
      const rows = ids.map((id, i) => sql`(${id}::uuid, ${times[i]}::timestamptz)`);
      await this.db.execute(sql`
        update core.api_keys k set last_used_at = v.used_at
          from (values ${sql.join(rows, sql`, `)}) as v(id, used_at)
         where k.id = v.id and (k.last_used_at is null or k.last_used_at < v.used_at)`);
    } catch (error) {
      // Put the entries back so the next flush retries them.
      for (let i = 0; i < ids.length; i++) {
        await this.redis.zadd(SET_KEY, 'GT', Date.parse(times[i] ?? ''), ids[i] ?? '');
      }
      throw error;
    }
    return ids.length;
  }
}
