/**
 * The payment state machine (spec 6.1, 3.7). Pure: no I/O, so every transition, legal or
 * not, is unit-tested.
 *
 * ```
 * created -> requires_action -> processing -> succeeded
 *                            \             \-> failed
 *                             \-> cancelled
 * created -> processing            (no customer action needed)
 * processing -> expired
 * ```
 *
 * Two edges are not in the spec diagram: `created -> cancelled` and `created -> expired`.
 * They cover a payment that was never submitted to a provider (a merchant cancels it, or
 * its checkout session lapses); without them such a payment could never leave `created`.
 * They are listed as decisions to confirm in docs/ARCHITECTURE.md. Nothing else is added:
 * a gateway `cancelled` or `expired` for a payment in `requires_action`, or `cancelled`
 * for one in `processing`, is refused and left to reconciliation.
 *
 * `succeeded`, `failed`, `cancelled` and `expired` are terminal. A terminal payment never
 * changes again (spec 3.7): the database trigger `core.guard_payment_update` repeats that,
 * and `core.payment_transition_allowed` repeats the allowed pairs. An integration test
 * compares this table with the database function for every ordered pair.
 *
 * "Unknown" is not a status. An ambiguous gateway outcome leaves the payment in
 * `processing` with `outcome_unknown = true` (spec 3.7, 17.5).
 */
export const PAYMENT_STATUSES = [
  'created',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TERMINAL_PAYMENT_STATUSES = ['succeeded', 'failed', 'cancelled', 'expired'] as const;
export type TerminalPaymentStatus = (typeof TERMINAL_PAYMENT_STATUSES)[number];

/** Every allowed move out of each status. A terminal status has none. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['requires_action', 'processing', 'cancelled', 'expired'],
  requires_action: ['processing', 'cancelled'],
  processing: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** True for a status the payment never leaves. */
export function isTerminalPaymentStatus(status: PaymentStatus): status is TerminalPaymentStatus {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/** True when `from -> to` is an allowed move. A move to the same status is not a move. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Why an event was refused. Recorded on the transaction event for reconciliation. */
export type PaymentRejectionReason =
  | 'terminal_state'
  | 'invalid_transition'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'provider_mismatch'
  | 'identifier_conflict';

export type TransitionDecision =
  | { readonly kind: 'apply' }
  /** The payment is already in the requested status; nothing to move. */
  | { readonly kind: 'noop' }
  | { readonly kind: 'reject'; readonly reason: 'terminal_state' | 'invalid_transition' };

/**
 * Decides what an event asking for `to` does to a payment that is in `from`.
 *
 * Invariants upheld:
 *  - a terminal payment is never moved: a request for a different status is refused as
 *    `terminal_state`, however it arrived (late event, duplicate with different content,
 *    manual action);
 *  - the same status asked for again is a no-op, never an error: events are delivered at
 *    least once, and two sources (consumer and chase job) may report the same outcome;
 *  - any other pair that is not in the table is `invalid_transition`.
 */
export function decideTransition(from: PaymentStatus, to: PaymentStatus): TransitionDecision {
  if (from === to) return { kind: 'noop' };
  if (isTerminalPaymentStatus(from)) return { kind: 'reject', reason: 'terminal_state' };
  if (!canTransition(from, to)) return { kind: 'reject', reason: 'invalid_transition' };
  return { kind: 'apply' };
}
