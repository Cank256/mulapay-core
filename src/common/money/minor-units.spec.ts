import { describe, expect, it } from 'vitest';
import { CURRENCY_EXPONENTS, SUPPORTED_CURRENCIES } from './currency-codes';
import { isPositiveMinor, MAX_MINOR, sumMinor } from './minor-units';

describe('minor units', () => {
  it('accepts positive bigints up to the Postgres bigint maximum', () => {
    expect(MAX_MINOR).toBe(2n ** 63n - 1n);
    expect(isPositiveMinor(1n)).toBe(true);
    expect(isPositiveMinor(MAX_MINOR)).toBe(true);
  });

  it('rejects zero, negatives, overflow and anything that is not a bigint', () => {
    for (const value of [0n, -1n, MAX_MINOR + 1n, 1, 1.5, '1', null, undefined]) {
      expect(isPositiveMinor(value)).toBe(false);
    }
  });

  it('sums without precision loss beyond Number.MAX_SAFE_INTEGER', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER);
    expect(sumMinor([big, big, 1n])).toBe(big * 2n + 1n);
    expect(sumMinor([])).toBe(0n);
  });
});

describe('currency exponents', () => {
  it('has an exponent for every supported currency (spec 3.8)', () => {
    expect(Object.keys(CURRENCY_EXPONENTS).sort()).toEqual([...SUPPORTED_CURRENCIES].sort());
    const zeroDecimal = SUPPORTED_CURRENCIES.filter((c) => CURRENCY_EXPONENTS[c] === 0).sort();
    expect(zeroDecimal).toEqual(['JPY', 'KRW', 'RWF', 'UGX', 'VND', 'XAF', 'XOF']);
  });
});
