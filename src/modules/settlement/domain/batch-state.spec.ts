import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import {
  assertMakerChecker,
  assertTransition,
  BATCH_STATUSES,
  canTransition,
  isBatchStatus,
  isTerminal,
} from './batch-state';
import { decidePayoutOutcome } from './payout-outcome';

describe('settlement batch state machine', () => {
  const allowed = new Set([
    'draft>pending_approval',
    'draft>cancelled',
    'pending_approval>approved',
    'pending_approval>cancelled',
    'approved>releasing',
    'approved>cancelled',
    'releasing>paid',
    'releasing>failed',
  ]);

  it('allows exactly the spec 6.9 transitions and refuses every other pair', () => {
    for (const from of BATCH_STATUSES) {
      for (const to of BATCH_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('cannot be cancelled once releasing, and terminal states are final', () => {
    expect(canTransition('releasing', 'cancelled')).toBe(false);
    for (const s of ['paid', 'failed', 'cancelled'] as const) expect(isTerminal(s)).toBe(true);
    expect(isTerminal('releasing')).toBe(false);
    expect(isBatchStatus('paid')).toBe(true);
    expect(isBatchStatus('rolled_over')).toBe(false);
  });

  it('throws a catalogue error for an illegal move', () => {
    expect(() => assertTransition('draft', 'paid')).toThrow(AppError);
    expect(() => assertTransition('draft', 'pending_approval')).not.toThrow();
  });

  it('refuses the submitter as approver', () => {
    expect(() => assertMakerChecker('a', 'a')).toThrow(AppError);
    expect(() => assertMakerChecker('a', 'b')).not.toThrow();
    expect(() => assertMakerChecker(null, 'a')).not.toThrow();
  });
});

describe('payout outcome decisions', () => {
  const ok = { kind: 'succeeded', amountMinor: 1n, currency: 'UGX' } as const;
  it('applies success and failure while releasing, and records processing', () => {
    expect(decidePayoutOutcome('releasing', 'processing', ok).action).toBe('apply_success');
    expect(decidePayoutOutcome('releasing', 'created', { kind: 'expired' }).action).toBe(
      'apply_failure'
    );
    expect(
      decidePayoutOutcome('releasing', 'processing', { kind: 'processing', outcomeUnknown: true })
        .action
    ).toBe('record_processing');
  });
  it('rejects an outcome for a payout that is already terminal', () => {
    expect(decidePayoutOutcome('releasing', 'succeeded', ok).action).toBe('reject');
  });
  it('treats a repeat as a no-op and a contradiction as a rejection', () => {
    expect(decidePayoutOutcome('paid', 'succeeded', ok).action).toBe('noop');
    expect(decidePayoutOutcome('paid', 'succeeded', { kind: 'failed' })).toEqual({
      action: 'reject',
      reason: 'failure_after_paid',
    });
    expect(decidePayoutOutcome('failed', 'failed', { kind: 'cancelled' }).action).toBe('noop');
    expect(decidePayoutOutcome('failed', 'failed', ok)).toEqual({
      action: 'reject',
      reason: 'success_after_failed',
    });
    expect(
      decidePayoutOutcome('paid', 'succeeded', { kind: 'processing', outcomeUnknown: false }).action
    ).toBe('noop');
    expect(
      decidePayoutOutcome('failed', 'failed', { kind: 'processing', outcomeUnknown: true }).action
    ).toBe('noop');
  });
  it('rejects an outcome for a batch that was never released', () => {
    expect(decidePayoutOutcome('approved', 'created', ok)).toEqual({
      action: 'reject',
      reason: 'batch_not_releasing',
    });
  });
});
