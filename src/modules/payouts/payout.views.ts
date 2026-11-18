/**
 * View transformations for payouts: from DB rows to API response objects.
 */
import type { PayoutDetail } from './payouts.repository';

export interface PayoutView {
  readonly id: string;
  readonly ref: string;
  readonly transactionRef: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
  readonly amountMinor: string;
  readonly currency: string;
  readonly channel: string;
  readonly destination: unknown;
  readonly status: 'created' | 'pending_approval' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  readonly description: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPayoutView(detail: PayoutDetail): PayoutView {
  return {
    id: detail.payout.ref,
    ref: detail.payout.ref,
    transactionRef: detail.transaction.ref,
    merchantId: detail.payout.merchantId,
    environment: detail.payout.environment as 'test' | 'live',
    amountMinor: detail.payout.amountMinor.toString(),
    currency: detail.payout.currency,
    channel: detail.payout.channel,
    destination: detail.payout.destination,
    status: detail.payout.status as PayoutView['status'],
    description: detail.payout.description,
    metadata: detail.payout.metadata as Record<string, unknown>,
    createdAt: detail.payout.createdAt.toISOString(),
    updatedAt: detail.payout.updatedAt.toISOString(),
  };
}
