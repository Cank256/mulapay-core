/**
 * The ledger lines of a paid settlement (spec 5.5 "Merchant settlement released"). Pure.
 *
 * Spec 5.5 gives, for net `N` and reserve `V`:
 *
 *   DR 2000:merchant_payable      N + V
 *   CR 2010:merchant_reserve      V
 *   CR 1200:settlement_in_transit N
 *
 * and then, on confirmation, `DR 1200 / CR 1100:bank`. This implementation extends the first
 * entry to release earlier reserve `R` into the same payout, and nets the reserve account so
 * it carries one line:
 *
 *   DR 2000:merchant_payable      P + V      (P = drawn from payable, N = P + R)
 *   DR/CR 2010:merchant_reserve   |R - V|    (debit when R > V, credit when V > R)
 *   CR 1200:settlement_in_transit N
 *
 * The confirmation entry credits the provider float account, not `1100:bank`: the payout
 * leaves through the gateway, so the cash that leaves is the provider float, and the daily
 * balance proof (spec 6.8 run 4) compares that account with the gateway's own balance.
 * docs/ARCHITECTURE.md lists this as a decision to confirm.
 */
import {
  merchantAccountCode,
  platformAccountCode,
  providerAccountCode,
  type LedgerProvider,
} from '../../accounts/domain/chart-of-accounts';
import type { PostingLineInput } from '../../ledger/domain/posting';

export interface SettlementPostingInput {
  readonly merchantRef: string;
  readonly provider: LedgerProvider;
  /** Drawn from the merchant payable account. */
  readonly payableDrawMinor: bigint;
  /** Withheld into the reserve account by this batch. */
  readonly reserveWithheldMinor: bigint;
  /** Earlier reserve released into this payout. */
  readonly reserveReleasedMinor: bigint;
}

export interface SettlementPostings {
  /** Spec 5.5 "released": payable and reserve into settlement in transit. */
  readonly released: readonly PostingLineInput[];
  /** Spec 5.5 "on confirmation": settlement in transit out to the provider float. */
  readonly confirmed: readonly PostingLineInput[];
  readonly netMinor: bigint;
}

export function settlementPostings(input: SettlementPostingInput): SettlementPostings {
  const { payableDrawMinor: p, reserveWithheldMinor: v, reserveReleasedMinor: r } = input;
  if (p < 0n || v < 0n || r < 0n) throw new RangeError('settlement amounts must not be negative');
  const net = p + r;
  if (net <= 0n) throw new RangeError('a settlement posting needs a positive net amount');

  const payable = merchantAccountCode('merchant_payable', input.merchantRef);
  const reserve = merchantAccountCode('merchant_reserve', input.merchantRef);
  const inTransit = platformAccountCode('settlement_in_transit');
  const float = providerAccountCode('provider_float', input.provider);

  const released: PostingLineInput[] = [];
  if (p + v > 0n) {
    released.push({ accountCode: payable, direction: 'debit', amountMinor: p + v });
  }
  if (r > v) released.push({ accountCode: reserve, direction: 'debit', amountMinor: r - v });
  if (v > r) released.push({ accountCode: reserve, direction: 'credit', amountMinor: v - r });
  released.push({ accountCode: inTransit, direction: 'credit', amountMinor: net });

  return {
    released,
    confirmed: [
      { accountCode: inTransit, direction: 'debit', amountMinor: net },
      { accountCode: float, direction: 'credit', amountMinor: net },
    ],
    netMinor: net,
  };
}
