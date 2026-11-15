/**
 * Login protection (spec section 8.3): progressive lockout after 5 failures, for 1, 2, 5,
 * 15 and then 60 minutes, per account and per IP.
 *
 * Accounts are keyed by a hash of the normalised email, whether or not the account
 * exists, so an unknown email locks out exactly like a real one and the response never
 * reveals which emails are registered. Counters reset 24 hours after the last failure.
 * The account counter clears on a successful login; the IP counter does not, so one
 * working account cannot be used to reset an IP that is guessing others.
 *
 * Wrong MFA codes count as failures too.
 *
 * Fails closed: without Redis, logins are refused with 503.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Clock } from '../../common/clock/clock';
import { sha256Hex } from '../../common/crypto/crypto';
import { AppError } from '../../common/errors/app-error';
import { REDIS } from '../../common/redis/redis.module';
import { CLOCK } from '../../common/tokens';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = [1, 2, 5, 15, 60] as const;
const COUNTER_TTL_SECONDS = 24 * 60 * 60;

/** Lock duration after the `failures`-th consecutive failure, or 0 below the threshold. */
export function lockoutMinutes(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0;
  const index = Math.min(failures - LOCKOUT_THRESHOLD, LOCKOUT_MINUTES.length - 1);
  return LOCKOUT_MINUTES[index] ?? 60;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Scope = 'acct' | 'ip';

export interface FailureResult {
  readonly accountFailures: number;
  /** Set when this failure started a lock on the account. */
  readonly accountLockedUntil: Date | null;
}

@Injectable()
export class LoginThrottle {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Throws TOO_MANY_LOGIN_ATTEMPTS (with Retry-After) while the account or IP is locked. */
  async assertNotLocked(email: string, ip: string, dbLockedUntil: Date | null = null) {
    const now = this.clock.now().getTime();
    const [account, address] = await this.guard(() =>
      this.redis.mget(this.key('lock', 'acct', email), this.key('lock', 'ip', ip))
    );
    const until = Math.max(
      Number(account ?? 0),
      Number(address ?? 0),
      dbLockedUntil?.getTime() ?? 0
    );
    if (until > now) {
      throw new AppError('TOO_MANY_LOGIN_ATTEMPTS', { retryAfterSeconds: (until - now) / 1000 });
    }
  }

  async recordFailure(email: string, ip: string): Promise<FailureResult> {
    const [accountFailures, ipFailures] = await this.guard(async () => {
      const results = await this.redis
        .multi()
        .incr(this.key('fail', 'acct', email))
        .expire(this.key('fail', 'acct', email), COUNTER_TTL_SECONDS)
        .incr(this.key('fail', 'ip', ip))
        .expire(this.key('fail', 'ip', ip), COUNTER_TTL_SECONDS)
        .exec();
      return [Number(results?.[0]?.[1] ?? 0), Number(results?.[2]?.[1] ?? 0)];
    });
    const accountLockedUntil = await this.lock('acct', email, accountFailures);
    await this.lock('ip', ip, ipFailures);
    return { accountFailures, accountLockedUntil };
  }

  async recordSuccess(email: string): Promise<void> {
    await this.guard(() =>
      this.redis.del(this.key('fail', 'acct', email), this.key('lock', 'acct', email))
    );
  }

  private async lock(scope: Scope, subject: string, failures: number): Promise<Date | null> {
    const minutes = lockoutMinutes(failures);
    if (minutes === 0) return null;
    const until = new Date(this.clock.now().getTime() + minutes * 60_000);
    // The value carries the deadline so a test clock decides expiry; the TTL only cleans up.
    await this.guard(() =>
      this.redis.set(
        this.key('lock', scope, subject),
        String(until.getTime()),
        'EX',
        minutes * 60 + 3600
      )
    );
    return until;
  }

  private key(kind: 'fail' | 'lock', scope: Scope, subject: string): string {
    const id = scope === 'acct' ? sha256Hex(normaliseEmail(subject)) : sha256Hex(subject);
    return `auth:login-${kind}:${scope}:${id}`;
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
