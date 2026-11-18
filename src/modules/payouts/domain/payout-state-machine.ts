/**
 * Payout state machine: status transitions and decision logic (mirrors payment state machine).
 *
 * Valid transitions (enforced by database trigger + this code):
 *   created → pending_approval | processing | cancelled
 *   pending_approval → processing | cancelled
 *   processing → succeeded | failed | expired
 *   succeeded/failed/cancelled/expired → (terminal, no transitions)
 *
 * Payouts require approval when their amount exceeds the configured threshold.
 */

export type PayoutStatus =
  | 'created'
  | 'pending_approval'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;

export function isPayoutStatus(value: unknown): value is PayoutStatus {
  return (
    typeof value === 'string' &&
    ['created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled', 'expired'].includes(value)
  );
}

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TERMINAL_PAYOUT_STATUSES.includes(status);
}

export type PayoutRejectionReason =
  | 'terminal_status'
  | 'invalid_transition'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'provider_mismatch'
  | 'gateway_id_mismatch';

export type TransitionDecision =
  | { readonly kind: 'apply' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'reject'; readonly reason: PayoutRejectionReason };

/**
 * Decides whether a transition from -> to is valid.
 * Terminal states refuse any further change.
 * Non-terminal states check valid outgoing edges.
 */
export function decideTransition(from: PayoutStatus, to: PayoutStatus): TransitionDecision {
  if (from === to) return { kind: 'noop' };
  if (isTerminalPayoutStatus(from)) {
    return { kind: 'reject', reason: 'terminal_status' };
  }

  // Valid transitions from non-terminal states
  switch (from) {
    case 'created':
      if (['pending_approval', 'processing', 'cancelled'].includes(to)) {
        return { kind: 'apply' };
      }
      break;
    case 'pending_approval':
      if (['processing', 'cancelled'].includes(to)) {
        return { kind: 'apply' };
      }
      break;
    case 'processing':
      if (['succeeded', 'failed', 'expired'].includes(to)) {
        return { kind: 'apply' };
      }
      break;
  }

  return { kind: 'reject', reason: 'invalid_transition' };
}
