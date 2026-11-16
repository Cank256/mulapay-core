/**
 * Outbound messaging behind one interface per channel (spec 4.4: `integrations/email`, `sms`,
 * `push`). The notification service never knows which vendor sends a message.
 *
 * Every send is one HTTP call with a hard timeout. The answer is a value that names what is
 * known, so a caller cannot mistake "the vendor did not answer" for "the message was refused":
 *
 *   sent         the vendor accepted the message; `providerMessageId` identifies it
 *   rejected     the vendor refused it for a reason that retrying will not change
 *                (an invalid address, an unregistered device); the delivery fails at once
 *   unavailable  a timeout, a 5xx, a 429, an authentication failure or a missing
 *                configuration; the delivery is retried with backoff
 *
 * `idempotencyKey` is the delivery ref. Vendors that support an idempotency header receive it,
 * so a retry after a lost response does not send twice.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const SMS_SENDER = Symbol('SMS_SENDER');
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface OutboundMessage {
  /** An email address, an E.164 number or a device token. */
  readonly to: string;
  readonly title: string | null;
  readonly body: string;
  readonly idempotencyKey: string;
}

export type SendResult =
  | { readonly kind: 'sent'; readonly provider: string; readonly providerMessageId: string | null }
  | { readonly kind: 'rejected'; readonly provider: string; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly provider: string; readonly reason: string };

export interface MessageSender {
  /** False when no vendor is configured for the channel; every send is then `unavailable`. */
  readonly configured: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
}
