import { describe, expect, it } from 'vitest';
import {
  canTransition,
  decideTransition,
  isPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  TERMINAL_PAYMENT_STATUSES,
  type PaymentStatus,
} from './payment-state-machine';

/** The spec 6.1 diagram, written out independently of the table under test. */
const SPEC_EDGES: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
  ['created', 'requires_action'],
  ['requires_action', 'processing'],
  ['processing', 'succeeded'],
  ['processing', 'failed'],
  ['requires_action', 'cancelled'],
  ['created', 'processing'],
  ['processing', 'expired'],
];
/** Additions for a payment never submitted to a provider (documented decision). */
const EXTRA_EDGES: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
  ['created', 'cancelled'],
  ['created', 'expired'],
];
const ALLOWED = new Set([...SPEC_EDGES, ...EXTRA_EDGES].map(([a, b]) => `${a}>${b}`));

describe('payment state machine', () => {
  it('allows exactly the spec diagram plus the two documented additions', () => {
    const fromTable = PAYMENT_STATUSES.flatMap((from) =>
      PAYMENT_TRANSITIONS[from].map((to) => `${from}>${to}`)
    );
    expect(new Set(fromTable)).toEqual(ALLOWED);
    expect(fromTable).toHaveLength(ALLOWED.size);
  });

  it.each(SPEC_EDGES)('allows %s -> %s from the spec diagram', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(decideTransition(from, to)).toEqual({ kind: 'apply' });
  });

  it.each(EXTRA_EDGES)('allows %s -> %s for a payment never submitted', (from, to) => {
    expect(decideTransition(from, to)).toEqual({ kind: 'apply' });
  });

  it('decides every ordered pair of statuses', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        const decision = decideTransition(from, to);
        if (from === to) {
          expect(decision, `${from} -> ${to}`).toEqual({ kind: 'noop' });
        } else if (ALLOWED.has(`${from}>${to}`)) {
          expect(decision, `${from} -> ${to}`).toEqual({ kind: 'apply' });
        } else if (isTerminalPaymentStatus(from)) {
          expect(decision, `${from} -> ${to}`).toEqual({
            kind: 'reject',
            reason: 'terminal_state',
          });
        } else {
          expect(decision, `${from} -> ${to}`).toEqual({
            kind: 'reject',
            reason: 'invalid_transition',
          });
        }
      }
    }
  });

  it('never leaves a terminal status', () => {
    for (const from of TERMINAL_PAYMENT_STATUSES) {
      expect(PAYMENT_TRANSITIONS[from]).toEqual([]);
      for (const to of PAYMENT_STATUSES) {
        if (to !== from) expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('refuses the moves the spec leaves out', () => {
    // A gateway cancel or expiry for a payment awaiting customer action, a cancel while a
    // provider operation is running, and any move backwards.
    for (const [from, to] of [
      ['requires_action', 'expired'],
      ['requires_action', 'failed'],
      ['requires_action', 'succeeded'],
      ['processing', 'cancelled'],
      ['processing', 'created'],
      ['processing', 'requires_action'],
      ['requires_action', 'created'],
      ['created', 'succeeded'],
      ['created', 'failed'],
    ] as const) {
      expect(decideTransition(from, to), `${from} -> ${to}`).toEqual({
        kind: 'reject',
        reason: 'invalid_transition',
      });
    }
  });

  it('reports a repeated terminal status as a no-op and a different one as refused', () => {
    expect(decideTransition('succeeded', 'succeeded')).toEqual({ kind: 'noop' });
    expect(decideTransition('failed', 'failed')).toEqual({ kind: 'noop' });
    expect(decideTransition('succeeded', 'failed')).toEqual({
      kind: 'reject',
      reason: 'terminal_state',
    });
    expect(decideTransition('expired', 'succeeded')).toEqual({
      kind: 'reject',
      reason: 'terminal_state',
    });
    expect(decideTransition('cancelled', 'processing')).toEqual({
      kind: 'reject',
      reason: 'terminal_state',
    });
  });

  it('treats a repeated non-terminal status as a no-op', () => {
    expect(decideTransition('processing', 'processing')).toEqual({ kind: 'noop' });
    expect(decideTransition('created', 'created')).toEqual({ kind: 'noop' });
  });

  it('recognises statuses', () => {
    expect(isPaymentStatus('processing')).toBe(true);
    expect(isPaymentStatus('unknown')).toBe(false);
    expect(isPaymentStatus('successful')).toBe(false);
  });
});
