/**
 * Per-key rate limits on the public API (spec 8.5), applied after authentication, in this
 * order with the first breach winning: the key's read or write window, the merchant's payout
 * window (routes that need `payouts:write`), and the key's burst bucket.
 *
 * Limits are keyed by the API key and merchant, never by IP or path: changing the client
 * address, a forwarding header, the casing or trailing slash of a path, or the query string
 * cannot buy a new bucket. A request refused here consumes nothing from any limit.
 *
 * Every response to an authenticated request carries `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a 429 also carries `Retry-After`.
 *
 * If Redis is down, reads are let through (and logged) and writes are refused with 503: an
 * outage must not remove the cap on writes that move money.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { POLICY, type Policy } from '../authz/policy.decorators';
import { AppError } from '../errors/app-error';
import { toLoggableError } from '../logging/redaction';
import { rateLimitRejections } from '../telemetry/metrics';
import { APP_CONFIG, ROOT_LOGGER } from '../tokens';
import type { ApiKeyPrincipal } from '../auth/principal';
import { RateLimiter, type LimitSpec } from './rate-limiter';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WINDOW_SECONDS = 60;

type RateLimitConfig = Pick<
  AppConfig,
  | 'RATE_LIMIT_WRITE_PER_MIN'
  | 'RATE_LIMIT_READ_PER_MIN'
  | 'RATE_LIMIT_PAYOUT_PER_MIN'
  | 'RATE_LIMIT_BURST_CAPACITY'
  | 'RATE_LIMIT_BURST_REFILL_PER_SECOND'
>;

/**
 * The limits that apply to one request. `rateLimitRpm` overrides the key's write limit; the
 * read limit never drops below the write limit, so a raised override cannot make reads
 * stricter than writes.
 */
export function limitsFor(
  key: Pick<ApiKeyPrincipal, 'apiKeyId' | 'merchant' | 'environment' | 'rateLimitRpm'>,
  options: { readonly write: boolean; readonly payout: boolean },
  config: RateLimitConfig
): LimitSpec[] {
  const writeLimit = key.rateLimitRpm ?? config.RATE_LIMIT_WRITE_PER_MIN;
  const readLimit = Math.max(config.RATE_LIMIT_READ_PER_MIN, writeLimit);
  const specs: LimitSpec[] = [
    options.write
      ? {
          kind: 'window',
          scope: 'key_write',
          key: `rl:key:${key.apiKeyId}:w`,
          limit: writeLimit,
          windowSeconds: WINDOW_SECONDS,
        }
      : {
          kind: 'window',
          scope: 'key_read',
          key: `rl:key:${key.apiKeyId}:r`,
          limit: readLimit,
          windowSeconds: WINDOW_SECONDS,
        },
  ];
  if (options.payout) {
    specs.push({
      kind: 'window',
      scope: 'merchant_payouts',
      key: `rl:merchant:${key.merchant.id}:${key.environment}:payouts`,
      limit: config.RATE_LIMIT_PAYOUT_PER_MIN,
      windowSeconds: WINDOW_SECONDS,
    });
  }
  specs.push({
    kind: 'bucket',
    scope: 'key_burst',
    key: `rl:key:${key.apiKeyId}:burst`,
    capacity: config.RATE_LIMIT_BURST_CAPACITY,
    refillPerSecond: config.RATE_LIMIT_BURST_REFILL_PER_SECOND,
  });
  return specs;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: RateLimitConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const principal = request.principal;
    if (principal?.kind !== 'api_key') return true;
    const policy = this.reflector.getAllAndOverride<Policy | undefined>(POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const write = WRITE_METHODS.has(request.method);
    const payout = policy?.kind === 'permission' && policy.permission === 'payouts:write';
    const specs = limitsFor(principal, { write, payout }, this.config);
    let decision;
    try {
      decision = await this.limiter.consume(specs);
    } catch (error) {
      if (write) throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
      this.logger.warn({ err: toLoggableError(error) }, 'rate limiting unavailable; read allowed');
      return true;
    }
    const reply = http.getResponse<FastifyReply>();
    void reply.header('X-RateLimit-Limit', String(decision.limit));
    void reply.header('X-RateLimit-Remaining', String(decision.remaining));
    void reply.header('X-RateLimit-Reset', String(decision.resetAtSeconds));
    if (!decision.allowed) {
      rateLimitRejections.inc({ scope: decision.scope });
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: decision.retryAfterSeconds });
    }
    return true;
  }
}
