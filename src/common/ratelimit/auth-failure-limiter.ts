/**
 * Limits failed API key authentications per client (spec 8.5, "rate-limit bypass"): a client
 * that sends too many unauthenticated or wrongly authenticated requests is answered 429
 * before its credentials are looked at, so guessing keys is slowed, and cannot reach the
 * database.
 *
 * Failures are counted per IPv4 address, and per /64 for IPv6, because one subscriber
 * normally owns a whole /64 and could otherwise rotate through 2^64 addresses. Only
 * failures count: a client with a good key is never limited by this until it has already
 * failed `RATE_LIMIT_AUTH_FAILURE_PER_MIN` times in the last minute. Behind a shared NAT one
 * misbehaving client therefore blocks its neighbours for up to a minute; the limit is
 * generous for that reason.
 *
 * The client address is `request.ip`, derived from `TRUST_PROXY` only (spec 11).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { clientSubject } from '../http/client-ip';
import { REDIS } from '../redis/redis.module';
import { rateLimitRejections } from '../telemetry/metrics';
import { toLoggableError } from '../logging/redaction';
import { APP_CONFIG, ROOT_LOGGER } from '../tokens';
import type { Logger } from 'pino';
import { RateLimiter, type LimitSpec } from './rate-limiter';

const WINDOW_SECONDS = 60;

const PEEK_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]) * 1000)
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then return { 0, 0 } end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return { 1, math.max(math.ceil((tonumber(oldest[2]) + tonumber(ARGV[1]) * 1000 - now) / 1000), 1) }`;

@Injectable()
export class AuthFailureLimiter {
  constructor(
    private readonly limiter: RateLimiter,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'RATE_LIMIT_AUTH_FAILURE_PER_MIN'>,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  private spec(ip: string): LimitSpec {
    return {
      kind: 'window',
      scope: 'auth_failures',
      key: `rl:authfail:${clientSubject(ip)}`,
      limit: this.config.RATE_LIMIT_AUTH_FAILURE_PER_MIN,
      windowSeconds: WINDOW_SECONDS,
    };
  }

  /** Throws 429 when this client has used up its failures. Never reads the credentials. */
  async assertNotBlocked(ip: string): Promise<void> {
    const spec = this.spec(ip);
    if (spec.kind !== 'window') return;
    let reply: [number, number];
    try {
      reply = (await this.redis.eval(PEEK_SCRIPT, 1, spec.key, spec.windowSeconds, spec.limit)) as [
        number,
        number,
      ];
    } catch (error) {
      // This limit only slows guessing; the per-key limits still fail closed for writes.
      this.logger.warn({ err: toLoggableError(error) }, 'auth failure limiter unavailable');
      return;
    }
    const [blocked, retryAfter] = reply;
    if (blocked === 1) {
      rateLimitRejections.inc({ scope: 'auth_failures' });
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: retryAfter });
    }
  }

  /** Counts one failed attempt. */
  async recordFailure(ip: string): Promise<void> {
    try {
      await this.limiter.consume([this.spec(ip)]);
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'auth failure not recorded');
    }
  }
}
