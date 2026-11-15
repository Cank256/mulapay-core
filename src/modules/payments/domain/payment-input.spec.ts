import { describe, expect, it } from 'vitest';
import type { MerchantScope } from '../../../common/auth/merchant-scope';
import type { MerchantStatus } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { SUPPORTED_CURRENCIES } from '../../../common/money/currency-codes';
import {
  assertMerchantMayTransact,
  assertPaymentAmount,
  maxPaymentMinor,
  msisdnLast4,
  normalizeMsisdn,
  paymentExpiry,
} from './payment-input';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.details?.reason as string;
    throw error;
  }
  return undefined;
}

describe('maxPaymentMinor', () => {
  it('fits the gateway decimal(15,4): 11 integer digits of major units', () => {
    expect(maxPaymentMinor('UGX')).toBe(99_999_999_999n);
    expect(maxPaymentMinor('KES')).toBe(9_999_999_999_999n);
    expect(maxPaymentMinor('USD')).toBe(9_999_999_999_999n);
  });

  it('is below the bigint ceiling for every supported currency', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(maxPaymentMinor(currency) < 9_223_372_036_854_775_807n).toBe(true);
    }
  });
});

describe('assertPaymentAmount', () => {
  it('accepts a positive amount within the limit and returns the currency', () => {
    expect(assertPaymentAmount(1n, 'UGX')).toBe('UGX');
    expect(assertPaymentAmount(maxPaymentMinor('KES'), 'KES')).toBe('KES');
  });

  it('refuses an unsupported currency, a non-positive amount and an amount past the gateway limit', () => {
    expect(reasonOf(() => assertPaymentAmount(100n, 'XXX'))).toBe('currency_not_supported');
    expect(reasonOf(() => assertPaymentAmount(0n, 'UGX'))).toBe('amount_must_be_positive');
    expect(reasonOf(() => assertPaymentAmount(-5n, 'UGX'))).toBe('amount_must_be_positive');
    expect(reasonOf(() => assertPaymentAmount(maxPaymentMinor('UGX') + 1n, 'UGX'))).toBe(
      'amount_too_large'
    );
  });
});

describe('normalizeMsisdn', () => {
  it('normalises international numbers to E.164', () => {
    expect(normalizeMsisdn('+256700000000')).toBe('+256700000000');
    expect(normalizeMsisdn('+256 700 000 000')).toBe('+256700000000');
    expect(normalizeMsisdn('+256-700-000-000')).toBe('+256700000000');
    expect(normalizeMsisdn('+(256) 700.000.000')).toBe('+256700000000');
    expect(normalizeMsisdn('00256700000000')).toBe('+256700000000');
    expect(normalizeMsisdn('  +254712345678  ')).toBe('+254712345678');
  });

  it('refuses numbers it cannot make E.164', () => {
    for (const bad of [
      '',
      '   ',
      '0700000000', // national format
      '256700000000', // no plus
      '+0256700000000', // country code cannot start with 0
      '+2567', // too short
      '+2567000000000000', // too long
      '+256 7000 abc 00',
      '+256+700000000',
      '++256700000000',
      'x'.repeat(40),
      '+256700000000;drop',
    ]) {
      expect(normalizeMsisdn(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps the last four digits', () => {
    expect(msisdnLast4('+256700001234')).toBe('1234');
  });
});

describe('paymentExpiry', () => {
  it('adds the configured minutes', () => {
    expect(paymentExpiry(new Date('2025-01-01T00:00:00Z'), 15).toISOString()).toBe(
      '2025-01-01T00:15:00.000Z'
    );
  });
});

describe('assertMerchantMayTransact', () => {
  const scope = (merchantStatus: MerchantStatus, environment: 'test' | 'live'): MerchantScope => ({
    merchantId: 'id',
    merchantRef: 'mch_x',
    merchantStatus,
    environment,
  });
  const refused = (s: MerchantScope) => {
    try {
      assertMerchantMayTransact(s);
    } catch (error) {
      return error instanceof AppError ? error.code : 'other';
    }
    return null;
  };

  it('lets only an active merchant take live payments', () => {
    expect(refused(scope('active', 'live'))).toBeNull();
    for (const status of ['draft', 'pending_kyc', 'suspended', 'closed'] as const) {
      expect(refused(scope(status, 'live')), status).toBe('MERCHANT_NOT_ACTIVE');
    }
  });

  it('lets a merchant in onboarding use test mode, but not a suspended or closed one', () => {
    for (const status of ['draft', 'pending_kyc', 'active'] as const) {
      expect(refused(scope(status, 'test')), status).toBeNull();
    }
    for (const status of ['suspended', 'closed'] as const) {
      expect(refused(scope(status, 'test')), status).toBe('MERCHANT_NOT_ACTIVE');
    }
  });
});
