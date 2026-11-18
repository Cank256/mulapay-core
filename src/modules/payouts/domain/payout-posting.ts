/**
 * Payout ledger posting lines (disbursement).
 *
 * When a payout succeeds:
 *   DR merchant_payable (funds leave merchant)
 *   CR provider_payable (funds owed to provider)
 *   DR merchant_fees (if any payout fee charged)
 */
import type { PostingLine } from '../../ledger/domain/posting';
import type { PaymentProvider } from '../../payments/domain/payment-event';

export interface PayoutPostingInput {
  readonly provider: PaymentProvider;
  readonly merchantRef: string;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly providerFeeMinor: bigint;
}

/**
 * Generate posting lines for a successful payout.
 */
export function payoutPostingLines(input: PayoutPostingInput): PostingLine[] {
  const lines: PostingLine[] = [];

  // DR merchant_payable (reduce merchant's balance)
  lines.push({
    account: { type: 'merchant_payable', ref: input.merchantRef },
    debitMinor: input.grossMinor,
    creditMinor: 0n,
  });

  // CR provider_payable (funds owed to provider)
  lines.push({
    account: { type: 'provider_payable', ref: input.provider },
    debitMinor: 0n,
    creditMinor: input.grossMinor - input.feeMinor,
  });

  // If there's a merchant fee: DR merchant_fees
  if (input.feeMinor > 0n) {
    lines.push({
      account: { type: 'merchant_fees', ref: input.merchantRef },
      debitMinor: input.feeMinor,
      creditMinor: 0n,
    });
  }

  return lines;
}
