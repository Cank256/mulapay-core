/**
 * The rollup job and the dashboard analytics (spec 5.2, 9.2 rule 4).
 *
 * The job recomputes the figures of a UTC day from the transactions that reached a final state
 * that day (`RollupsRepository.recomputeDay`): every 15 minutes for today, and nightly for the
 * days before it, which picks up transactions that finished late. Recomputing replaces a day's
 * rows, so any run, repeated or overlapping with another, leaves the same numbers.
 *
 * Every dashboard tile reads the rollups and never the transactions: its cost is a range scan of
 * a few rows per day however many payments the merchant takes, which is what lets
 * `GET /merchant/v1/analytics/overview` answer in well under 150 ms (spec 9.1).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { AppError } from '../../common/errors/app-error';
import { rollupRuns } from '../../common/telemetry/metrics';
import { CLOCK } from '../../common/tokens';
import {
  RollupsRepository,
  type RollupChannelRow,
  type RollupSeriesRow,
} from './rollups.repository';

const DAY_MS = 86_400_000;
export const DEFAULT_ANALYTICS_DAYS = 30;
export const MAX_ANALYTICS_DAYS = 366;

export interface AnalyticsQuery {
  readonly from?: string;
  readonly to?: string;
  readonly currency?: string;
}

export interface CurrencyTotals {
  readonly currency: string;
  readonly paymentCount: number;
  readonly paymentMinor: bigint;
  readonly refundCount: number;
  readonly refundMinor: bigint;
  readonly payoutCount: number;
  readonly payoutMinor: bigint;
  readonly feeMinor: bigint;
  readonly successCount: number;
  readonly failureCount: number;
  /** Successes over finished payments, `null` when there were none. */
  readonly successRate: number | null;
}

@Injectable()
export class RollupsService {
  constructor(
    private readonly repository: RollupsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Recomputes the given UTC days (`YYYY-MM-DD`). Returns the rows written. */
  async recompute(days: readonly string[]): Promise<number> {
    let written = 0;
    try {
      for (const day of days) written += await this.repository.recomputeDay(day);
      rollupRuns.inc({ outcome: 'ok' });
      return written;
    } catch (error) {
      rollupRuns.inc({ outcome: 'failed' });
      throw error;
    }
  }

  /** Today, and yesterday during the first hour of the day, when late completions still land. */
  recomputeRecent(): Promise<number> {
    const now = this.clock.now();
    const today = isoDay(now);
    const days =
      now.getUTCHours() === 0 ? [isoDay(new Date(now.getTime() - DAY_MS)), today] : [today];
    return this.recompute(days);
  }

  /** The previous `count` full days: the nightly job. */
  recomputePrevious(count: number): Promise<number> {
    const now = this.clock.now();
    const days = Array.from({ length: count }, (_, i) =>
      isoDay(new Date(now.getTime() - (i + 1) * DAY_MS))
    );
    return this.recompute(days.reverse());
  }

  async overview(scope: MerchantScope, query: AnalyticsQuery) {
    const window = this.window(query);
    const series = await this.repository.series({
      ...base(scope),
      ...window,
      currency: query.currency,
    });
    return { ...window, currencies: totalsByCurrency(series) };
  }

  async volume(scope: MerchantScope, query: AnalyticsQuery) {
    const window = this.window(query);
    const series = await this.repository.series({
      ...base(scope),
      ...window,
      currency: query.currency,
    });
    return { ...window, points: series };
  }

  async successRate(scope: MerchantScope, query: AnalyticsQuery) {
    const window = this.window(query);
    const series = await this.repository.series({
      ...base(scope),
      ...window,
      currency: query.currency,
    });
    return {
      ...window,
      points: series.map((p) => ({
        day: p.day,
        currency: p.currency,
        successCount: p.successCount,
        failureCount: p.failureCount,
        successRate: rate(p.successCount, p.failureCount),
      })),
    };
  }

  async channels(
    scope: MerchantScope,
    query: AnalyticsQuery
  ): Promise<{
    from: string;
    to: string;
    channels: Array<RollupChannelRow & { successRate: number | null }>;
  }> {
    const window = this.window(query);
    const rows = await this.repository.channels({
      ...base(scope),
      ...window,
      currency: query.currency,
    });
    return {
      ...window,
      channels: rows.map((r) => ({ ...r, successRate: rate(r.successCount, r.failureCount) })),
    };
  }

  private window(query: AnalyticsQuery): { from: string; to: string } {
    const today = isoDay(this.clock.now());
    const to = query.to ?? today;
    const from =
      query.from ??
      isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_ANALYTICS_DAYS - 1) * DAY_MS));
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (Number.isNaN(span) || span < 0 || span >= MAX_ANALYTICS_DAYS) {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [
            {
              path: 'from',
              code: 'invalid_range',
              message: `window must be 1 to ${MAX_ANALYTICS_DAYS} days`,
            },
          ],
        },
      });
    }
    return { from, to };
  }
}

const base = (scope: MerchantScope) => ({
  merchantId: scope.merchantId,
  environment: scope.environment,
});

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function rate(successes: number, failures: number): number | null {
  const finished = successes + failures;
  return finished === 0 ? null : Math.round((successes / finished) * 10_000) / 10_000;
}

export function totalsByCurrency(series: readonly RollupSeriesRow[]): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const p of series) {
    const t = byCurrency.get(p.currency);
    const next = {
      currency: p.currency,
      paymentCount: (t?.paymentCount ?? 0) + p.paymentCount,
      paymentMinor: (t?.paymentMinor ?? 0n) + p.paymentMinor,
      refundCount: (t?.refundCount ?? 0) + p.refundCount,
      refundMinor: (t?.refundMinor ?? 0n) + p.refundMinor,
      payoutCount: (t?.payoutCount ?? 0) + p.payoutCount,
      payoutMinor: (t?.payoutMinor ?? 0n) + p.payoutMinor,
      feeMinor: (t?.feeMinor ?? 0n) + p.feeMinor,
      successCount: (t?.successCount ?? 0) + p.successCount,
      failureCount: (t?.failureCount ?? 0) + p.failureCount,
    };
    byCurrency.set(p.currency, {
      ...next,
      successRate: rate(next.successCount, next.failureCount),
    });
  }
  return [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1));
}
