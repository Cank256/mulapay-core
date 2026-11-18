/**
 * Payout ledger posting lines (disbursement).
 *
 * When a payout succeeds:
 *   DR merchant_payable (funds leave merchant)
 *   CR provider_payable (funds owed to provider)
 *   DR merchant_fees (if any payout fee charged)
 */
import type { PostingLineInput } from '../../ledger/domain/posting';
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
export function payoutPostingLines(input: PayoutPostingInput): PostingLineInput[] {
  const lines: PostingLineInput[] = [];

  // DR merchant_payable (reduce merchant's balance)
  lines.push({
    accountCode: `merchant_payable:${input.merchantRef}`,
    direction: 'debit',
    amountMinor: input.grossMinor,
  });

  // CR provider_payable (funds owed to provider)
  lines.push({
    accountCode: `provider_payable:${input.provider}`,
    direction: 'credit',
    amountMinor: input.grossMinor - input.feeMinor,
  });

  // If there's a merchant fee: DR merchant_fees
  if (input.feeMinor > 0n) {
    lines.push({
      accountCode: `merchant_fees:${input.merchantRef}`,
      direction: 'debit',
      amountMinor: input.feeMinor,
    });
  }

  return lines;
}
