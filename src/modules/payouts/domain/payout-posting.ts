/**
 * Payout (disbursement) ledger posting lines.
 *
 * When a payout succeeds, funds leave the merchant's payable balance and flow out through
 * the provider's clearing account, symmetric to how a collection brings them in:
 *
 * Collection (funds arrive):
 *   DR 1000:provider_clearing:{provider}   gross   (provider owes us)
 *   CR 2000:merchant_payable:{merchant}    gross   (we owe merchant)
 *   DR 2000:merchant_payable:{merchant}    fee     (MulaPay fee deducted)
 *   CR 4000:fee_revenue                    fee
 *   DR 5000:provider_fee_expense           pfee    (provider cost)
 *   CR 1000:provider_clearing:{provider}   pfee
 *
 * Disbursement (funds leave) mirrors the collection:
 *   DR 2000:merchant_payable:{merchant}    gross   (reduce merchant balance)
 *   CR 1000:provider_clearing:{provider}   gross   (funds go out via provider)
 *   DR 2000:merchant_payable:{merchant}    fee     (MulaPay payout fee)
 *   CR 4000:fee_revenue                    fee
 *   DR 5000:provider_fee_expense           pfee    (provider cost of disbursement)
 *   CR 1000:provider_clearing:{provider}   pfee
 *
 * Net clearing movement = gross - pfee (what the provider actually disburses minus its cost).
 * The entry balances: total debits = gross + fee + pfee = total credits.
 *
 * A failed or cancelled payout posts nothing (the hold is released instead).
 */
import { AppError } from '../../../common/errors/app-error';
import {
  merchantAccountCode,
  platformAccountCode,
  providerAccountCode,
  type LedgerProvider,
} from '../../accounts/domain/chart-of-accounts';
import type { PostingLineInput } from '../../ledger/domain/posting';

export interface PayoutPostingInput {
  readonly provider: LedgerProvider;
  readonly merchantRef: string;
  readonly grossMinor: bigint;
  /** MulaPay's payout fee charged to the merchant. */
  readonly feeMinor: bigint;
  /** Provider's cost of disbursement (passed through to expense). */
  readonly providerFeeMinor: bigint;
}

function invalid(reason: string): AppError {
  return new AppError('PAYOUT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

/**
 * Lines for the `payout.succeeded` journal entry. Throws if amounts are inconsistent.
 * The entry always balances: total debits = total credits = gross + fee + providerFee.
 */
export function payoutPostingLines(input: PayoutPostingInput): PostingLineInput[] {
  const { provider, merchantRef, grossMinor, feeMinor, providerFeeMinor } = input;
  if (grossMinor <= 0n) throw invalid('amount_must_be_positive');
  if (feeMinor < 0n || providerFeeMinor < 0n) throw invalid('fee');
  if (feeMinor > grossMinor) throw invalid('fee_exceeds_amount');
  if (providerFeeMinor > grossMinor) throw invalid('provider_fee_exceeds_amount');

  const payable = merchantAccountCode('merchant_payable', merchantRef);
  const clearing = providerAccountCode('provider_clearing', provider);

  // Gross movement: merchant payable → provider clearing
  const lines: PostingLineInput[] = [
    { accountCode: payable, direction: 'debit', amountMinor: grossMinor },
    { accountCode: clearing, direction: 'credit', amountMinor: grossMinor },
  ];

  // MulaPay payout fee: deduct from merchant payable, credit fee revenue
  if (feeMinor > 0n) {
    lines.push(
      { accountCode: payable, direction: 'debit', amountMinor: feeMinor },
      { accountCode: platformAccountCode('fee_revenue'), direction: 'credit', amountMinor: feeMinor }
    );
  }

  // Provider disbursement cost: debit expense, credit clearing
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
