/**
 * The settlement batch state machine (spec 6.9). Pure, repeated in Postgres
 * (`core.settlement_transition_allowed`).
 *
 *   draft -> pending_approval -> approved -> releasing -> paid
 *   releasing -> failed
 *   draft | pending_approval | approved -> cancelled
 *
 * Nothing is posted to the ledger at `draft` or `approved`. Money moves only when a payout
 * reaches a terminal gateway outcome while the batch is `releasing`.
 */
import { AppError } from '../../../common/errors/app-error';

export const BATCH_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'releasing',
  'paid',
  'failed',
  'cancelled',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

const TRANSITIONS: Readonly<Record<BatchStatus, readonly BatchStatus[]>> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'cancelled'],
  approved: ['releasing', 'cancelled'],
  releasing: ['paid', 'failed'],
  paid: [],
  failed: [],
  cancelled: [],
};

export function isBatchStatus(value: string): value is BatchStatus {
  return (BATCH_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: BatchStatus, to: BatchStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: BatchStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Throws `SETTLEMENT_INVALID_TRANSITION` unless the move is on the path above. */
export function assertTransition(from: BatchStatus, to: BatchStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('SETTLEMENT_INVALID_TRANSITION', {
      messageParams: { from, to },
      details: { from, to },
    });
  }
}

/** Maker-checker: the person who submitted a batch never approves it. */
export function assertMakerChecker(submittedBy: string | null, approver: string): void {
  if (submittedBy !== null && submittedBy === approver) {
    throw new AppError('SETTLEMENT_APPROVER_IS_SUBMITTER');
  }
}
