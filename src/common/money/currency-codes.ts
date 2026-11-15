/**
 * Currencies the platform supports and their ISO 4217 minor-unit exponents (spec 3.8).
 *
 * Migration 0002 seeds `core.currencies` with the same rows, and the ledger tables
 * reference it, so the database refuses any other currency. An integration test checks
 * that this list and the seed agree.
 */
export const SUPPORTED_CURRENCIES = [
  'UGX',
  'RWF',
  'KRW',
  'JPY',
  'VND',
  'KES',
  'TZS',
  'NGN',
  'GHS',
  'ZAR',
  'ZMW',
  'MWK',
  'USD',
  'EUR',
  'GBP',
  'XOF',
  'XAF',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_CURRENCIES);

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return SUPPORTED.has(code);
}

/** Minor-unit exponent per currency: 1000 UGX is 1000n, 10.00 KES is 1000n. */
export const CURRENCY_EXPONENTS: Readonly<Record<CurrencyCode, number>> = {
  UGX: 0,
  RWF: 0,
  KRW: 0,
  JPY: 0,
  VND: 0,
  KES: 2,
  TZS: 2,
  NGN: 2,
  GHS: 2,
  ZAR: 2,
  ZMW: 2,
  MWK: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  XOF: 0,
  XAF: 0,
};
