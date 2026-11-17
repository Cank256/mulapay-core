/**
 * Money conversion tests (spec 3.8): every supported currency in both directions, precision
 * loss detection, overflow detection, and boundary conditions.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_CURRENCIES } from '../../common/money/currency-codes';
import { MAX_MINOR } from '../../common/money/minor-units';
import { MoneyConversionError, sameGatewayAmount, toGatewayAmount, toMinor } from './money';

describe('toMinor: gateway decimal strings to bigint minor units', () => {
  describe('zero-decimal currencies (exponent 0)', () => {
    const zeroDec = ['UGX', 'RWF', 'KRW', 'JPY', 'VND', 'XOF', 'XAF'] as const;

    it.each(zeroDec)('%s: whole numbers convert exactly', (currency) => {
      expect(toMinor('1', currency)).toBe(1n);
      expect(toMinor('1000', currency)).toBe(1000n);
      expect(toMinor('1000.0000', currency)).toBe(1000n);
      expect(toMinor('999999999', currency)).toBe(999_999_999n);
    });

    it.each(zeroDec)('%s: refuses non-zero decimals (precision loss)', (currency) => {
      expect(() => toMinor('1000.01', currency)).toThrow(MoneyConversionError);
      expect(() => toMinor('1000.0001', currency)).toThrow(MoneyConversionError);
      expect(() => toMinor('10.5', currency)).toThrow('precision_loss');
    });
  });

  describe('two-decimal currencies (exponent 2)', () => {
    const twoDec = ['KES', 'TZS', 'NGN', 'GHS', 'ZAR', 'ZMW', 'MWK', 'USD', 'EUR', 'GBP'] as const;

    it.each(twoDec)('%s: converts to minor units by multiplying by 100', (currency) => {
      expect(toMinor('1', currency)).toBe(100n);
      expect(toMinor('1.00', currency)).toBe(100n);
      expect(toMinor('10.50', currency)).toBe(1050n);
      expect(toMinor('10.5', currency)).toBe(1050n);
      expect(toMinor('1000.0000', currency)).toBe(100_000n);
      expect(toMinor('0.01', currency)).toBe(1n);
    });

    it.each(twoDec)('%s: refuses more than two decimal places (precision loss)', (currency) => {
      expect(() => toMinor('10.505', currency)).toThrow(MoneyConversionError);
      expect(() => toMinor('10.5001', currency)).toThrow('precision_loss');
      expect(() => toMinor('1.001', currency)).toThrow('precision_loss');
    });
  });

  it('all supported currencies round-trip through toGatewayAmount', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const examples = [1n, 100n, 1000n, 50_000n, 999_999_999n];
      for (const minor of examples) {
        const gateway = toGatewayAmount(minor, currency);
        expect(toMinor(gateway, currency)).toBe(minor);
      }
    }
  });

  it('refuses malformed amount strings', () => {
    expect(() => toMinor('', 'UGX')).toThrow('malformed_amount');
    expect(() => toMinor('abc', 'UGX')).toThrow('malformed_amount');
    expect(() => toMinor('10.', 'UGX')).toThrow('malformed_amount');
    expect(() => toMinor('.50', 'KES')).toThrow('malformed_amount');
    expect(() => toMinor('1,000', 'UGX')).toThrow('malformed_amount');
    expect(() => toMinor('1 000', 'UGX')).toThrow('malformed_amount');
  });

  it('refuses zero and negative amounts', () => {
    expect(() => toMinor('0', 'UGX')).toThrow('not_positive');
    expect(() => toMinor('0.00', 'KES')).toThrow('not_positive');
    // Negative amounts fail the regex first (malformed_amount)
    expect(() => toMinor('-1', 'UGX')).toThrow(MoneyConversionError);
    expect(() => toMinor('-10.50', 'KES')).toThrow(MoneyConversionError);
  });

  it('refuses amounts above MAX_MINOR', () => {
    const huge = (MAX_MINOR + 1n).toString();
    // MAX_MINOR is 2^63-1 (19 digits), way above the 11-digit gateway limit
    // So it fails on malformed_amount (too many digits) before overflow check
    expect(() => toMinor(huge, 'UGX')).toThrow(MoneyConversionError);
  });

  it('refuses unsupported currencies', () => {
    expect(() => toMinor('1000', 'XXX')).toThrow('unsupported_currency');
    expect(() => toMinor('1000', 'BTC')).toThrow('unsupported_currency');
    expect(() => toMinor('1000', '')).toThrow('unsupported_currency');
  });

  it('accepts gateway response format with exactly 4 decimals', () => {
    expect(toMinor('1000.0000', 'UGX')).toBe(1000n);
    expect(toMinor('10.5000', 'KES')).toBe(1050n);
  });

  it('accepts request format without trailing zeros', () => {
    expect(toMinor('1000', 'UGX')).toBe(1000n);
    expect(toMinor('10.5', 'KES')).toBe(1050n);
  });
});

describe('toGatewayAmount: bigint minor units to gateway decimal strings', () => {
  describe('zero-decimal currencies (exponent 0)', () => {
    const zeroDec = ['UGX', 'RWF', 'KRW', 'JPY', 'VND', 'XOF', 'XAF'] as const;

    it.each(zeroDec)('%s: returns whole numbers without decimals', (currency) => {
      expect(toGatewayAmount(1n, currency)).toBe('1');
      expect(toGatewayAmount(1000n, currency)).toBe('1000');
      expect(toGatewayAmount(999_999_999n, currency)).toBe('999999999');
    });

    it.each(zeroDec)('%s: refuses amounts above 11 digits', (currency) => {
      const huge = 100_000_000_000n; // 12 digits
      expect(() => toGatewayAmount(huge, currency)).toThrow('overflow');
    });
  });

  describe('two-decimal currencies (exponent 2)', () => {
    const twoDec = ['KES', 'TZS', 'NGN', 'GHS', 'ZAR', 'ZMW', 'MWK', 'USD', 'EUR', 'GBP'] as const;

    it.each(twoDec)('%s: divides by 100 and formats with two decimals', (currency) => {
      expect(toGatewayAmount(1n, currency)).toBe('0.01');
      expect(toGatewayAmount(100n, currency)).toBe('1.00');
      expect(toGatewayAmount(1050n, currency)).toBe('10.50');
      expect(toGatewayAmount(100_000n, currency)).toBe('1000.00');
      expect(toGatewayAmount(50n, currency)).toBe('0.50');
      expect(toGatewayAmount(5n, currency)).toBe('0.05');
    });

    it.each(twoDec)('%s: refuses amounts that produce more than 11 integer digits', (currency) => {
      const huge = 1_000_000_000_000n; // 10^12, would be 10^10 after /100 = 10 billion (10 digits OK)
      expect(toGatewayAmount(huge, currency)).toBe('10000000000.00'); // OK
      const tooHuge = 10_000_000_000_000n; // 10^13, would be 10^11 = 12 digits
      expect(() => toGatewayAmount(tooHuge, currency)).toThrow('overflow');
    });
  });

  it('refuses zero and negative amounts', () => {
    expect(() => toGatewayAmount(0n, 'UGX')).toThrow('not_positive');
    expect(() => toGatewayAmount(-1n, 'UGX')).toThrow('not_positive');
    expect(() => toGatewayAmount(-100n, 'KES')).toThrow('not_positive');
  });

  it('refuses non-bigint inputs', () => {
    expect(() => toGatewayAmount(1000 as unknown as bigint, 'UGX')).toThrow('not_positive');
    expect(() => toGatewayAmount('1000' as unknown as bigint, 'UGX')).toThrow('not_positive');
  });

  it('refuses unsupported currencies', () => {
    expect(() => toGatewayAmount(1000n, 'XXX')).toThrow('unsupported_currency');
    expect(() => toGatewayAmount(1000n, 'BTC')).toThrow('unsupported_currency');
  });

  it('produces strings the gateway accepts per the amount regex', () => {
    // Gateway expects `^[0-9]{1,11}(\.[0-9]{1,4})?$`
    const gatewayPattern = /^[0-9]{1,11}(\.[0-9]{1,4})?$/;
    expect(toGatewayAmount(1000n, 'UGX')).toMatch(gatewayPattern);
    expect(toGatewayAmount(1050n, 'KES')).toMatch(gatewayPattern);
    expect(toGatewayAmount(1n, 'KES')).toMatch(gatewayPattern);
  });
});

describe('sameGatewayAmount: numeric comparison', () => {
  it('treats trailing zeros as equal', () => {
    expect(sameGatewayAmount('1000', '1000.0000')).toBe(true);
    expect(sameGatewayAmount('10.50', '10.5')).toBe(true);
    expect(sameGatewayAmount('10.5000', '10.5')).toBe(true);
    expect(sameGatewayAmount('0.01', '0.0100')).toBe(true);
  });

  it('compares numerically, not lexicographically', () => {
    expect(sameGatewayAmount('10', '10.00')).toBe(true);
    expect(sameGatewayAmount('10', '010')).toBe(true);
    expect(sameGatewayAmount('10', '10.0')).toBe(true);
  });

  it('distinguishes different amounts', () => {
    expect(sameGatewayAmount('1000', '1001')).toBe(false);
    expect(sameGatewayAmount('10.50', '10.51')).toBe(false);
    expect(sameGatewayAmount('1', '1.01')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(sameGatewayAmount('0', '0.00')).toBe(true);
    expect(sameGatewayAmount('0.0000', '0')).toBe(true);
    expect(sameGatewayAmount('1.0001', '1.00010')).toBe(true);
  });
});

describe('boundary and overflow conditions', () => {
  it('gateway 11-digit limit is enforced for zero-decimal currencies', () => {
    // 11 digits is the max for gateway format
    const elevenDigits = '99999999999'; // exactly 11 digits
    expect(toMinor(elevenDigits, 'UGX')).toBe(99_999_999_999n);
    expect(toGatewayAmount(99_999_999_999n, 'UGX')).toBe('99999999999');

    // 12 digits fails validation before reaching overflow check
    const twelveDigits = '100000000000';
    expect(() => toMinor(twelveDigits, 'UGX')).toThrow('malformed_amount');
  });

  it('toGatewayAmount refuses amounts that exceed 11 integer digits', () => {
    // 12 digits
    const twelveDigits = 100_000_000_000n;
    expect(() => toGatewayAmount(twelveDigits, 'UGX')).toThrow('overflow');

    // For 2-decimal currencies, the limit in minor units is higher
    // 11 digits major = 99,999,999,999 (under 100 billion)
    // times 100 = 9,999,999,999,900 minor units
    const maxTwoDecimal = 9_999_999_999_900n;
    expect(toGatewayAmount(maxTwoDecimal, 'USD')).toBe('99999999999.00');

    // One cent more is too much (would be 12 digits)
    expect(() => toGatewayAmount(10_000_000_000_000n, 'USD')).toThrow('overflow');
  });

  it('amounts within MAX_MINOR but above gateway limit fail gracefully', () => {
    // MAX_MINOR is way larger than gateway can handle (19 digits vs 11)
    // These should fail on malformed_amount, not overflow
    const wayTooBig = '99999999999999999'; // 17 digits
    expect(() => toMinor(wayTooBig, 'UGX')).toThrow('malformed_amount');
  });

  it('smallest positive amount (1 minor unit) round-trips', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const gateway = toGatewayAmount(1n, currency);
      expect(toMinor(gateway, currency)).toBe(1n);
    }
  });
});
