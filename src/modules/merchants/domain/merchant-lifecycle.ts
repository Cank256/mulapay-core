/**
 * Merchant lifecycle (spec section 6.10):
 *
 *   draft -> pending_kyc -> active -> suspended -> closed
 *
 * Transitions are admin-driven except `draft -> pending_kyc` (the merchant submits KYC)
 * and `pending_kyc -> active` (automatic on KYC approval). Both of those arrive with KYC
 * in Phase 7; they are defined here so the state machine is complete and tested.
 *
 * Decisions where the spec is silent (docs/ARCHITECTURE.md lists them):
 * - `suspended -> active` is the admin "activate" action (reinstatement).
 * - `closed` is reachable from `suspended`, and from `draft` and `pending_kyc` for
 *   onboarding that never completed. An `active` merchant is suspended first, so new
 *   traffic stops before the account closes.
 * - `closed` is terminal.
 *
 * Pure: no I/O, so every transition, legal and illegal, is unit-tested.
 */
import type { MerchantStatus } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';

export const MERCHANT_STATUSES = [
  'draft',
  'pending_kyc',
  'active',
  'suspended',
  'closed',
] as const satisfies readonly MerchantStatus[];

export type MerchantEvent = 'submit_kyc' | 'approve_kyc' | 'suspend' | 'activate' | 'close';
export type TransitionActor = 'merchant' | 'admin' | 'system';

interface TransitionRule {
  readonly from: readonly MerchantStatus[];
  readonly to: MerchantStatus;
  readonly actor: TransitionActor;
}

export const MERCHANT_TRANSITIONS: Readonly<Record<MerchantEvent, TransitionRule>> = {
  submit_kyc: { from: ['draft'], to: 'pending_kyc', actor: 'merchant' },
  approve_kyc: { from: ['pending_kyc'], to: 'active', actor: 'system' },
  suspend: { from: ['active'], to: 'suspended', actor: 'admin' },
  activate: { from: ['suspended'], to: 'active', actor: 'admin' },
  close: { from: ['draft', 'pending_kyc', 'suspended'], to: 'closed', actor: 'admin' },
};

/**
 * Returns the target status of `event` from `from` when `actor` may perform it.
 * Throws MERCHANT_INVALID_TRANSITION otherwise; nothing is changed by a refused event.
 */
export function nextMerchantStatus(
  from: MerchantStatus,
  event: MerchantEvent,
  actor: TransitionActor
): MerchantStatus {
  const rule = MERCHANT_TRANSITIONS[event];
  if (rule.actor !== actor || !rule.from.includes(from)) {
    throw new AppError('MERCHANT_INVALID_TRANSITION', {
      messageParams: { from, to: rule.to },
      details: { from, to: rule.to, event },
    });
  }
  return rule.to;
}

/** A closed merchant keeps read access only (spec 6.10). */
export function merchantAllowsWrites(status: MerchantStatus): boolean {
  return status !== 'closed';
}

/** Live API keys need an active merchant; KYC level 0 is test-only (spec 6.13). */
export function merchantAllowsLiveKeys(status: MerchantStatus): boolean {
  return status === 'active';
}
