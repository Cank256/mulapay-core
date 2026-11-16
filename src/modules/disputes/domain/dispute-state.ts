/**
 * Dispute workflow and rules (spec 6.14). Pure; migration 0007 enforces the same transitions.
 *
 *   open -> under_review     staff start investigating
 *   open | under_review -> resolved     with an outcome: merchant_won, merchant_lost, withdrawn
 *
 * `resolved` is final. A dispute is about one successful live payment and at most its amount.
 */
import { AppError } from '../../../common/errors/app-error';

export const DISPUTE_STATUSES = ['open', 'under_review', 'resolved'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_OUTCOMES = ['merchant_won', 'merchant_lost', 'withdrawn'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export const DISPUTE_KINDS = ['chargeback', 'inquiry', 'pre_arbitration'] as const;
export type DisputeKind = (typeof DISPUTE_KINDS)[number];

export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_EVIDENCE_LENGTH = 2000;

function refuse(reason: string): AppError {
  return new AppError('DISPUTE_TRANSITION_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

function invalid(reason: string): AppError {
  return new AppError('DISPUTE_INVALID', { messageParams: { reason }, details: { reason } });
}

export function assertCanReview(status: DisputeStatus): void {
  if (status === 'resolved') throw refuse('dispute_resolved');
  if (status === 'under_review') throw refuse('already_under_review');
}

export function assertCanResolve(status: DisputeStatus): void {
  if (status === 'resolved') throw refuse('dispute_resolved');
}

/** Whether the merchant may still add evidence at `now`. */
export function assertCanAddEvidence(
  dispute: { status: DisputeStatus; evidenceDueAt: Date | null; evidenceCount: number },
  now: Date
): void {
  if (dispute.status === 'resolved') throw refuse('dispute_resolved');
  if (dispute.evidenceDueAt && dispute.evidenceDueAt <= now) throw refuse('evidence_period_over');
  if (dispute.evidenceCount >= MAX_EVIDENCE_ITEMS) throw refuse('too_much_evidence');
}

export interface DisputedTransaction {
  readonly merchantId: string;
  readonly environment: string;
  readonly type: string;
  readonly status: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly provider: string | null;
}

/** What may be disputed: a successful live payment of the merchant, for at most its amount. */
export function assertDisputable(
  transaction: DisputedTransaction,
  merchantId: string,
  amountMinor: bigint
): void {
  if (transaction.merchantId !== merchantId) throw invalid('transaction_not_found');
  if (transaction.environment !== 'live') throw invalid('not_live');
  if (transaction.type !== 'payment') throw invalid('not_a_payment');
  if (transaction.status !== 'succeeded') throw invalid('payment_not_succeeded');
  if (amountMinor <= 0n) throw invalid('amount');
  if (amountMinor > transaction.amountMinor) throw invalid('amount_exceeds_payment');
}

/** How much of a disputed amount can be held now, and how much cannot. */
export function splitHold(
  availableMinor: bigint,
  amountMinor: bigint
): { heldMinor: bigint; shortfallMinor: bigint } {
  const held =
    availableMinor <= 0n ? 0n : availableMinor < amountMinor ? availableMinor : amountMinor;
  return { heldMinor: held, shortfallMinor: amountMinor - held };
}
