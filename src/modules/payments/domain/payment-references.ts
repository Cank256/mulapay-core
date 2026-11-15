/**
 * Public references of the payment domain (spec section 5: a prefixed, unique `ref` per
 * table; raw UUIDs stay internal).
 *
 *   pay_  payment          txn_  transaction
 *   pl_   payment link     cs_   checkout session
 *
 * A reference is a prefix and a ULID whose 80 random bits make it unguessable. The payment
 * reference is also core's idempotency key at the gateway (spec 3.4: `pay_{paymentId}`), so
 * a retried collection always reuses the same `externalId`.
 */
import { isPublicId, publicId, uuidv7 } from '../../../common/ids/ids';

export interface NewPaymentIds {
  readonly paymentId: string;
  readonly paymentRef: string;
  readonly transactionId: string;
  readonly transactionRef: string;
}

/** Fresh ids for a payment and its transaction, time-ordered by `now`. */
export function newPaymentIds(now: Date): NewPaymentIds {
  return {
    paymentId: uuidv7(now),
    paymentRef: publicId('payment', now),
    transactionId: uuidv7(now),
    transactionRef: publicId('transaction', now),
  };
}

/**
 * The gateway `externalId` of a payment's collection. Deterministic and never suffixed with
 * an attempt counter: retrying the same payment must reuse the same key, and a new key would
 * be a second movement of money (spec 3.4).
 */
export function gatewayExternalIdFor(paymentRef: string): string {
  return paymentRef;
}

export const isPaymentRef = (value: string): boolean => isPublicId('payment', value);
export const isTransactionRef = (value: string): boolean => isPublicId('transaction', value);
export const isPaymentLinkRef = (value: string): boolean => isPublicId('paymentLink', value);
export const isCheckoutSessionRef = (value: string): boolean =>
  isPublicId('checkoutSession', value);
