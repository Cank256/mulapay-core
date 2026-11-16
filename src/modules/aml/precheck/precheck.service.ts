/**
 * Pre-transaction AML controls (spec 6.13 step 2): synchronous, Redis-backed, and fast. Run
 * before a live payment is created, so a declined payment never exists.
 *
 * Three checks, in this order, each cheap:
 *  1. merchant status, from the authenticated scope (no query);
 *  2. the blocklist, one Redis pipeline for every identifier on the payment;
 *  3. hard limits: the per-transaction cap from cached limits, then the daily and monthly
 *     volume counters in one Lua script that checks and increments atomically.
 *
 * Nothing here calls a provider, screens a name or runs a SQL aggregate on the hot path. A
 * counter that does not exist yet (first payment of the day or month, or after a Redis
 * flush) is rebuilt once from the database and the script retried.
 *
 * Invariants upheld:
 *  - A counter is never incremented for a payment that was declined by a limit.
 *  - Redis is a risk control, not financial truth. If Redis cannot answer, the payment is
 *    declined with 503: fail closed. A payment that is created and then rolled back leaves
 *    its volume counted until the counter is rebuilt, which errs on the side of the limit.
 *  - A decline for the blocklist says nothing about why (`TRANSACTION_DECLINED`), so a
 *    merchant cannot probe the list. A decline for a limit names the limit, which belongs to
 *    the merchant.
 *  - Amounts above 2^53 - 1 minor units are declined: the counters hold exact integers only
 *    up to there.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MerchantScope } from '../../../common/auth/merchant-scope';
import type { Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/errors/app-error';
import { toLoggableError } from '../../../common/logging/redaction';
import { REDIS } from '../../../common/redis/redis.module';
import { amlPrecheckDuration, amlPrecheckOutcomes } from '../../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../../common/tokens';
import { AmlBlocklistService, type BlocklistCandidate } from '../blocklist/aml-blocklist.service';
import { MerchantLimitsRepository } from '../limits/merchant-limits.repository';
import { MerchantLimitsService } from '../limits/merchant-limits.service';

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DAY_TTL_SECONDS = 2 * 86_400;
const MONTH_TTL_SECONDS = 35 * 86_400;

/**
 * KEYS: day counter, month counter. ARGV: amount, day max, month max, day ttl, month ttl.
 * Returns {0} when both were raised, {1, current} past the day limit, {2, current} past the
 * month limit, {-1} when a counter has to be built first. All numbers are exact below 2^53.
 */
const CHECK_AND_INCREMENT = `
local day = redis.call('GET', KEYS[1])
local month = redis.call('GET', KEYS[2])
if (not day) or (not month) then return {-1, 0} end
local amount = tonumber(ARGV[1])
if tonumber(day) + amount > tonumber(ARGV[2]) then return {1, tonumber(day)} end
if tonumber(month) + amount > tonumber(ARGV[3]) then return {2, tonumber(month)} end
redis.call('INCRBY', KEYS[1], amount)
redis.call('INCRBY', KEYS[2], amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return {0, 0}
`;

export interface PrecheckInput {
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Identifiers to look up on the blocklist. */
  readonly identifiers: readonly BlocklistCandidate[];
}

export function dayWindow(now: Date): { key: string; start: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { key: start.toISOString().slice(0, 10).replace(/-/g, ''), start };
}

export function monthWindow(now: Date): { key: string; start: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { key: start.toISOString().slice(0, 7).replace(/-/g, ''), start };
}

