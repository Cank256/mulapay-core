/**
 * The only place decimal strings and `bigint` minor units are converted (spec 3.8).
 *
 * The gateway speaks decimal strings (`"1000.0000"`, padded to `decimal(15,4)` on the way
 * back); the ledger speaks `bigint` minor units. The exponent per currency comes from the
 * ISO 4217 table in `common/money/currency-codes.ts`, which an integration test keeps in
 * step with the seeded `core.currencies`. `decimal.js` does the exact decimal parsing; no
 * `number` touches an amount, and a conversion that would lose precision throws.
 */
import Decimal from 'decimal.js';
import {
  CURRENCY_EXPONENTS,
  isSupportedCurrency,
  type CurrencyCode,
} from '../../common/money/currency-codes';
import { MAX_MINOR } from '../../common/money/minor-units';
/** The gateway stores `decimal(15,4)`: at most 11 integer digits and 4 decimals. */
const GATEWAY_AMOUNT = /^[0-9]{1,11}(\.[0-9]{1,4})?$/;
const GATEWAY_RESPONSE_AMOUNT = /^[0-9]{1,11}\.[0-9]{4}$|^[0-9]{1,11}$/;
export class MoneyConversionError extends Error {
  constructor(readonly reason: string) {
    super(`money conversion refused: ${reason}`);
    this.name = 'MoneyConversionError';
  }
}
function exponentOf(currency: string): number {
  if (!isSupportedCurrency(currency)) throw new MoneyConversionError('unsupported_currency');
  return CURRENCY_EXPONENTS[currency];
}
/**
 * A gateway amount to minor units. `"1000.0000"` UGX is `1000n`; `"10.5000"` KES is
 * `1050n`. Throws if the string is malformed, if it carries more decimals than the
 * currency's exponent allows (non-zero digits would be lost), or if the result is not
 * positive or does not fit a `bigint` column.
 */
export function toMinor(amount: string, currency: string): bigint {
  const exponent = exponentOf(currency);
  if (!GATEWAY_RESPONSE_AMOUNT.test(amount) && !GATEWAY_AMOUNT.test(amount)) {
    throw new MoneyConversionError('malformed_amount');
  }
  const scaled = new Decimal(amount).mul(new Decimal(10).pow(exponent));
  if (!scaled.isInteger()) throw new MoneyConversionError('precision_loss');
  const minor = BigInt(scaled.toFixed(0));
  if (minor <= 0n) throw new MoneyConversionError('not_positive');
  if (minor > MAX_MINOR) throw new MoneyConversionError('overflow');
  return minor;
}
/**
 * Minor units to the string core sends to the gateway: `1000n` UGX is `"1000"` (zero-decimal
 * currencies take whole numbers only), `1050n` KES is `"10.50"`. Exact: never rounds.
 */
export function toGatewayAmount(minor: bigint, currency: string): string {
  const exponent = exponentOf(currency);
  if (typeof minor !== 'bigint' || minor <= 0n) throw new MoneyConversionError('not_positive');
  const text = minor.toString();
  if (exponent === 0) {
    if (text.length > 11) throw new MoneyConversionError('overflow');
    return text;
  }
  const padded = text.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  if (whole.length > 11) throw new MoneyConversionError('overflow');
  return `${whole}.${padded.slice(padded.length - exponent)}`;
}
/** Numeric comparison of two gateway amounts of one currency (`"1000"` equals `"1000.0000"`). */
export function sameGatewayAmount(a: string, b: string): boolean {
  return new Decimal(a).equals(new Decimal(b));
}
export type { CurrencyCode };
