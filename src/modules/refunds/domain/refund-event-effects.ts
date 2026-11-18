/**
 * Pure functions that decide what a refund event changes (follows payment pattern).
 */
import type { TransactionRow } from '../../transactions/transactions.repository';
import type {
  RefundEventInput,
  RefundRejectionReason,
  RefundStatus,
} from './refund-state-machine';

export interface TransactionChange {
  readonly status?: string;
  readonly provider?: string | null;
  readonly operationId?: string | null;
  readonly referenceId?: string | null;
  readonly providerTransactionId?: string | null;
  readonly outcomeUnknown?: boolean;
  readonly failureCode?: string | null;
  readonly failureReason?: string | null;
}

/**
 * Verifies that a success event's amounts and identifiers match the refund's recorded values.
 */
export function verifyEvent(
  transaction: TransactionRow,
  event: RefundEventInput
): RefundRejectionReason | null {
  const signal = event.signal;
  if (signal.kind !== 'succeeded') return null;

  // Amount verification
  if (signal.amountMinor !== undefined && signal.amountMinor !== transaction.amountMinor) {
    return 'amount_mismatch';
  }

  // Currency verification
  if (signal.currency && signal.currency !== transaction.currency) {
    return 'currency_mismatch';
  }

  // Provider verification: once set, cannot change
  const eventProvider = event.identifiers?.provider;
  if (eventProvider && transaction.provider && eventProvider !== transaction.provider) {
    return 'provider_mismatch';
  }

  return null;
}

/**
 * Builds the transaction patch from an event and the target status.
 */
export function changeFor(
  transaction: TransactionRow,
  event: RefundEventInput,
  to: RefundStatus,
  now: Date
): TransactionChange {
  const signal = event.signal;
  const ids = event.identifiers;

  const change: TransactionChange = {
    status: to,
  };

  // Update identifiers if provided and not yet set
  if (ids?.provider && !transaction.provider) {
    change.provider = ids.provider;
  }
  if (ids?.operationId && !transaction.operationId) {
    change.operationId = ids.operationId;
  }
  if (ids?.referenceId && !transaction.referenceId) {
    change.referenceId = ids.referenceId;
  }
  if (ids?.providerTransactionId && !transaction.providerTransactionId) {
    change.providerTransactionId = ids.providerTransactionId;
  }

  // Outcome unknown flag
  if (signal.outcomeUnknown !== undefined) {
    change.outcomeUnknown = signal.outcomeUnknown;
  }

  // Failure information
  if (signal.kind === 'failed') {
    change.failureCode = signal.failureCode ?? null;
    change.failureReason = signal.failureReason ?? null;
  }

  return change;
}

/**
 * Checks if the change adds information beyond what's already in the transaction (even if
 * the status stays the same).
 */
export function addsInformation(transaction: TransactionRow, change: TransactionChange): boolean {
  if (change.provider && change.provider !== transaction.provider) return true;
  if (change.operationId && change.operationId !== transaction.operationId) return true;
  if (change.referenceId && change.referenceId !== transaction.referenceId) return true;
  if (
    change.providerTransactionId &&
    change.providerTransactionId !== transaction.providerTransactionId
  )
    return true;
  if (change.outcomeUnknown !== undefined && change.outcomeUnknown !== transaction.outcomeUnknown)
    return true;
  if (change.failureCode !== undefined && change.failureCode !== transaction.failureCode)
    return true;
  if (change.failureReason !== undefined && change.failureReason !== transaction.failureReason)
    return true;
  return false;
}
