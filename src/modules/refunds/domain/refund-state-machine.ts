/**
 * Refund state machine: valid transitions and decision logic (follows payment pattern).
 *
 * States: created → processing → succeeded/failed/cancelled
 *                 ↓
 *           pending_approval → processing
 *                 ↓
 *            cancelled
 *
 * Terminal states are final: a refund that is `succeeded`, `failed`, or `cancelled` never
 * moves again. Refunds do not have `expired` (unlike payments/payouts).
 */
import type { PaymentProvider } from '../../payments/domain/payment-event';

export type RefundStatus =
  | 'created'
  | 'pending_approval'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isRefundStatus(value: unknown): value is RefundStatus {
  return (
    typeof value === 'string' &&
    ['created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled'].includes(
      value
    )
  );
}

export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return TERMINAL_REFUND_STATUSES.includes(status);
}

export type RefundRejectionReason =
  | 'terminal'
  | 'invalid_transition'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'provider_mismatch';

export type TransitionDecision =
  | { readonly kind: 'apply' } // Status changes
  | { readonly kind: 'noop' } // Status stays, but identifiers may update
  | { readonly kind: 'reject'; readonly reason: RefundRejectionReason };

/**
 * Decides whether a transition from `from` to `to` is allowed.
 */
export function decideTransition(from: RefundStatus, to: RefundStatus): TransitionDecision {
  if (from === to) return { kind: 'noop' };
  if (isTerminalRefundStatus(from)) return { kind: 'reject', reason: 'terminal' };

  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed && allowed.includes(to)) {
    return { kind: 'apply' };
  }

  return { kind: 'reject', reason: 'invalid_transition' };
}

const ALLOWED_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  created: ['pending_approval', 'processing', 'failed', 'cancelled'],
  pending_approval: ['processing', 'cancelled'],
  processing: ['succeeded', 'failed'],
  // Terminal states cannot transition
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** Maps gateway status signals to refund statuses. */
export interface RefundEventSignal {
  readonly kind: 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly outcomeUnknown?: boolean;
  readonly amountMinor?: bigint;
  readonly currency?: string;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly feeMinor?: bigint;
  readonly providerFeeMinor?: bigint;
}

export interface RefundEventIdentifiers {
  readonly provider?: PaymentProvider;
  readonly operationId?: string;
  readonly referenceId?: string;
  readonly providerTransactionId?: string;
}

export interface RefundEventInput {
  readonly eventKey: string;
  readonly source: 'gateway_event' | 'api' | 'chase' | 'reconciliation';
  readonly occurredAt: Date;
  readonly signal: RefundEventSignal;
  readonly identifiers?: RefundEventIdentifiers;
}

export function signalTarget(signal: RefundEventSignal): RefundStatus {
  switch (signal.kind) {
    case 'processing':
      return 'processing';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function validateRefundEvent(event: RefundEventInput): void {
  if (!event.eventKey) throw new Error('event.eventKey is required');
  if (!event.source) throw new Error('event.source is required');
  if (!event.occurredAt) throw new Error('event.occurredAt is required');
  if (!event.signal) throw new Error('event.signal is required');
}
