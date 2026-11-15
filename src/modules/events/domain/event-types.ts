/**
 * Merchant-visible event types (spec 6.11, "at minimum"), plus the types this platform adds.
 *
 * A type is listed when merchants can subscribe to it, whether or not the module that emits
 * it exists yet: the refund, payout, settlement, dispute and KYC events are emitted by the
 * phases that build those modules (docs/API_PUBLIC.md lists what emits today).
 */
export const MERCHANT_EVENT_TYPES = [
  'payment.created',
  'payment.requires_action',
  'payment.succeeded',
  'payment.failed',
  'payment.expired',
  'payment.cancelled',
  'refund.created',
  'refund.succeeded',
  'refund.failed',
  'payout.created',
  'payout.pending_approval',
  'payout.succeeded',
  'payout.failed',
  'balance.updated',
  'hold.created',
  'hold.released',
  'settlement.created',
  'settlement.paid',
  'dispute.created',
  'dispute.resolved',
  'kyc.approved',
  'kyc.rejected',
  'merchant.suspended',
  'merchant.activated',
  // Added by Phase 5: tells the merchant their endpoint stopped receiving events.
  'webhook_endpoint.auto_disabled',
] as const;

export type MerchantEventType = (typeof MERCHANT_EVENT_TYPES)[number];

export const ALL_EVENTS = '*';

export function isMerchantEventType(value: string): value is MerchantEventType {
  return (MERCHANT_EVENT_TYPES as readonly string[]).includes(value);
}

/** True when an endpoint subscribed to `enabled` receives events of `type`. */
export function subscribes(enabled: readonly string[], type: string): boolean {
  return enabled.includes(ALL_EVENTS) || enabled.includes(type);
}
