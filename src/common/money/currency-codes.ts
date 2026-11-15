/**
 * Currencies the platform supports (spec section 3.8). Phase 2 adds the `core.currencies`
 * table with exponents, which becomes the runtime source; until then this list validates
 * currency codes on merchant records only. No amount handling lives here.
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
