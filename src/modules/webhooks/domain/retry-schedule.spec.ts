import { describe, expect, it } from 'vitest';
import {
  AUTO_DISABLE_AFTER_FAILURES,
  DELIVERY_TIMEOUT_MS,
  JITTER_RATIO,
  MAX_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  nextAttemptDelayMs,
} from './retry-schedule';

describe('retry schedule (spec 6.11)', () => {
  it('is 0s, 30s, 2m, 10m, 1h, 6h, 24h: seven attempts', () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([0, 30, 120, 600, 3600, 21_600, 86_400]);
    expect(MAX_ATTEMPTS).toBe(7);
    expect(AUTO_DISABLE_AFTER_FAILURES).toBe(50);
    expect(DELIVERY_TIMEOUT_MS).toBe(10_000);
  });
  it('waits the scheduled delay after each failed attempt, without jitter at the midpoint', () => {
    const middle = () => 0.5;
    expect([1, 2, 3, 4, 5, 6].map((n) => nextAttemptDelayMs(n, middle))).toEqual(
      [30, 120, 600, 3600, 21_600, 86_400].map((s) => s * 1000)
    );
  });
  it('is exhausted after the seventh attempt, and undefined before the first', () => {
    expect(nextAttemptDelayMs(7)).toBeNull();
    expect(nextAttemptDelayMs(8)).toBeNull();
    expect(nextAttemptDelayMs(0)).toBeNull();
  });
  it('jitters by at most 20% either way', () => {
    const low = nextAttemptDelayMs(2, () => 0) as number;
    const high = nextAttemptDelayMs(2, () => 0.999999) as number;
    expect(low).toBe(Math.round(120_000 * (1 - JITTER_RATIO)));
    expect(high).toBeLessThanOrEqual(Math.round(120_000 * (1 + JITTER_RATIO)));
    expect(high).toBeGreaterThan(120_000);
  });
  it('spreads real delays inside the band', () => {
    for (let i = 0; i < 200; i++) {
      const delay = nextAttemptDelayMs(3) as number;
      expect(delay).toBeGreaterThanOrEqual(600_000 * 0.8);
      expect(delay).toBeLessThanOrEqual(600_000 * 1.2);
    }
  });
});
