/**
 * Redis rate limiting (spec 8.5). All limits for a request are evaluated by one Lua script,
 * so the check is a single round trip and atomic: concurrent requests cannot both take the
 * last slot, and a request refused by one limit consumes nothing from the others.
 *
 * Two kinds of limit:
 *  - `window`: a sliding window log (sorted set of request times). Exact, and a refused
 *    request is not recorded, so hammering a limit does not extend the lock-out.
 *  - `bucket`: a token bucket (capacity, refill per second) for bursts.
 *
 * Time comes from Redis (`TIME`), never from the caller, so replicas with skewed clocks
 * agree. Every key expires: a window key after its window, a bucket key after it would have
 * refilled completely, so idle keys vanish.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';

export type RateLimitScope =
  'key_read' | 'key_write' | 'merchant_payouts' | 'key_burst' | 'auth_failures';

export type LimitSpec =
  | {
      readonly kind: 'window';
      readonly scope: RateLimitScope;
      readonly key: string;
      readonly limit: number;
      readonly windowSeconds: number;
    }
  | {
      readonly kind: 'bucket';
      readonly scope: RateLimitScope;
      readonly key: string;
      readonly capacity: number;
      readonly refillPerSecond: number;
    };

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The limit that refused the request, or the first spec when allowed. */
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds at which the limit has room again (or the window next slides). */
  readonly resetAtSeconds: number;
  /** Seconds to wait before retrying; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

const SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local specs = tonumber(ARGV[1])
local member = ARGV[2]
local plan = {}
for i = 1, specs do
  local base = 3 + (i - 1) * 3
  local kind = ARGV[base]
  local a = tonumber(ARGV[base + 1])
  local b = tonumber(ARGV[base + 2])
  if kind == 'w' then
    local window = b * 1000
    redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
    local count = redis.call('ZCARD', KEYS[i])
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local reset = now + window
    if oldest[2] then reset = tonumber(oldest[2]) + window end
    if count >= a then
      return { 0, i, a, 0, reset, math.max(reset - now, 1) }
    end
    plan[i] = { 'w', a, a - count - 1, reset, window }
  else
    local data = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
    local tokens = tonumber(data[1])
    local ts = tonumber(data[2])
    if tokens == nil then
      tokens = a
      ts = now
    end
    tokens = math.min(a, tokens + ((now - ts) / 1000) * b)
    if tokens < 1 then
      local wait = math.ceil(((1 - tokens) / b) * 1000)
      return { 0, i, a, 0, now + wait, wait }
    end
    plan[i] = { 'b', a, math.floor(tokens - 1), now + math.ceil(((a - tokens + 1) / b) * 1000), tokens - 1 }
  end
end
for i = 1, specs do
  local p = plan[i]
  if p[1] == 'w' then
    redis.call('ZADD', KEYS[i], now, member)
    redis.call('PEXPIRE', KEYS[i], p[5] + 1000)
  else
    redis.call('HSET', KEYS[i], 'tokens', tostring(p[5]), 'ts', now)
    local ttl = math.ceil((tonumber(ARGV[3 + (i - 1) * 3 + 1]) / tonumber(ARGV[3 + (i - 1) * 3 + 2])) * 1000) * 2 + 1000
    redis.call('PEXPIRE', KEYS[i], ttl)
  end
end
return { 1, 1, plan[1][2], plan[1][3], plan[1][4], 0 }`;

@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Takes one unit from every spec, or from none if any refuses. Throws if Redis cannot be
   * reached: the caller decides whether to fail open (reads) or closed (writes).
   */
  async consume(specs: readonly LimitSpec[]): Promise<RateLimitDecision> {
    if (specs.length === 0) throw new Error('consume needs at least one limit');
    const args: (string | number)[] = [specs.length, randomBytes(8).toString('hex')];
    for (const spec of specs) {
      if (spec.kind === 'window') args.push('w', spec.limit, spec.windowSeconds);
      else args.push('b', spec.capacity, spec.refillPerSecond);
    }
    const reply = (await this.redis.eval(
      SCRIPT,
      specs.length,
      ...specs.map((s) => s.key),
      ...args
    )) as [number, number, number, number, number, number];
    const [allowed, index, limit, remaining, resetMs, retryMs] = reply;
    const spec = specs[Math.max(0, index - 1)] ?? specs[0];
    return {
      allowed: allowed === 1,
      scope: (spec as LimitSpec).scope,
      limit,
      remaining: Math.max(0, remaining),
      resetAtSeconds: Math.ceil(resetMs / 1000),
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
    };
  }
}
