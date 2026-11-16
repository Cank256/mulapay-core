import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import {
  assertCanAddEvidence,
  assertCanResolve,
  assertCanReview,
  assertDisputable,
  splitHold,
  type DisputedTransaction,
} from './dispute-state';

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return (error.details as { reason: string }).reason;
    throw error;
  }
  return 'allowed';
}

const payment: DisputedTransaction = {
  merchantId: 'm1',
  environment: 'live',
  type: 'payment',
  status: 'succeeded',
  amountMinor: 10_000n,
  currency: 'UGX',
  provider: 'mtn',
};

describe('what can be disputed', () => {
  it('is a successful live payment of the merchant, up to its amount', () => {
    expect(reason(() => assertDisputable(payment, 'm1', 10_000n))).toBe('allowed');
    expect(reason(() => assertDisputable(payment, 'm1', 1n))).toBe('allowed');
    expect(reason(() => assertDisputable(payment, 'm1', 10_001n))).toBe('amount_exceeds_payment');
    expect(reason(() => assertDisputable(payment, 'm1', 0n))).toBe('amount');
    expect(reason(() => assertDisputable(payment, 'm2', 100n))).toBe('transaction_not_found');
    expect(reason(() => assertDisputable({ ...payment, environment: 'test' }, 'm1', 100n))).toBe(
      'not_live'
    );
    expect(reason(() => assertDisputable({ ...payment, type: 'payout' }, 'm1', 100n))).toBe(
      'not_a_payment'
    );
    expect(reason(() => assertDisputable({ ...payment, status: 'processing' }, 'm1', 100n))).toBe(
      'payment_not_succeeded'
    );
  });
});

describe('dispute workflow', () => {
  it('reviews an open dispute once and resolves any unresolved one', () => {
    expect(reason(() => assertCanReview('open'))).toBe('allowed');
    expect(reason(() => assertCanReview('under_review'))).toBe('already_under_review');
    expect(reason(() => assertCanReview('resolved'))).toBe('dispute_resolved');
    expect(reason(() => assertCanResolve('open'))).toBe('allowed');
    expect(reason(() => assertCanResolve('under_review'))).toBe('allowed');
    expect(reason(() => assertCanResolve('resolved'))).toBe('dispute_resolved');
  });

  it('accepts evidence until the due date, the limit or the end of the dispute', () => {
    const now = new Date('2025-03-01T00:00:00Z');
    const base = {
      status: 'open' as const,
      evidenceDueAt: new Date('2025-03-02T00:00:00Z'),
      evidenceCount: 0,
    };
    expect(reason(() => assertCanAddEvidence(base, now))).toBe('allowed');
    expect(reason(() => assertCanAddEvidence({ ...base, evidenceDueAt: null }, now))).toBe(
      'allowed'
    );
    expect(reason(() => assertCanAddEvidence({ ...base, evidenceDueAt: now }, now))).toBe(
      'evidence_period_over'
    );
    expect(reason(() => assertCanAddEvidence({ ...base, evidenceCount: 20 }, now))).toBe(
      'too_much_evidence'
    );
    expect(reason(() => assertCanAddEvidence({ ...base, status: 'resolved' }, now))).toBe(
      'dispute_resolved'
    );
  });
});

describe('splitting the disputed amount between hold and shortfall', () => {
  it('holds what is available up to the amount, and the two always add up', () => {
    expect(splitHold(100n, 60n)).toEqual({ heldMinor: 60n, shortfallMinor: 0n });
    expect(splitHold(60n, 60n)).toEqual({ heldMinor: 60n, shortfallMinor: 0n });
    expect(splitHold(20n, 60n)).toEqual({ heldMinor: 20n, shortfallMinor: 40n });
    expect(splitHold(0n, 60n)).toEqual({ heldMinor: 0n, shortfallMinor: 60n });
    expect(splitHold(-5n, 60n)).toEqual({ heldMinor: 0n, shortfallMinor: 60n });
    for (const available of [-1n, 0n, 1n, 59n, 60n, 1000n]) {
      const { heldMinor, shortfallMinor } = splitHold(available, 60n);
      expect(heldMinor + shortfallMinor).toBe(60n);
      expect(heldMinor >= 0n && shortfallMinor >= 0n).toBe(true);
    }
  });
});
