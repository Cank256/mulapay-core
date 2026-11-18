/**
 * Payout event effects: what changes an event makes to the transaction row.
 *
 * Mirrors payment-event-effects.ts for payout lifecycle.
 */
import type { TransactionRow } from '../../transactions/transactions.repository';
import type { PayoutEventInput, PayoutSignal } from './payout-event';
import type { PayoutRejectionReason, PayoutStatus } from './payout-state-machine';

export interface TransactionChange {
  readonly status?: PayoutStatus;
  readonly provider?: string;
  readonly gatewayId?: string;
  readonly feeMinor?: bigint;
  readonly netMinor?: bigint;
  readonly failureCode?: string | null;
  readonly outcomeUnknown?: boolean;
  readonly updatedAt?: Date;
  readonly completedAt?: Date | null;
}

/**
 * Verify that gateway details match what the transaction already has.
 * Returns rejection reason if verification fails, null if ok.
 */
export function verifyEvent(
  transaction: TransactionRow,
  event: PayoutEventInput
): PayoutRejectionReason | null {
  if (!event.gatewayDetails) return null;

  const { provider, gatewayId, amountMinor, currency } = event.gatewayDetails;

  // Amount and currency must match transaction
  if (amountMinor !== transaction.amountMinor) return 'amount_mismatch';
  if (currency !== transaction.currency) return 'currency_mismatch';

  // Provider must match if already set
  if (transaction.provider !== null && transaction.provider !== provider) {
    return 'provider_mismatch';
  }

  // Gateway ID must match if already set
  if (transaction.gatewayId !== null && transaction.gatewayId !== gatewayId) {
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
): TransactionChange {
  const change: TransactionChange = {
    status: targetStatus,
    updatedAt: now,
  };

  // Set provider and gateway ID from event details
  if (event.gatewayDetails) {
    if (transaction.provider === null) {
      change.provider = event.gatewayDetails.provider;
    }
    if (transaction.gatewayId === null) {
      change.gatewayId = event.gatewayDetails.gatewayId;
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
    change.failureCode = signal.code ?? null;
    change.outcomeUnknown = false;
    change.completedAt = now;
  } else if (signal.kind === 'processing') {
    // Processing doesn't resolve outcome
    change.outcomeUnknown = true;
  } else if (signal.kind === 'expired' || signal.kind === 'cancelled') {
    change.outcomeUnknown = false;
    change.completedAt = now;
  }

  return change;
}

/**
 * Does this event add information not already in the transaction?
 */
export function addsInformation(transaction: TransactionRow, change: TransactionChange): boolean {
  if (change.provider !== undefined && transaction.provider === null) return true;
  if (change.gatewayId !== undefined && transaction.gatewayId === null) return true;
  if (change.outcomeUnknown !== undefined && transaction.outcomeUnknown !== change.outcomeUnknown)
    return true;
  if (change.failureCode !== undefined && transaction.failureCode !== change.failureCode)
    return true;
  return false;
}
