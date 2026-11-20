/**
 * Payout event effects: what changes an event makes to the transaction row.
 *
 * Mirrors payment-event-effects.ts for payout lifecycle.
 */
import type { TransactionRow, TransactionPatch } from '../../transactions/transactions.repository';
import type { PayoutEventInput } from './payout-event';
import type { PayoutRejectionReason, PayoutStatus } from './payout-state-machine';

/**
 * Verify that gateway details AND the success signal amounts match the transaction.
 * Returns rejection reason if verification fails, null if ok.
 */
export function verifyEvent(
  transaction: TransactionRow,
  event: PayoutEventInput
): PayoutRejectionReason | null {
  const { signal, gatewayDetails } = event;

  // Verify amounts and currency from the success signal (the definitive source).
  if (signal.kind === 'succeeded') {
    if (signal.amountMinor !== undefined && signal.amountMinor !== transaction.amountMinor) {
      return 'amount_mismatch';
    }
    if (signal.currency !== undefined && signal.currency !== transaction.currency) {
      return 'currency_mismatch';
    }
  }

  if (!gatewayDetails) return null;

  const { provider, operationId, referenceId, amountMinor, currency } = gatewayDetails;

  // Amount and currency from gateway details are a secondary check.
  if (amountMinor !== undefined && amountMinor !== transaction.amountMinor) {
    return 'amount_mismatch';
  }
  if (currency !== undefined && currency !== transaction.currency) {
    return 'currency_mismatch';
  }

  // Provider must match if already set
  if (transaction.provider !== null && provider && transaction.provider !== provider) {
    return 'provider_mismatch';
  }

  // Gateway operation ID must match if already set
  if (
    transaction.gatewayOperationId !== null &&
    operationId &&
    transaction.gatewayOperationId !== operationId
  ) {
    return 'gateway_id_mismatch';
  }

  // Gateway reference ID must match if already set
  if (
    transaction.gatewayReferenceId !== null &&
    referenceId &&
    transaction.gatewayReferenceId !== referenceId
  ) {
    return 'gateway_id_mismatch';
  }

  return null;
}

/**
 * Compute the changes this event makes to the transaction.
 */
export function changeFor(
  transaction: TransactionRow,
  event: PayoutEventInput,
  targetStatus: PayoutStatus,
  now: Date
): TransactionPatch {
  const change: TransactionPatch = {
    status: targetStatus,
  };

  // Set provider and gateway IDs from event details
  if (event.gatewayDetails) {
    if (transaction.provider === null && event.gatewayDetails.provider) {
      change.provider = event.gatewayDetails.provider;
    }
    if (transaction.gatewayOperationId === null && event.gatewayDetails.operationId) {
      change.gatewayOperationId = event.gatewayDetails.operationId;
    }
    if (transaction.gatewayReferenceId === null && event.gatewayDetails.referenceId) {
      change.gatewayReferenceId = event.gatewayDetails.referenceId;
    }
    if (transaction.providerTransactionId === null && event.gatewayDetails.providerTransactionId) {
      change.providerTransactionId = event.gatewayDetails.providerTransactionId;
    }
  }

  const signal = event.signal;

  if (signal.kind === 'succeeded') {
    const feeMinor = signal.feeMinor ?? 0n;
    const providerFeeMinor = signal.providerFeeMinor ?? 0n;
    change.feeMinor = feeMinor + providerFeeMinor;
    change.netMinor = transaction.amountMinor - change.feeMinor;
    change.outcomeUnknown = false;
    change.completedAt = now;
  } else if (signal.kind === 'failed') {
    change.failureCode = signal.code ?? undefined;
    change.outcomeUnknown = false;
    change.completedAt = now;
  } else if (signal.kind === 'processing') {
    // Processing doesn't resolve outcome
    change.outcomeUnknown = signal.outcomeUnknown ?? false;
  } else if (signal.kind === 'expired' || signal.kind === 'cancelled') {
    change.failureCode = signal.code ?? undefined;
    change.outcomeUnknown = false;
    change.completedAt = now;
  }

  return change;
}

/**
 * Does this event add information not already in the transaction?
 */
export function addsInformation(transaction: TransactionRow, change: TransactionPatch): boolean {
  if (change.provider !== undefined && transaction.provider === null) return true;
  if (change.gatewayOperationId !== undefined && transaction.gatewayOperationId === null)
    return true;
  if (change.gatewayReferenceId !== undefined && transaction.gatewayReferenceId === null)
    return true;
  if (change.providerTransactionId !== undefined && transaction.providerTransactionId === null)
    return true;
  if (change.outcomeUnknown !== undefined && transaction.outcomeUnknown !== change.outcomeUnknown)
    return true;
  if (change.failureCode !== undefined && transaction.failureCode !== change.failureCode)
    return true;
  return false;
}
