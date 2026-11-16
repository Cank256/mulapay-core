/**
 * Which merchant events notify whom, and with which template (spec 6.12). The audience is the
 * merchant's active members whose role holds `permission`, so a viewer is not told about a
 * suspension and a developer is told about a broken webhook.
 */
import { NOTIFIABLE_EVENT_TYPES } from '../../events/domain/notifiable-events';

export interface EventForNotification {
  readonly type: string;
  readonly resourceId: string;
  readonly object: Readonly<Record<string, unknown>>;
}

export interface EventTrigger {
  readonly template: string;
  readonly permission: string;
  variables(event: EventForNotification): Record<string, string>;
}

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

const none = () => ({});

export const EVENT_TRIGGERS: Readonly<Record<string, EventTrigger>> = {
  'dispute.created': {
    template: 'dispute.created',
    permission: 'disputes:read',
    variables: (e) => ({
      dispute_ref: e.resourceId,
      amount_minor: text(e.object.amountMinor, '0'),
      currency: text(e.object.currency),
      evidence_due: text(e.object.evidenceDueAt, 'not set'),
    }),
  },
  'dispute.resolved': {
    template: 'dispute.resolved',
    permission: 'disputes:read',
    variables: (e) => ({ dispute_ref: e.resourceId, outcome: text(e.object.outcome, 'resolved') }),
  },
  'kyc.approved': { template: 'kyc.approved', permission: 'kyc:submit', variables: none },
  'kyc.rejected': { template: 'kyc.rejected', permission: 'kyc:submit', variables: none },
  'kyc.info_requested': {
    template: 'kyc.info_requested',
    permission: 'kyc:submit',
    variables: none,
  },
  'kyc.reverification_due': {
    template: 'kyc.reverification_due',
    permission: 'kyc:submit',
    variables: none,
  },
  'merchant.suspended': {
    template: 'merchant.suspended',
    permission: 'merchant:update',
    variables: none,
  },
  'merchant.activated': {
    template: 'merchant.activated',
    permission: 'merchant:update',
    variables: none,
  },
  'webhook_endpoint.auto_disabled': {
    template: 'webhook_endpoint.auto_disabled',
    permission: 'webhooks:manage',
    variables: (e) => ({ endpoint_ref: e.resourceId }),
  },
  'settlement.paid': {
    template: 'settlement.paid',
    permission: 'settlements:read',
    variables: (e) => ({ settlement_ref: e.resourceId }),
  },
};

/** The events module's list and this map must name the same event types. */
export function triggersMatchNotifiableEvents(): boolean {
  const mapped = Object.keys(EVENT_TRIGGERS).sort();
  const listed = [...NOTIFIABLE_EVENT_TYPES].sort();
  return mapped.length === listed.length && mapped.every((t, i) => t === listed[i]);
}
