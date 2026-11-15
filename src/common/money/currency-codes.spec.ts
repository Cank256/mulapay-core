import { describe, expect, it } from 'vitest';
import { isSupportedCurrency, SUPPORTED_CURRENCIES } from './currency-codes';

describe('supported currencies', () => {
  it('lists exactly the 17 currencies of spec 3.8', () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(
      [
        'EUR',
        'GBP',
        'GHS',
        'JPY',
        'KES',
        'KRW',
        'MWK',
        'NGN',
        'RWF',
        'TZS',
        'UGX',
        'USD',
        'VND',
        'XAF',
        'XOF',
        'ZAR',
        'ZMW',
      ].sort()
    );
  });

  it('accepts listed codes only, case-sensitively', () => {
    expect(isSupportedCurrency('UGX')).toBe(true);
    expect(isSupportedCurrency('ugx')).toBe(false);
    expect(isSupportedCurrency('CHF')).toBe(false);
  });
});
