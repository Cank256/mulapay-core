/**
 * The ledger posting for a successful refund: reverses the original collection entry.
 *
 * Original collection posting:
 * ```
 * DR 1000:provider_clearing:{provider}   G
 * CR 2000:merchant_payable:{merchant}    G
 * DR 2000:merchant_payable:{merchant}    F
 * CR 4000:fee_revenue                    F
 * DR 5000:provider_fee_expense           P
 * CR 1000:provider_clearing:{provider}   P
 * ```
 *
 * Refund reversal (gross `G`, MulaPay fee `F`, provider fee `P`):
 * ```
 * CR 1000:provider_clearing:{provider}   G    (reverse original debit)
 * DR 2000:merchant_payable:{merchant}    G    (reverse original credit)
 * CR 2000:merchant_payable:{merchant}    F    (reverse fee debit)
 * DR 4000:fee_revenue                    F    (reverse fee credit)
 * CR 5000:provider_fee_expense           P    (reverse provider fee debit)
 * DR 1000:provider_clearing:{provider}   P    (reverse provider fee credit)
 * ```
 *
 * Each line is the opposite direction of the original. A failed or cancelled refund posts
 * nothing (no money moved). Partial refunds use the partial amount with proportional fees.
 */
import { AppError } from '../../../common/errors/app-error';
import {
  merchantAccountCode,
  platformAccountCode,
  providerAccountCode,
} from '../../accounts/domain/chart-of-accounts';
import type { PostingLineInput } from '../../ledger/domain/posting';
import type { PaymentProvider } from '../../payments/domain/payment-event';

export interface RefundPostingInput {
  readonly provider: PaymentProvider;
  readonly merchantRef: string;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly providerFeeMinor: bigint;
}

function invalid(reason: string): AppError {
  return new AppError('REFUND_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

/** Lines of the refund-succeeded entry (reversal). Throws if the fees do not fit inside the gross. */
export function refundPostingLines(input: RefundPostingInput): PostingLineInput[] {
  const { provider, merchantRef, grossMinor, feeMinor, providerFeeMinor } = input;
  if (grossMinor <= 0n) throw invalid('amount_must_be_positive');
  if (feeMinor < 0n || providerFeeMinor < 0n) throw invalid('fee');
  if (feeMinor > grossMinor) throw invalid('fee_exceeds_amount');
  if (providerFeeMinor > grossMinor) throw invalid('provider_fee_exceeds_amount');

  const clearing = providerAccountCode('provider_clearing', provider);
  const payable = merchantAccountCode('merchant_payable', merchantRef);

  // Reverse the collection entry: swap debits and credits
  const lines: PostingLineInput[] = [
    { accountCode: clearing, direction: 'credit', amountMinor: grossMinor },
    { accountCode: payable, direction: 'debit', amountMinor: grossMinor },
  ];

  if (feeMinor > 0n) {
    lines.push(
      { accountCode: payable, direction: 'credit', amountMinor: feeMinor },
      {
        accountCode: platformAccountCode('fee_revenue'),
        direction: 'debit',
        amountMinor: feeMinor,
      }
    );
  }

  if (providerFeeMinor > 0n) {
    lines.push(
      {
        accountCode: platformAccountCode('provider_fee_expense'),
        direction: 'credit',
        amountMinor: providerFeeMinor,
      },
      { accountCode: clearing, direction: 'debit', amountMinor: providerFeeMinor }
    );
  }

  return lines;
}
