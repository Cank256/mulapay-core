import { describe, expect, it } from 'vitest';
import { balanceToMinor, parseOperation, retryDelayMs } from './gateway-operations.client';

const op = {
  providerId: 'airtel',
  operationType: 'disbursement',
  referenceId: 'ref-1',
  externalId: 'po_1',
  status: 'successful',
  amount: '1000.0000',
  currency: 'UGX',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:01:00.000Z',
};

describe('gateway operation parsing', () => {
  it('maps a well-formed operation', () => {
    expect(parseOperation(op)).toMatchObject({
      externalId: 'po_1',
      status: 'successful',
      amount: '1000.0000',
      referenceId: 'ref-1',
    });
    expect(parseOperation({ ...op, referenceId: null })?.referenceId).toBeNull();
  });

  it('refuses anything that is not an operation core understands', () => {
    for (const bad of [
      null,
      'x',
      [],
      { ...op, status: 'weird' },
      { ...op, operationType: 'transfer' },
      { ...op, externalId: '' },
      { ...op, amount: undefined },
      { ...op, createdAt: 'not a date' },
    ]) {
      expect(parseOperation(bad)).toBeUndefined();
    }
  });
});

describe('gateway balances', () => {
  it('converts to minor units exactly, and zero is a balance', () => {
    expect(balanceToMinor('1000.0000', 'UGX')).toBe(1000n);
    expect(balanceToMinor('10.5000', 'KES')).toBe(1050n);
    expect(balanceToMinor('0.0000', 'UGX')).toBe(0n);
    expect(balanceToMinor('0', 'KES')).toBe(0n);
  });
  it('refuses a balance that cannot be represented', () => {
    expect(() => balanceToMinor('10.123', 'UGX')).toThrow();
    expect(() => balanceToMinor('abc', 'UGX')).toThrow();
    expect(() => balanceToMinor('5', 'XXX')).toThrow();
  });
});

describe('retryDelayMs: exponential backoff with jitter', () => {
  it('starts at ~1000ms and doubles per attempt', () => {
    // Base is 1000ms, jitter is up to 500ms, so range is [1000, 1500)
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(0);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThan(1500);
    }

    // Attempt 1: 2000ms base + jitter [2000, 2500)
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(1);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThan(2500);
    }

    // Attempt 2: 4000ms base + jitter [4000, 4500)
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(2);
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThan(4500);
    }

    // Attempt 3: 8000ms base + jitter [8000, 8500)
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(3);
      expect(delay).toBeGreaterThanOrEqual(8000);
      expect(delay).toBeLessThan(8500);
    }
  });

  it('caps at 16000ms base', () => {
    // Attempt 4: would be 16000ms base (2^4 * 1000)
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(4);
      expect(delay).toBeGreaterThanOrEqual(16_000);
      expect(delay).toBeLessThan(16_500);
    }

    // Attempt 5 and beyond: still capped at 16000ms
    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(5);
      expect(delay).toBeGreaterThanOrEqual(16_000);
      expect(delay).toBeLessThan(16_500);
    }

    for (let i = 0; i < 10; i += 1) {
      const delay = retryDelayMs(10);
      expect(delay).toBeGreaterThanOrEqual(16_000);
      expect(delay).toBeLessThan(16_500);
    }
  });

  it('jitter is random and varies between calls', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      delays.add(retryDelayMs(0));
    }
    // With 50 samples and up to 500ms jitter, we should see multiple different values
    expect(delays.size).toBeGreaterThan(10);
  });

  it('returns a number for any non-negative attempt', () => {
    expect(typeof retryDelayMs(0)).toBe('number');
    expect(typeof retryDelayMs(100)).toBe('number');
    expect(retryDelayMs(0)).toBeGreaterThan(0);
  });

  it('follows the formula: min(1000 * 2^attempt, 16000) + jitter(0..500)', () => {
    // Test the deterministic part (ignoring jitter which is random)
    const testCases = [
      { attempt: 0, minBase: 1000, maxBase: 1000 },
      { attempt: 1, minBase: 2000, maxBase: 2000 },
      { attempt: 2, minBase: 4000, maxBase: 4000 },
      { attempt: 3, minBase: 8000, maxBase: 8000 },
      { attempt: 4, minBase: 16_000, maxBase: 16_000 }, // hits cap
      { attempt: 10, minBase: 16_000, maxBase: 16_000 }, // stays at cap
    ];

    for (const { attempt, minBase, maxBase } of testCases) {
      for (let i = 0; i < 5; i += 1) {
        const delay = retryDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(minBase);
        expect(delay).toBeLessThan(maxBase + 500); // base + max jitter
      }
    }
  });
});
