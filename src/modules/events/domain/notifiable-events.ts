/**
 * Merchant event types that also notify the merchant's people (spec 6.12: "notifications fan out
 * from events through templates"). The templates and audiences live in the notifications module
 * (`event-triggers.ts`), which a test keeps in step with this list. The events module only needs
 * to know whether to write the second outbox row.
 */
export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'dispute.created',
  'dispute.resolved',
  'kyc.approved',
  'kyc.rejected',
  'kyc.info_requested',
  'kyc.reverification_due',
  'merchant.suspended',
  'merchant.activated',
  'webhook_endpoint.auto_disabled',
  'settlement.paid',
]);

export const NOTIFICATION_EVENT_OUTBOX_TYPE = 'notification.merchant_event';
