/**
 * View transformations for refunds: from DB rows to API response objects.
 */
import type { RefundDetail } from './refunds.repository';

export interface RefundView {
  readonly id: string;
  readonly ref: string;
  readonly transactionRef: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
  readonly paymentId: string;
  readonly paymentRef: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status:
    | 'created'
    | 'pending_approval'
    | 'processing'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly reason: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toRefundView(detail: RefundDetail): RefundView {
  return {
    id: detail.refund.ref,
    ref: detail.refund.ref,
    transactionRef: detail.transaction.ref,
    merchantId: detail.refund.merchantId,
    environment: detail.refund.environment as 'test' | 'live',
    paymentId: detail.payment.ref,
    paymentRef: detail.payment.ref,
    amountMinor: detail.refund.amountMinor.toString(),
    currency: detail.refund.currency,
    status: detail.refund.status as RefundView['status'],
    reason: detail.refund.reason,
    metadata: detail.refund.metadata as Record<string, unknown>,
    createdAt: detail.refund.createdAt.toISOString(),
    updatedAt: detail.refund.updatedAt.toISOString(),
  };
}
