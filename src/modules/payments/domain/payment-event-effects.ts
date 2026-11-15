/**
 * What an event does to a payment's transaction row, and whether it can be believed.
 * Pure: the lifecycle service reads the row, calls these, and writes the result.
 */
import { AppError } from '../../../common/errors/app-error';
import type { PaymentEventInput } from './payment-event';
import {
  isTerminalPaymentStatus,
  type PaymentRejectionReason,
  type PaymentStatus,
} from './payment-state-machine';

/** The columns of a payment's transaction that events read or change. */
export interface TransactionFacts {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly provider: string | null;
  readonly gatewayOperationId: string | null;
  readonly gatewayReferenceId: string | null;
  readonly providerTransactionId: string | null;
  readonly initiatedAt: Date | null;
  readonly outcomeUnknown: boolean;
}

export interface TransactionChange {
  status: PaymentStatus;
  outcomeUnknown: boolean;
  provider: string | null;
  gatewayOperationId: string | null;
  gatewayReferenceId: string | null;
  providerTransactionId: string | null;
  initiatedAt: Date | null;
  completedAt?: Date;
  failureCode?: string | null;
  failureReason?: string | null;
  feeMinor?: bigint;
  netMinor?: bigint;
}

/**
 * Checks an event against what the payment already records. Returns why it must be refused,
 * or null. A success that names a different amount or currency, or an event that names a
 * different provider or gateway identifier than the one recorded, is not believed: the
 * provider's status alone does not establish what was collected (spec 3.7, 17.5).
 */
export function verifyEvent(
  facts: TransactionFacts,
  event: PaymentEventInput
): PaymentRejectionReason | null {
  const { signal, identifiers } = event;
  if (signal.kind === 'succeeded') {
    if (signal.amountMinor !== undefined && signal.amountMinor !== facts.amountMinor) {
      return 'amount_mismatch';
    }
    if (signal.currency !== undefined && signal.currency !== facts.currency) {
      return 'currency_mismatch';
    }
  }
  if (identifiers?.provider && facts.provider && identifiers.provider !== facts.provider) {
    return 'provider_mismatch';
  }
  const conflicts = (current: string | null, next: string | undefined) =>
    current !== null && next !== undefined && current !== next;
  if (
    conflicts(facts.gatewayOperationId, identifiers?.operationId) ||
    conflicts(facts.gatewayReferenceId, identifiers?.referenceId) ||
    conflicts(facts.providerTransactionId, identifiers?.providerTransactionId)
  ) {
    return 'identifier_conflict';
  }
  return null;
}

/**
 * The columns an event sets, relative to what the row already holds. Identifiers already
 * recorded are kept (they are set once); `outcomeUnknown` follows the event and is always
 * false outside `processing`; a terminal status stamps `completedAt`.
 */
export function changeFor(
  facts: TransactionFacts,
  event: PaymentEventInput,
  to: PaymentStatus,
  now: Date
): TransactionChange {
  const { signal, identifiers } = event;
  const provider = facts.provider ?? identifiers?.provider ?? null;
  if (to === 'succeeded' && provider === null) {
    throw new AppError('PAYMENT_REQUEST_INVALID', {
      messageParams: { reason: 'provider_required' },
      details: { reason: 'provider_required' },
    });
  }
  const change: TransactionChange = {
    status: to,
    outcomeUnknown: signal.kind === 'processing' ? signal.outcomeUnknown : false,
    provider,
    gatewayOperationId: facts.gatewayOperationId ?? identifiers?.operationId ?? null,
    gatewayReferenceId: facts.gatewayReferenceId ?? identifiers?.referenceId ?? null,
    providerTransactionId:
      facts.providerTransactionId ?? identifiers?.providerTransactionId ?? null,
    initiatedAt:
      facts.initiatedAt ?? (to === 'processing' || to === 'requires_action' ? now : null),
  };
  if (isTerminalPaymentStatus(to)) change.completedAt = now;
  if (signal.kind === 'failed' || signal.kind === 'cancelled' || signal.kind === 'expired') {
    change.failureCode = signal.failureCode ?? null;
    change.failureReason = signal.failureReason ?? null;
  }
  if (signal.kind === 'succeeded') {
    const fee = signal.feeMinor ?? 0n;
    change.feeMinor = fee;
    change.netMinor = facts.amountMinor - fee;
  }
  return change;
}

/**
 * True when applying `change` would alter an attribute other than the status: the outcome
 * flag or a gateway identifier. Used to tell a repeated event from one that adds
 * information, for a payment that is not terminal.
 */
export function addsInformation(facts: TransactionFacts, change: TransactionChange): boolean {
  return (
    facts.outcomeUnknown !== change.outcomeUnknown ||
    facts.provider !== change.provider ||
    facts.gatewayOperationId !== change.gatewayOperationId ||
    facts.gatewayReferenceId !== change.gatewayReferenceId ||
    facts.providerTransactionId !== change.providerTransactionId ||
    (facts.initiatedAt === null) !== (change.initiatedAt === null)
  );
}
