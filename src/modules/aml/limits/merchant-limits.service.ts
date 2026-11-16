/**
 * A merchant's live limits per currency (spec 5.2 `merchant_limits`, 6.10).
 *
 * The database is the source of the limits; Redis holds a 60-second copy of them
 * (`aml:limits:{merchantId}`, one field per currency) so the pre-transaction check does not
 * query. `applyLevel` writes the limits of a KYC level in the caller's transaction, and the
 * caller drops the cached copy after commit (`invalidate`).
 *
 * A merchant without its own row for a currency uses the limits of its current KYC level.
 * With neither there are no limits to check against, and the caller refuses the transaction:
 * a live merchant is never unlimited by omission.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Executor } from '../../../common/db/database.types';
import { REDIS } from '../../../common/redis/redis.module';
import { MerchantLimitsRepository, type LimitValues } from './merchant-limits.repository';

const CACHE_SECONDS = 60;
const cacheKey = (merchantId: string) => `aml:limits:${merchantId}`;

/** Limits as the check uses them: all amounts as bigint minor units. */
export type EffectiveLimits = LimitValues;

interface Cached {
  readonly none?: true;
  readonly perTxn?: string;
  readonly daily?: string;
  readonly monthly?: string;
  readonly payoutPerTxn?: string;
  readonly dailyPayout?: string;
}

@Injectable()
export class MerchantLimitsService {
  constructor(
    private readonly limits: MerchantLimitsRepository,
    @Inject(REDIS) private readonly redis: Redis
  ) {}

  /** The limits in force for a currency, from cache or the database; null when there are none. */
  async effective(merchantId: string, currency: string): Promise<EffectiveLimits | null> {
    const hit = await this.redis.hget(cacheKey(merchantId), currency);
    if (hit !== null) return this.decode(JSON.parse(hit) as Cached);
    const found =
      (await this.limits.find(merchantId, currency)) ??
      (await this.limits.levelFallback(merchantId, currency));
    const value: Cached = found
      ? {
          perTxn: found.perTxnMaxMinor.toString(),
          daily: found.dailyVolumeMaxMinor.toString(),
          monthly: found.monthlyVolumeMaxMinor.toString(),
          payoutPerTxn: found.payoutPerTxnMaxMinor.toString(),
          dailyPayout: found.dailyPayoutMaxMinor.toString(),
        }
      : { none: true };
    await this.redis
      .multi()
      .hset(cacheKey(merchantId), currency, JSON.stringify(value))
      .expire(cacheKey(merchantId), CACHE_SECONDS)
      .exec();
    return this.decode(value);
  }

  /** Writes the limits of `level` for the merchant. Call `invalidate` after commit. */
  applyLevel(
    tx: Executor,
    merchantId: string,
    level: number,
    appliesWhen: 'approved' | 'expired' = 'approved'
  ): Promise<number> {
    return this.limits.applyLevel(tx, merchantId, level, appliesWhen);
  }

  async invalidate(merchantId: string): Promise<void> {
    await this.redis.del(cacheKey(merchantId));
  }

  list(merchantId: string) {
    return this.limits.listForMerchant(merchantId);
  }

  private decode(value: Cached): EffectiveLimits | null {
    if (value.none || !value.perTxn) return null;
    return {
      perTxnMaxMinor: BigInt(value.perTxn),
      dailyVolumeMaxMinor: BigInt(value.daily ?? value.perTxn),
      monthlyVolumeMaxMinor: BigInt(value.monthly ?? value.perTxn),
      payoutPerTxnMaxMinor: BigInt(value.payoutPerTxn ?? value.perTxn),
      dailyPayoutMaxMinor: BigInt(value.dailyPayout ?? value.perTxn),
    };
  }
}
