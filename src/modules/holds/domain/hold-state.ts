/**
 * The hold state machine (spec 6.7). Pure.
 *
 *   active -> captured | released | expired      (each final)
 *
 * Capture and release are idempotent on their own key: the same key again on a hold that
 * ended that way is a replay and changes nothing. Any other request on a hold that is not
 * active is an error. Capturing a released hold is never a silent no-op (spec 6.7), and a
 * hold captured once cannot be captured under a second key.
 */
export const HOLD_STATES = ['active', 'captured', 'released', 'expired'] as const;
export type HoldState = (typeof HOLD_STATES)[number];
export type HoldEnd = Exclude<HoldState, 'active'>;
export interface HoldSnapshot {
  readonly state: HoldState;
  readonly captureKey: string | null;
  readonly releaseKey: string | null;
}
export type HoldRejection = 'not_active' | 'already_captured' | 'already_released';
export type HoldDecision =
  | { readonly kind: 'apply'; readonly to: HoldEnd }
  | { readonly kind: 'replay' }
  | { readonly kind: 'reject'; readonly reason: HoldRejection };
/** Capture decision. Upholds: a hold is captured at most once. */
export function decideCapture(hold: HoldSnapshot, key: string): HoldDecision {
  if (hold.state === 'active') return { kind: 'apply', to: 'captured' };
  if (hold.state === 'captured') {
    return hold.captureKey === key
      ? { kind: 'replay' }
      : { kind: 'reject', reason: 'already_captured' };
  }
  return { kind: 'reject', reason: 'not_active' };
}
/** Release decision. Upholds: a captured hold is never released, so funds are not reused. */
export function decideRelease(hold: HoldSnapshot, key: string): HoldDecision {
  if (hold.state === 'active') return { kind: 'apply', to: 'released' };
  if (hold.state === 'released') {
    return hold.releaseKey === key
      ? { kind: 'replay' }
      : { kind: 'reject', reason: 'already_released' };
  }
  return { kind: 'reject', reason: 'not_active' };
}
/** Expiry applies only to an active hold with an `expires_at` in the past. */
export function isDueForExpiry(
  hold: { readonly state: HoldState; readonly expiresAt: Date | null },
  now: Date
): boolean {
  return hold.state === 'active' && hold.expiresAt !== null && hold.expiresAt <= now;
}
