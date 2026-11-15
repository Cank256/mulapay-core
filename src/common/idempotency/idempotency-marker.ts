/**
 * The Redis side of idempotency (spec 8.2 step 3): `SET idem:{merchant}:{env}:{operation}:{key}
 * <fingerprint> NX EX 86400`.
 *
 * Redis is a fast check, not the authority. Postgres decides (the unique index on
 * `idempotency_keys`), so when Redis is down or has lost the key the request still takes the
 * correct path; the only thing lost is the early 409 for a reused key.
 *
 * The marker is removed again when the request leaves nothing behind (it failed and rolled
 * back), so a client that fixes a rejected request can retry under the same key. A crash
 * between the two steps leaves a marker that expires after 24 hours and only affects a
 * retry with a different body (409) until then.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MerchantScope } from '../auth/merchant-scope';
import { toLoggableError } from '../logging/redaction';
import { REDIS } from '../redis/redis.module';
import { ROOT_LOGGER } from '../tokens';
import type { IdempotencyContext } from './idempotency.types';

export const IDEMPOTENCY_TTL_SECONDS = 86_400;

export type MarkerState = 'reserved' | 'same' | 'different' | 'unavailable';

/** Deletes the key only if it still holds our fingerprint. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`;

@Injectable()
export class IdempotencyMarker {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  static redisKey(scope: MerchantScope, ctx: IdempotencyContext): string {
    return `idem:${scope.merchantId}:${scope.environment}:${ctx.operation}:${ctx.key}`;
  }

  async reserve(scope: MerchantScope, ctx: IdempotencyContext): Promise<MarkerState> {
    const key = IdempotencyMarker.redisKey(scope, ctx);
    try {
      const set = await this.redis.set(key, ctx.fingerprint, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
      if (set === 'OK') return 'reserved';
      const current = await this.redis.get(key);
      if (current === null) return 'unavailable';
      return current === ctx.fingerprint ? 'same' : 'different';
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'idempotency marker unavailable');
      return 'unavailable';
    }
  }

  async release(scope: MerchantScope, ctx: IdempotencyContext): Promise<void> {
    try {
      await this.redis.eval(
        RELEASE_SCRIPT,
        1,
        IdempotencyMarker.redisKey(scope, ctx),
        ctx.fingerprint
      );
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'idempotency marker release failed');
    }
  }
}
