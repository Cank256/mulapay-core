import { describe, expect, it } from 'vitest';
import { publicId } from '../../../common/ids/ids';
import {
  ACCOUNT_PURPOSES,
  bankAccountCode,
  isAccountCode,
  isMerchantPurpose,
  merchantAccountCode,
  normalBalanceOf,
  parseAccountCode,
  platformAccountCode,
  providerAccountCode,
  seededAccounts,
} from './chart-of-accounts';

const merchantRef = publicId('merchant');

describe('chart of accounts (spec 5.4)', () => {
  it('matches the spec table: number, type and normal balance per purpose', () => {
    const table = Object.fromEntries(
      Object.entries(ACCOUNT_PURPOSES).map(([purpose, d]) => [
        purpose,
        `${d.number} ${d.type} ${normalBalanceOf(d.type)}`,
      ])
    );
    expect(table).toEqual({
      provider_clearing: '1000 asset debit',
      provider_float: '1010 asset debit',
      bank: '1100 asset debit',
      settlement_in_transit: '1200 asset debit',
      fx_clearing: '1900 asset debit',
      merchant_payable: '2000 liability credit',
      merchant_reserve: '2010 liability credit',
      refund_payable: '2100 liability credit',
      tax_payable: '2200 liability credit',
      fee_revenue: '4000 revenue credit',
      fx_revenue: '4100 revenue credit',
      provider_fee_expense: '5000 expense debit',
      loss_writeoff: '5100 expense debit',
      suspense: '9000 asset debit',
    });
  });

  it('gives equity accounts a credit normal balance', () => {
    expect(normalBalanceOf('equity')).toBe('credit');
  });

  it('builds codes for every scope', () => {
    expect(platformAccountCode('fee_revenue')).toBe('4000:fee_revenue');
    expect(platformAccountCode('suspense')).toBe('9000:suspense');
    expect(providerAccountCode('provider_clearing', 'mtn')).toBe('1000:provider_clearing:mtn');
    expect(merchantAccountCode('merchant_payable', merchantRef)).toBe(
      `2000:merchant_payable:${merchantRef}`
    );
    expect(bankAccountCode('stanbic_ugx')).toBe('1100:bank:stanbic_ugx');
  });

  it('refuses to build a merchant code from anything but a merchant ref', () => {
    expect(() => merchantAccountCode('merchant_reserve', 'not-a-ref')).toThrow();
    expect(() =>
      merchantAccountCode('merchant_payable', '018f0000-0000-7000-8000-000000000000')
    ).toThrow();
  });

  it('refuses malformed bank keys', () => {
    expect(() => bankAccountCode('A')).toThrow();
    expect(() => bankAccountCode('Has-Dash')).toThrow();
  });

  it('parses valid codes and rejects every malformed shape', () => {
    expect(parseAccountCode('4000:fee_revenue')).toEqual({
      purpose: 'fee_revenue',
      qualifier: null,
    });
    expect(parseAccountCode('1010:provider_float:airtel')).toEqual({
      purpose: 'provider_float',
      qualifier: 'airtel',
    });
    expect(parseAccountCode(`2010:merchant_reserve:${merchantRef}`)).toEqual({
      purpose: 'merchant_reserve',
      qualifier: merchantRef,
    });
    for (const bad of [
      '',
      'fee_revenue',
      '4000:unknown_purpose',
      '4001:fee_revenue',
      '4000:fee_revenue:extra',
      '1000:provider_clearing',
      '1000:provider_clearing:mpesa',
      '2000:merchant_payable:mch_short',
      '1100:bank:x',
      '4000:constructor',
      '4000:fee_revenue:a:b',
    ]) {
      expect(isAccountCode(bad), bad).toBe(false);
    }
  });

  it('marks merchant liability purposes', () => {
    expect(isMerchantPurpose('merchant_payable')).toBe(true);
    expect(isMerchantPurpose('merchant_reserve')).toBe(true);
    expect(isMerchantPurpose('refund_payable')).toBe(false);
  });

  it('seeds every platform account once and the provider accounts per provider', () => {
    const codes = seededAccounts().map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(15);
    expect(codes).toContain('9000:suspense');
    expect(codes).toContain('1000:provider_clearing:flutterwave');
    expect(codes.some((c) => c.startsWith('1100:') || c.startsWith('2000:'))).toBe(false);
    for (const account of seededAccounts()) {
      expect(isAccountCode(account.code), account.code).toBe(true);
    }
  });
});
