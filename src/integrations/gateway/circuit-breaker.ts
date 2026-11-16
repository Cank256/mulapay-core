/**
 * Circuit breaker per (provider, operation) (spec 6.2): open after 5 consecutive ambiguous
 * or 5xx outcomes within 30 seconds, half-open after 15 seconds, closed after 3 successes.
 *
 * `nextBreakerState` is pure so every transition is unit-tested. `RedisCircuitBreaker`
 * keeps the state in Redis so all API replicas share it, updating with optimistic
 * WATCH/MULTI. Redis is not a source of financial truth: if it is unreachable the breaker
 * fails open (calls are allowed) and logs, because blocking payments on a cache outage
 * would be worse than losing the breaker.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { toLoggableError } from '../../common/logging/redaction';
import { REDIS } from '../../common/redis/redis.module';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
export type BreakerMode = 'closed' | 'open' | 'half_open';
export interface BreakerState {
  readonly mode: BreakerMode;
  /** Consecutive failures in the current window (closed mode). */
  readonly failures: number;
  readonly windowStartedAt: number;
  readonly openedAt: number;
  /** Successful probes while half-open. */
  readonly successes: number;
}
export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly failureWindowMs: number;
  readonly resetMs: number;
  readonly closeAfterSuccesses: number;
}
export const CLOSED: BreakerState = {
  mode: 'closed',
  failures: 0,
  windowStartedAt: 0,
  openedAt: 0,
  successes: 0,
};
export type BreakerEvent = 'success' | 'failure';
/**
 * The state after an outcome. Success while closed clears the failure run; failure while
 * closed extends it, or starts a new window if the last failure is older than the window.
 */
export function nextBreakerState(
  state: BreakerState,
  event: BreakerEvent,
  now: number,
  config: BreakerConfig
): BreakerState {
  if (state.mode === 'open') {
    // Outcomes of calls started before the breaker opened do not change an open breaker.
    return state;
  }
  if (state.mode === 'half_open') {
    if (event === 'failure') {
      return { ...CLOSED, mode: 'open', openedAt: now, windowStartedAt: now };
    }
    const successes = state.successes + 1;
    return successes >= config.closeAfterSuccesses ? CLOSED : { ...state, successes };
  }
  if (event === 'success') return state.failures === 0 ? state : CLOSED;
  const fresh = state.failures === 0 || now - state.windowStartedAt > config.failureWindowMs;
  const failures = fresh ? 1 : state.failures + 1;
  const windowStartedAt = fresh ? now : state.windowStartedAt;
  if (failures >= config.failureThreshold) {
    return { mode: 'open', failures, windowStartedAt, openedAt: now, successes: 0 };
  }
  return { mode: 'closed', failures, windowStartedAt, openedAt: 0, successes: 0 };
}
/** Whether a call may start, and the state to store when the answer changes it. */
export function admit(
  state: BreakerState,
  now: number,
  config: BreakerConfig
): { readonly allowed: boolean; readonly next: BreakerState } {
  if (state.mode !== 'open') return { allowed: true, next: state };
  if (now - state.openedAt >= config.resetMs) {
    return { allowed: true, next: { ...state, mode: 'half_open', successes: 0 } };
  }
  return { allowed: false, next: state };
}
const KEY_TTL_SECONDS = 3600;
const MAX_CAS_ATTEMPTS = 8;
const CAS_SCRIPT = `
local current = redis.call('get', KEYS[1])
if (current == false and ARGV[1] == '') or current == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
end
return 0`;
@Injectable()
export class RedisCircuitBreaker {
  private readonly config: BreakerConfig;
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) config: AppConfig
  ) {
    this.config = {
      failureThreshold: config.GATEWAY_CIRCUIT_FAILURE_THRESHOLD,
      failureWindowMs: 30_000,
      resetMs: config.GATEWAY_CIRCUIT_RESET_MS,
      closeAfterSuccesses: 3,
    };
  }
  /** True when a call may be made now. Moves an expired open breaker to half-open. */
  async allow(provider: string, operation: string): Promise<boolean> {
    try {
      let allowed = true;
      await this.update(provider, operation, (state, now) => {
        const decision = admit(state, now, this.config);
        allowed = decision.allowed;
        return decision.next;
      });
      return allowed;
    } catch (error) {
      this.failOpen(error);
      return true;
    }
  }
  async record(provider: string, operation: string, event: BreakerEvent): Promise<BreakerMode> {
    try {
      const next = await this.update(provider, operation, (state, now) =>
        nextBreakerState(state, event, now, this.config)
      );
      return next.mode;
    } catch (error) {
      this.failOpen(error);
      return 'closed';
    }
  }
  async mode(provider: string, operation: string): Promise<BreakerMode> {
    try {
      return (await this.read(this.key(provider, operation))).state.mode;
    } catch (error) {
      this.failOpen(error);
      return 'closed';
    }
  }
  private key(provider: string, operation: string): string {
    return `core:cb:gateway:${provider}:${operation}`;
  }
  private async read(key: string): Promise<{ state: BreakerState; raw: string }> {
    const raw = (await this.redis.get(key)) ?? '';
    return { state: raw ? (JSON.parse(raw) as BreakerState) : CLOSED, raw };
  }
  /**
   * Compare-and-set in one Lua script, so concurrent updates (in this process or another
   * replica) cannot overwrite each other; the loser re-reads and recomputes. WATCH is not
   * used because it is per connection and this client is shared.
   */
  private async update(
    provider: string,
    operation: string,
    change: (state: BreakerState, now: number) => BreakerState
  ): Promise<BreakerState> {
    const key = this.key(provider, operation);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { state, raw } = await this.read(key);
      const next = change(state, this.clock.now().getTime());
      if (next === state) return next;
      const swapped = await this.redis.eval(
        CAS_SCRIPT,
        1,
        key,
        raw,
        JSON.stringify(next),
        String(KEY_TTL_SECONDS)
      );
      if (swapped === 1) return next;
    }
    throw new Error('circuit breaker update lost the race too often');
  }
  private failOpen(error: unknown): void {
    this.logger.warn(
      { err: toLoggableError(error) },
      'circuit breaker store unavailable; failing open'
    );
  }
}
