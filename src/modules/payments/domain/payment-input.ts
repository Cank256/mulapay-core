/**
 * Rules for the data a payment is created from (spec 6.1: core validates currency support,
 * amount precision and the phone number before the gateway is ever called). Pure.
 */
import type { MerchantScope } from '../../../common/auth/merchant-scope';
import { AppError } from '../../../common/errors/app-error';
import {
  CURRENCY_EXPONENTS,
  isSupportedCurrency,
  type CurrencyCode,
} from '../../../common/money/currency-codes';
import { isPositiveMinor } from '../../../common/money/minor-units';

/**
 * The gateway takes `decimal(15,4)` amounts (spec 3.3): at most 11 digits before the
 * decimal point. A payment above that could not be sent, so core refuses it at creation
 * instead of letting a bad request leave core.
 */
export const GATEWAY_MAX_INTEGER_DIGITS = 11;

/** Largest payment in minor units for `currency`: 10^(11 + exponent) - 1. */
export function maxPaymentMinor(currency: CurrencyCode): bigint {
  return 10n ** BigInt(GATEWAY_MAX_INTEGER_DIGITS + CURRENCY_EXPONENTS[currency]) - 1n;
}

function invalid(reason: string): AppError {
  return new AppError('PAYMENT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

/**
 * Checks an amount against its currency. Amounts are already integers in minor units, so
 * "precision" here means the amount is positive, fits the gateway, and the currency is one
 * the platform supports (which fixes the exponent).
 */
export function assertPaymentAmount(amountMinor: bigint, currency: string): CurrencyCode {
  if (!isSupportedCurrency(currency)) throw invalid('currency_not_supported');
  if (!isPositiveMinor(amountMinor)) throw invalid('amount_must_be_positive');
  if (amountMinor > maxPaymentMinor(currency)) throw invalid('amount_too_large');
  return currency;
}

/**
 * Normalises a phone number to E.164 with a leading `+` (spec 6.2), or returns null.
 * Accepts `+` or `00` followed by the country code, with spaces, dots, hyphens and
 * brackets as separators. A number in national format (`0700 000 000`) is refused: without
 * a trustworthy country there is no safe way to complete it. 8 to 15 digits, first digit
 * not zero.
 */
export function normalizeMsisdn(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  if (!/^[+0-9 .\-()]+$/.test(trimmed)) return null;
  let digits: string;
  if (trimmed.startsWith('+')) {
    if (trimmed.indexOf('+', 1) !== -1) return null;
    digits = trimmed.slice(1).replace(/[ .\-()]/g, '');
  } else if (trimmed.startsWith('00')) {
    digits = trimmed.slice(2).replace(/[ .\-()]/g, '');
  } else {
    return null;
  }
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Last four digits of a normalised number, kept in clear text so lists can show it. */
export function msisdnLast4(normalized: string): string {
  return normalized.slice(-4);
}

/** When a payment created at `now` expires (spec 6.1, `PAYMENT_EXPIRY_MINUTES`). */
export function paymentExpiry(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Live money movement needs an active merchant. Test mode is allowed while the merchant is
 * still being onboarded (draft, pending KYC) so integration can start before approval, but
 * never for a suspended or closed merchant (spec 6.10).
 */
export function assertMerchantMayTransact(scope: MerchantScope): void {
  const allowed =
    scope.environment === 'live'
      ? scope.merchantStatus === 'active'
      : scope.merchantStatus !== 'suspended' && scope.merchantStatus !== 'closed';
  if (!allowed) throw new AppError('MERCHANT_NOT_ACTIVE');
}
