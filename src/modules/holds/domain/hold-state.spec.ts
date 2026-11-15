import { describe, expect, it } from 'vitest';
import {
  decideCapture,
  decideRelease,
  isDueForExpiry,
  type HoldSnapshot,
  type HoldState,
} from './hold-state';
const snap = (
  state: HoldState,
  captureKey: string | null = null,
  releaseKey: string | null = null
) => ({ state, captureKey, releaseKey }) satisfies HoldSnapshot;
describe('hold state machine', () => {
  it('captures and releases an active hold', () => {
    expect(decideCapture(snap('active'), 'k')).toEqual({ kind: 'apply', to: 'captured' });
    expect(decideRelease(snap('active'), 'k')).toEqual({ kind: 'apply', to: 'released' });
  });
  it('replays the same key on a hold that already ended that way', () => {
    expect(decideCapture(snap('captured', 'k'), 'k')).toEqual({ kind: 'replay' });
    expect(decideRelease(snap('released', null, 'k'), 'k')).toEqual({ kind: 'replay' });
  });
  it('refuses a second key on a captured or released hold', () => {
    expect(decideCapture(snap('captured', 'k1'), 'k2')).toEqual({
      kind: 'reject',
      reason: 'already_captured',
    });
    expect(decideRelease(snap('released', null, 'k1'), 'k2')).toEqual({
      kind: 'reject',
      reason: 'already_released',
    });
  });
  it('never captures a released or expired hold, and never releases a captured or expired one', () => {
    for (const state of ['released', 'expired'] as const) {
      expect(decideCapture(snap(state, null, 'k'), 'k')).toEqual({
        kind: 'reject',
        reason: 'not_active',
      });
    }
    for (const state of ['captured', 'expired'] as const) {
      expect(decideRelease(snap(state, 'k'), 'k')).toEqual({
        kind: 'reject',
        reason: 'not_active',
      });
    }
  });
  it('expires only active holds with a past expiry', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const past = new Date('2024-12-31T23:59:59Z');
    expect(isDueForExpiry({ state: 'active', expiresAt: past }, now)).toBe(true);
    expect(isDueForExpiry({ state: 'active', expiresAt: now }, now)).toBe(true);
    expect(isDueForExpiry({ state: 'active', expiresAt: new Date('2025-01-02') }, now)).toBe(false);
    expect(isDueForExpiry({ state: 'active', expiresAt: null }, now)).toBe(false);
    expect(isDueForExpiry({ state: 'captured', expiresAt: past }, now)).toBe(false);
  });
});
