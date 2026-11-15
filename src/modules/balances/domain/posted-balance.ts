/**
 * Balance projection (spec 6.7): `posted = f(normal_balance, posted_debits, posted_credits)`.
 * Pure. A positive result means the account sits on its normal side; a negative result on
 * a merchant liability account means the platform is owed money by the merchant.
 */
import type { NormalBalance } from '../../accounts/domain/chart-of-accounts';

export function postedBalance(normal: NormalBalance, debits: bigint, credits: bigint): bigint {
  return normal === 'debit' ? debits - credits : credits - debits;
}

export interface BalanceTotals {
  readonly debits: bigint;
  readonly credits: bigint;
}

/** Totals after adding `delta`. Totals only grow: a reversal adds to the other side. */
export function applyDelta(current: BalanceTotals, delta: BalanceTotals): BalanceTotals {
  return { debits: current.debits + delta.debits, credits: current.credits + delta.credits };
}
export interface MerchantBalanceParts {
  readonly postedMinor: bigint;
  readonly heldMinor: bigint;
  readonly reservedMinor: bigint;
}
/**
 * Spec 6.7: `available = posted - held - reserved`. This is what payouts, refunds and
 * settlement draw on. It can be negative only if postings outran holds (an adjustment
 * with `allowNegativeMerchantBalance`); nothing may then be placed against it.
 */
export function availableBalance(parts: MerchantBalanceParts): bigint {
  return parts.postedMinor - parts.heldMinor - parts.reservedMinor;
}
