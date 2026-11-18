/**
 * Payout reference generation: public refs and UUIDs.
 *
 * Payouts use `pyt_{ulid}` format (already enforced by DB constraint).
 * Transactions use `txn_{ulid}` format.
 */
import { publicId, uuidv7 } from '../../../common/ids/ids';

export interface PayoutIds {
  readonly payoutId: string;
  readonly payoutRef: string;
  readonly transactionId: string;
  readonly transactionRef: string;
}

/**
 * Generate a new set of IDs for a payout and its transaction.
 * Uses the same timestamp for both to keep them adjacent in the partition.
 */
export function newPayoutIds(now: Date): PayoutIds {
  const payoutId = uuidv7(now);
  const transactionId = uuidv7(now);
  return {
    payoutId,
    payoutRef: `pyt_${publicId()}`,
    transactionId,
    transactionRef: `txn_${publicId()}`,
  };
}

/**
 * Gateway externalId for a payout: the payout ref itself.
 * This ensures idempotency: retrying a payout uses the same external ID.
 */
export function gatewayExternalIdFor(payoutRef: string): string {
  return payoutRef;
}