@Injectable()
export class AmlPrecheckService {
  constructor(
    private readonly blocklist: AmlBlocklistService,
    private readonly limits: MerchantLimitsService,
    private readonly limitsRepository: MerchantLimitsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Throws `TRANSACTION_DECLINED`, `TRANSACTION_LIMIT_EXCEEDED` or `SERVICE_UNAVAILABLE`.
   * Test-environment payments are not checked: test keys carry no live traffic.
   */
  async check(scope: MerchantScope, input: PrecheckInput): Promise<void> {
    if (scope.environment !== 'live') return;
    const started = process.hrtime.bigint();
    let outcome = 'passed';
    try {
      await this.run(scope, input);
    } catch (error) {
      outcome =
        error instanceof AppError
          ? error.code === 'TRANSACTION_LIMIT_EXCEEDED'
            ? 'limit'
            : 'declined'
          : 'unavailable';
      if (!(error instanceof AppError)) {
        this.logger.error(
          { err: toLoggableError(error), merchantId: scope.merchantId },
          'aml pre-check could not run; declining the transaction'
        );
        throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
      }
      throw error;
    } finally {
      amlPrecheckDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
      amlPrecheckOutcomes.inc({ outcome });
    }
  }

  private async run(scope: MerchantScope, input: PrecheckInput): Promise<void> {
    if (scope.merchantStatus !== 'active') throw new AppError('MERCHANT_NOT_ACTIVE');
    if (input.amountMinor <= 0n || input.amountMinor > SAFE_MAX) {
      throw new AppError('TRANSACTION_DECLINED');
    }
    if (await this.blocklist.isBlocked(input.identifiers)) {
      throw new AppError('TRANSACTION_DECLINED');
    }
    const limits = await this.limits.effective(scope.merchantId, input.currency);
    if (!limits) {
      this.logger.warn(
        { merchantId: scope.merchantId, currency: input.currency },
        'live merchant has no limits for this currency; declining'
      );
      throw new AppError('TRANSACTION_DECLINED');
    }
    if (input.amountMinor > limits.perTxnMaxMinor) {
      throw this.exceeded('per_transaction', limits.perTxnMaxMinor, input.currency);
    }
    await this.countVolume(scope, input, limits.dailyVolumeMaxMinor, limits.monthlyVolumeMaxMinor);
  }

  private async countVolume(
    scope: MerchantScope,
    input: PrecheckInput,
    dailyMax: bigint,
    monthlyMax: bigint
  ): Promise<void> {
    const now = this.clock.now();
    const day = dayWindow(now);
    const month = monthWindow(now);
    const prefix = `aml:vol:${scope.merchantId}:${input.currency}`;
    const keys = [`${prefix}:d:${day.key}`, `${prefix}:m:${month.key}`];
    const args = [
      input.amountMinor,
      dailyMax > SAFE_MAX ? SAFE_MAX : dailyMax,
      monthlyMax > SAFE_MAX ? SAFE_MAX : monthlyMax,
      DAY_TTL_SECONDS,
      MONTH_TTL_SECONDS,
    ].map(String);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [code, current] = (await this.redis.eval(CHECK_AND_INCREMENT, 2, ...keys, ...args)) as [
        number,
        number,
      ];
      if (code === 0) return;
      if (code === 1) throw this.exceeded('daily_volume', dailyMax, input.currency, current);
      if (code === 2) throw this.exceeded('monthly_volume', monthlyMax, input.currency, current);
      await this.rebuild(scope.merchantId, input.currency, keys, [day.start, month.start]);
    }
    throw new Error('volume counters could not be built');
  }

  /** Builds missing counters from the database. `NX`, so a concurrent increment is never overwritten. */
  private async rebuild(
    merchantId: string,
    currency: string,
    keys: readonly string[],
    starts: readonly Date[]
  ): Promise<void> {
    for (const [i, key] of keys.entries()) {
      const start = starts[i] as Date;
      const total = await this.limitsRepository.liveVolumeSince(merchantId, currency, start);
      await this.redis.set(
        key,
        String(total > SAFE_MAX ? SAFE_MAX : total),
        'EX',
        i === 0 ? DAY_TTL_SECONDS : MONTH_TTL_SECONDS,
        'NX'
      );
    }
  }

  private exceeded(limit: string, max: bigint, currency: string, current?: number): AppError {
    return new AppError('TRANSACTION_LIMIT_EXCEEDED', {
      details: {
        limit,
        currency,
        max: max.toString(),
        ...(current === undefined ? {} : { used: String(current) }),
      },
    });
  }
}
