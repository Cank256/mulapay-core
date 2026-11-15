/**
 * The ledger posting for a successful collection (spec 5.5), built from amounts. Pure.
 *
 * Gross `G`, MulaPay fee `F`, provider fee `P`:
 *
 * ```
 * DR 1000:provider_clearing:{provider}   G
 * CR 2000:merchant_payable:{merchant}    G
 * DR 2000:merchant_payable:{merchant}    F      (only when F > 0)
 * CR 4000:fee_revenue                    F
 * DR 5000:provider_fee_expense           P      (only when P > 0)
 * CR 1000:provider_clearing:{provider}   P
 * ```
 *
 * Debits and credits are each `G + F + P`. Fees are zero until the fee engine exists, so
 * today's posting is the first two lines; the fee lines are here so the engine only has to
 * supply `F` and `P`. A failed, expired or cancelled payment posts nothing.
 */
import { AppError } from '../../../common/errors/app-error';
import {
  merchantAccountCode,
  platformAccountCode,
  providerAccountCode,
} from '../../accounts/domain/chart-of-accounts';
import type { PostingLineInput } from '../../ledger/domain/posting';
import type { PaymentProvider } from './payment-event';

export interface CollectionPostingInput {
  readonly provider: PaymentProvider;
  readonly merchantRef: string;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly providerFeeMinor: bigint;
}

function invalid(reason: string): AppError {
  return new AppError('PAYMENT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

/** Lines of the collection-succeeded entry. Throws if the fees do not fit inside the gross. */
export function collectionPostingLines(input: CollectionPostingInput): PostingLineInput[] {
  const { provider, merchantRef, grossMinor, feeMinor, providerFeeMinor } = input;
  if (grossMinor <= 0n) throw invalid('amount_must_be_positive');
  if (feeMinor < 0n || providerFeeMinor < 0n) throw invalid('fee');
  if (feeMinor > grossMinor) throw invalid('fee_exceeds_amount');
  if (providerFeeMinor > grossMinor) throw invalid('provider_fee_exceeds_amount');
  const clearing = providerAccountCode('provider_clearing', provider);
  const payable = merchantAccountCode('merchant_payable', merchantRef);
  const lines: PostingLineInput[] = [
    { accountCode: clearing, direction: 'debit', amountMinor: grossMinor },
    { accountCode: payable, direction: 'credit', amountMinor: grossMinor },
  ];
  if (feeMinor > 0n) {
    lines.push(
      { accountCode: payable, direction: 'debit', amountMinor: feeMinor },
      {
        accountCode: platformAccountCode('fee_revenue'),
        direction: 'credit',
        amountMinor: feeMinor,
      }
    );
  }
  if (providerFeeMinor > 0n) {
    lines.push(
      {
        accountCode: platformAccountCode('provider_fee_expense'),
        direction: 'debit',
        amountMinor: providerFeeMinor,
      },
      { accountCode: clearing, direction: 'credit', amountMinor: providerFeeMinor }
    );
  }
  return lines;
}
