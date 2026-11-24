/**
 * Refund gateway submission: posts to `POST /api/v1/payment/:providerId/refund`.
 *
 * The provider is the one that collected the original payment. `transactionId` is that
 * collection's provider transaction id. The refund ref is the gateway `externalId`, so a
 * retry cannot create a second refund. A provider that cannot refund, or a collection
 * that never received a provider transaction id, fails in Core and is not sent.
 *
 * Failure outcomes:
 *  - No provider transaction id → `failed` (`provider_transaction_missing`)
 *  - Provider cannot refund → `failed` (`refund_not_supported`)
 *  - Gateway accepted → `processing`
 *  - Gateway rejected → `failed`
 *  - Gateway ambiguous / rate-limited → `processing` with `outcomeUnknown: true`
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER, CLOCK } from '../../common/tokens';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { providerSupports } from '../../integrations/gateway/provider-capabilities';
import {
  GATEWAY_OPERATIONS,
  type GatewayOperationsPort,
} from '../../integrations/gateway/gateway-operations.port';
import { isPaymentProvider, type PaymentProvider } from '../payments/domain/payment-event';
import { RefundLifecycleService } from './refund-lifecycle.service';
import { RefundsRepository } from './refunds.repository';

export interface SubmitRefundInput {
  readonly refundId: string;
  readonly refundRef: string;
  readonly gatewayExternalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

@Injectable()
export class RefundGatewaySubmitter {
  constructor(
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: RefundLifecycleService,
    private readonly refunds: RefundsRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async submit(input: SubmitRefundInput): Promise<void> {
    // Retrieve the original payment's payer MSISDN from the refund detail.
    const detail = await this.refunds.findDetailById(input.refundId);
    if (!detail) {
      this.logger.error(
        { refundRef: input.refundRef },
        'refund not found during gateway submission'
      );
      return;
    }

    const collection = await this.refunds.findCollectionGateway(detail.payment.id);
    const providerId = collection?.provider ?? null;
    const transactionId = collection?.providerTransactionId ?? null;
    if (!transactionId) {
      await this.fail(input.refundId, 'provider_transaction_missing');
      return;
    }
    if (!providerId || !isPaymentProvider(providerId) || !providerSupports(providerId, 'refund')) {
      await this.fail(input.refundId, 'refund_not_supported');
      return;
    }

    const result = await this.gateway.submitRefund({
      environment: input.environment,
      providerId,
      externalId: input.gatewayExternalId,
      transactionId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...(detail.refund.reason ? { reason: detail.refund.reason } : {}),
      metadata: {
        merchantId: input.merchantId,
        environment: input.environment,
        coreTransactionId: input.refundRef,
      },
    });

    await this.handleResult(input, providerId, result);
  }

  private async fail(refundId: string, failureCode: string): Promise<void> {
    this.logger.warn({ refundId, failureCode }, 'refund not sent to gateway');
    await this.unitOfWork.run((tx) =>
      this.lifecycle.apply(tx, refundId, {
        eventKey: `validation:${failureCode}`,
        source: 'api',
        occurredAt: this.clock.now(),
        signal: { kind: 'failed', failureCode },
      })
    );
  }

  private async handleResult(
    input: SubmitRefundInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitRefund']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:accepted:${result.referenceId}`,
            source: 'gateway_event',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: false },
            identifiers: { provider, referenceId: result.referenceId },
          })
        );
        this.logger.info(
          { refundRef: input.refundRef, provider, referenceId: result.referenceId },
          'refund accepted by gateway'
        );
        break;

      case 'rejected':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:rejected:${result.reason}`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'failed', failureCode: `gateway_${result.reason}` },
            identifiers: { provider },
          })
        );
        this.logger.warn(
          { refundRef: input.refundRef, provider, reason: result.reason },
          'refund rejected by gateway'
        );
        break;

      case 'ambiguous':
        // Key is deterministic: one submission → one ambiguous event (retries reuse the key).
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:ambiguous:submit`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: true },
            identifiers: {
              provider,
              referenceId: result.referenceId ?? undefined,
            },
          })
        );
        this.logger.warn(
          { refundRef: input.refundRef, provider, httpStatus: result.httpStatus },
          'refund submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:rate_limited:submit`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: true },
            identifiers: { provider },
          })
        );
        this.logger.warn(
          { refundRef: input.refundRef, provider, retryAfter: result.retryAfterMs },
          'refund rate limited, will retry'
        );
        break;
    }
  }
}
