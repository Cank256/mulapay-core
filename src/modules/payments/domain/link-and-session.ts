/**
 * Rules for payment links and checkout sessions (spec 6.1: payment links and checkout
 * sessions create payments lazily, on first use; a link with `max_uses` reached or past
 * `expires_at` is rejected). Pure.
 */
export type LinkUnavailableReason = 'inactive' | 'expired' | 'max_uses_reached';

export interface LinkAvailabilityInput {
  readonly active: boolean;
  readonly expiresAt: Date | null;
  readonly maxUses: number | null;
  readonly usedCount: number;
}

/** Why a link cannot take another payment, or null when it can. */
export function linkUnavailableReason(
  link: LinkAvailabilityInput,
  now: Date
): LinkUnavailableReason | null {
  if (!link.active) return 'inactive';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (link.maxUses !== null && link.usedCount >= link.maxUses) return 'max_uses_reached';
  return null;
}

export const CHECKOUT_SESSION_STATUSES = ['open', 'complete', 'expired'] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

/** A session ends once, as `complete` (its payment succeeded) or `expired`. */
export function canTransitionSession(from: CheckoutSessionStatus, to: CheckoutSessionStatus) {
  return from === 'open' && (to === 'complete' || to === 'expired');
}

/** Default lifetime of a checkout session and the longest a merchant may ask for. */
export const CHECKOUT_SESSION_DEFAULT_MINUTES = 24 * 60;
export const CHECKOUT_SESSION_MAX_MINUTES = 7 * 24 * 60;

/** Why a session cannot start a payment, or null when it can. */
export function sessionUnavailableReason(
  session: { status: CheckoutSessionStatus; expiresAt: Date },
  now: Date
): 'expired' | 'complete' | null {
  if (session.status === 'complete') return 'complete';
  if (session.status === 'expired') return 'expired';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}
