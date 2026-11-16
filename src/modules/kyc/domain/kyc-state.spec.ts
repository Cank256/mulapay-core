import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { decideSubmission, isReviewable, type ProfileSnapshot } from './kyc-state';

const NOW = new Date('2025-06-01T00:00:00Z');
const profile = (over: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  status: 'not_started',
  approvedLevel: 0,
  infoRequestedAt: null,
  nextReviewAt: null,
  ...over,
});
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) {
      return (error.details as { reason: string }).reason;
    }
    throw error;
  }
  return 'allowed';
}

describe('decideSubmission', () => {
  it('lets a new merchant apply for level 1, and a rejected one apply again', () => {
    expect(decideSubmission(profile(), 1, 1, NOW)).toBe('initial');
    expect(decideSubmission(profile({ status: 'rejected' }), 1, 1, NOW)).toBe('initial');
  });

  it('refuses a submission while one is waiting or under review', () => {
    expect(refusal(() => decideSubmission(profile({ status: 'pending' }), 1, 1, NOW))).toBe(
      'already_submitted'
    );
    expect(refusal(() => decideSubmission(profile({ status: 'in_review' }), 1, 1, NOW))).toBe(
      'under_review'
    );
  });

  it('lets the merchant answer a request for information, for the same level only', () => {
    const asked = profile({ status: 'in_review', infoRequestedAt: NOW });
    expect(decideSubmission(asked, 2, 2, NOW)).toBe('resubmission');
    expect(refusal(() => decideSubmission(asked, 3, 2, NOW))).toBe('level_cannot_change');
  });

  it('lets an approved merchant apply for a higher level but not the same one early', () => {
    const approved = profile({
      status: 'approved',
      approvedLevel: 1,
      nextReviewAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(decideSubmission(approved, 2, 1, NOW)).toBe('upgrade');
    expect(refusal(() => decideSubmission(approved, 1, 1, NOW))).toBe('already_approved');
  });

  it('opens re-verification once the notice date has passed', () => {
    const due = profile({
      status: 'approved',
      approvedLevel: 2,
      nextReviewAt: new Date('2025-05-01T00:00:00Z'),
    });
    expect(decideSubmission(due, 2, 2, NOW)).toBe('reverification');
  });

  it('renews an expired level, or goes higher, but never lower', () => {
    const expired = profile({ status: 'expired', approvedLevel: 2 });
    expect(decideSubmission(expired, 2, 2, NOW)).toBe('reverification');
    expect(decideSubmission(expired, 3, 2, NOW)).toBe('upgrade');
    expect(refusal(() => decideSubmission(expired, 1, 2, NOW))).toBe('below_approved_level');
  });

  it('refuses levels outside 1 to 3 and levels already approved', () => {
    expect(refusal(() => decideSubmission(profile(), 0, 1, NOW))).toBe('invalid_level');
    expect(refusal(() => decideSubmission(profile(), 4, 1, NOW))).toBe('invalid_level');
    expect(refusal(() => decideSubmission(profile({ approvedLevel: 2 }), 2, 1, NOW))).toBe(
      'already_approved'
    );
  });

  it('knows which statuses staff can review', () => {
    expect(isReviewable('pending')).toBe(true);
    expect(isReviewable('in_review')).toBe(true);
    expect(
      ['not_started', 'approved', 'rejected', 'expired'].some((s) => isReviewable(s as never))
    ).toBe(false);
  });
});
