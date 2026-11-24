/**
 * Creates a refund and its transaction. The one place that does, so the rules below are not
 * repeated per entry point.
 *
 * Runs inside the caller's transaction. In order it:
 *  1. Validates the original payment exists and is succeeded
 *  2. Checks refund eligibility (not already fully refunded, within time window if any)
 *  3. Calculates refundable amount (original amount - existing successful refunds)
 *  4. Validates requested amount doesn't exceed refundable amount
 *  5. Writes the transaction (`created`), the refund, and the first transaction event
 *
 * A deferred database trigger asserts at commit that the two rows agree.
 *
 * Nothing here talks to the gateway: the refund stays `created` until a later phase submits
 * it. The gateway `externalId` is already fixed (the refund ref), so a retried submission
 * can never become a second refund (spec 3.4).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { uuidv7, publicId } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { PaymentsRepository } from '../payments/payments.repository';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { RefundsRepository, type RefundDetail } from './refunds.repository';

export interface NewRefundInput {
  readonly paymentId: string; // Payment ref (external)
  readonly amountMinor: bigint;
  readonly reason?: string;
  readonly metadata?: Record<string, string>;
  /** The caller's `Idempotency-Key`; stored on the refund and unique per merchant. */
  readonly idempotencyKey: string;
}

function invalid(reason: string): AppError {
  return new AppError('REFUND_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

function notFound(): AppError {
  return new AppError('NOT_FOUND');
}

/**
 * Generates a new refund ref and its gateway external ID using proper ULID-based public IDs.
 */
function newRefundIds(now: Date): { ref: string; gatewayExternalId: string } {
  const ref = publicId('refund', now);
  const gatewayExternalId = ref;
  return { ref, gatewayExternalId };
}

@Injectable()
export class RefundCreator {
  constructor(
    private readonly refunds: RefundsRepository,
    private readonly payments: PaymentsRepository,
    private readonly transactions: TransactionsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async create(tx: Transaction, scope: MerchantScope, input: NewRefundInput): Promise<RefundDetail> {
    // Validate amount
    if (input.amountMinor <= 0n) throw invalid('amount_must_be_positive');
    if (input.reason && input.reason.length > 500) throw invalid('reason_too_long');

    // Find the original payment
    const paymentDetail = await this.payments.findDetailByRef(scope, input.paymentId, tx);
    if (!paymentDetail) throw notFound();

    const payment = paymentDetail.payment;
    const paymentTransaction = paymentDetail.transaction;

    // Validate payment is succeeded
    if (payment.status !== 'succeeded') {
      throw invalid('payment_not_succeeded');
    }

    // Check currency matches
    if (payment.currency !== paymentTransaction.currency) {
      throw new AppError('INTERNAL_ERROR', {
        cause: new Error('payment currency mismatch'),
      });
    }

    // Calculate total already refunded (succeeded refunds only)
    const totalRefunded = await this.refunds.totalSucceededRefundsForPayment(payment.id, tx);

    // Calculate refundable amount
    const refundableAmount = payment.amountMinor - totalRefunded;

    if (refundableAmount <= 0n) {
      throw invalid('payment_fully_refunded');
    }

    // Validate requested amount doesn't exceed refundable amount
    if (input.amountMinor > refundableAmount) {
      throw invalid('amount_exceeds_refundable');
    }

    // Check if there are active (non-terminal) refunds in progress
    const hasActive = await this.refunds.hasActiveRefunds(payment.id, tx);
    if (hasActive) {
      throw invalid('refund_already_in_progress');
    }

    // Generate IDs
    const now = this.clock.now();
    const refundId = uuidv7(now);
    const transactionId = uuidv7(now);
    const { ref: refundRef, gatewayExternalId } = newRefundIds(now);
    const transactionRef = `txn_${transactionId}`;

    // Create transaction
    const transaction = await this.transactions.insert(tx, {
      id: transactionId,
      ref: transactionRef,
      type: 'refund',
      merchantId: scope.merchantId,
      environment: scope.environment,
      amountMinor: input.amountMinor,
      netMinor: input.amountMinor, // Refunds net same as gross (fees already paid on payment)
      feeMinor: 0n, // No fees on refunds
      currency: payment.currency,
      status: 'created',
      provider: paymentTransaction.provider, // Inherit from payment
      channel: payment.channel,
      gatewayExternalId,
      gatewayOperationId: null,
      gatewayReferenceId: null,
      providerTransactionId: null,
      outcomeUnknown: false,
      failureCode: null,
      failureReason: null,
      completedAt: null,
      createdAt: now,
    });

    // Create refund
    const refund = await this.refunds.insert(tx, {
      id: refundId,
      ref: refundRef,
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      paymentId: payment.id,
      amountMinor: input.amountMinor,
      currency: payment.currency,
      status: 'created',
      reason: input.reason ?? null,
      holdRef: null,
      approvalRef: null,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });

    // Record the first transaction event
    await this.transactions.insertEvent(tx, {
      id: uuidv7(now),
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      eventKey: `created:${refundRef}`,
      source: 'api',
      outcome: 'applied',
      fromStatus: 'created',
      toStatus: 'created',
      rejectionReason: null,
      outcomeUnknown: false,
      failureCode: null,
      occurredAt: now,
    });

    // Return the full detail
    return {
      refund,
      transaction,
      payment,
      paymentLinkRef: paymentDetail.paymentLinkRef,
      checkoutSessionRef: paymentDetail.checkoutSessionRef,
    };
  }
}
