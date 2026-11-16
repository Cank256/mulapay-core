/**
 * The KYC profile state machine (spec 5.2, 6.13). Pure. The database enforces the same
 * transitions (migration 0007, `core.guard_kyc_profile`).
 *
 *   not_started -> pending                      the merchant submits
 *   pending     -> in_review | approved | rejected
 *   in_review   -> pending                      the merchant answers a request for information
 *               -> approved | rejected
 *   approved    -> pending                      a higher level, or re-verification
 *               -> expired                      the validity period ended
 *   rejected    -> pending                      the merchant corrects and submits again
 *   expired     -> pending                      re-verification
 */
import { AppError } from '../../../common/errors/app-error';

export const KYC_STATUSES = [
  'not_started',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'expired',
] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const MAX_KYC_LEVEL = 3;

export interface ProfileSnapshot {
  readonly status: KycStatus;
  /** The level the merchant is approved at (`merchants.kyc_level`). */
  readonly approvedLevel: number;
  readonly infoRequestedAt: Date | null;
  readonly nextReviewAt: Date | null;
}

export type SubmissionKind = 'initial' | 'resubmission' | 'upgrade' | 'reverification';

function notAllowed(reason: string): AppError {
  return new AppError('KYC_NOT_ALLOWED', { messageParams: { reason }, details: { reason } });
}

/**
 * What a submission for `targetLevel` is, or why it cannot be made now.
 *
 * - A first submission, or one after a rejection, needs a level above the approved one.
 * - After a request for information the merchant resubmits for the level in review.
 * - An approved merchant can apply for a higher level, or renew its current level once the
 *   re-verification notice has been given (`next_review_at` passed).
 * - An expired profile renews its level.
 */
export function decideSubmission(
  profile: ProfileSnapshot,
  targetLevel: number,
  inReviewLevel: number,
  now: Date
): SubmissionKind {
  if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > MAX_KYC_LEVEL) {
    throw notAllowed('invalid_level');
  }
  switch (profile.status) {
    case 'pending':
      throw notAllowed('already_submitted');
    case 'in_review':
      if (profile.infoRequestedAt === null) throw notAllowed('under_review');
      if (targetLevel !== inReviewLevel) throw notAllowed('level_cannot_change');
      return 'resubmission';
    case 'approved': {
      if (targetLevel > profile.approvedLevel) return 'upgrade';
      const due = profile.nextReviewAt !== null && profile.nextReviewAt <= now;
      if (targetLevel === profile.approvedLevel && due) return 'reverification';
      throw notAllowed(
        targetLevel > 0 && targetLevel <= profile.approvedLevel
          ? 'already_approved'
          : 'invalid_level'
      );
    }
    case 'expired':
      if (targetLevel < profile.approvedLevel) throw notAllowed('below_approved_level');
      return targetLevel === profile.approvedLevel ? 'reverification' : 'upgrade';
    case 'not_started':
    case 'rejected':
      if (targetLevel <= profile.approvedLevel) throw notAllowed('already_approved');
      return 'initial';
  }
}

/** Statuses in which staff may review (verify documents, approve, reject, ask for information). */
export function isReviewable(status: KycStatus): boolean {
  return status === 'pending' || status === 'in_review';
}
