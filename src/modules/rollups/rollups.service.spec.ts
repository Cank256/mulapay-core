import { describe, expect, it } from 'vitest';
import type { RollupSeriesRow } from './rollups.repository';
import { isoDay, rate, totalsByCurrency } from './rollups.service';

const point = (over: Partial<RollupSeriesRow>): RollupSeriesRow => ({
  day: '2025-03-01',
  currency: 'UGX',
  paymentCount: 0,
  paymentMinor: 0n,
  refundCount: 0,
  refundMinor: 0n,
  payoutCount: 0,
  payoutMinor: 0n,
  feeMinor: 0n,
  successCount: 0,
  failureCount: 0,
  ...over,
});

describe('analytics arithmetic', () => {
  it('rates successes over finished payments to four places, null when none finished', () => {
    expect(rate(2, 1)).toBe(0.6667);
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBe(1);
    expect(rate(0, 3)).toBe(0);
  });

  it('adds days per currency in bigint, never as floats', () => {
    const big = 9_007_199_254_740_993n;
    const totals = totalsByCurrency([
      point({ paymentCount: 1, paymentMinor: big, successCount: 1 }),
      point({
        day: '2025-03-02',
        paymentCount: 1,
        paymentMinor: 2n,
        successCount: 1,
        failureCount: 1,
      }),
      point({ currency: 'KES', paymentMinor: 7n }),
    ]);
    expect(totals.map((t) => t.currency)).toEqual(['KES', 'UGX']);
    expect(totals[1]).toMatchObject({
      paymentCount: 2,
      paymentMinor: big + 2n,
      successCount: 2,
      failureCount: 1,
      successRate: 0.6667,
    });
    expect(totals[0]?.successRate).toBeNull();
  });

  it('names days in UTC', () => {
    expect(isoDay(new Date('2025-03-01T23:59:59Z'))).toBe('2025-03-01');
    expect(isoDay(new Date('2025-03-02T00:00:00Z'))).toBe('2025-03-02');
  });
});
