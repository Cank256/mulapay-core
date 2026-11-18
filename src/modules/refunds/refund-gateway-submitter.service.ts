/**
 * Refund gateway submission: submits refunds to the gateway after creation.
 *
 * Similar to PaymentGatewaySubmitter but for refunds (reverse operations).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../common/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { RoutingService } from '../operations/routing/routing.service';
import {
  GATEWAY_OPERATIONS,
  type GatewayOperationsPort,
} from '../../integrations/gateway/gateway-operations.port';
import { RefundLifecycleService } from './refund-lifecycle.service';
import { RefundsRepository } from './refunds.repository';
import type { PaymentProvider } from '../payments/domain/payment-event';

export interface SubmitRefundInput {
  readonly refundId: string;
  readonly refundRef: string;
  readonly gatewayExternalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly originalPaymentGatewayId: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

@Injectable()
export class RefundGatewaySubmitter {
  constructor(
    private readonly routing: RoutingService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: RefundLifecycleService,
    private readonly refunds: RefundsRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Submit refund to gateway after creation. Refunds use the same provider as the original
   * payment and are submitted via the disbursement endpoint (reverse flow).
   */
  async submit(input: SubmitRefundInput): Promise<void> {
    // Route to the same provider as original payment
    let provider: PaymentProvider;
    try {
      const route = await this.routing.selectProvider({
        operation: 'refund',
        currency: input.currency as any,
        amountMinor: input.amountMinor,
        channel: 'mobile_money',
      });
      provider = route.provider;
      this.logger.info(
        {
          refundRef: input.refundRef,
          provider: route.provider,
          ruleRef: route.ruleRef,
        },
        'routed refund to provider'
      );
    } catch (error) {
      // No route available - mark refund as failed
      this.logger.warn({ refundRef: input.refundRef, error }, 'no route available for refund');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.refundId, {
          eventKey: 'routing:no_route',
          source: 'api',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'no_route_available',
            failureReason: 'No available provider for this refund',
          },
        })
      );
      return;
    }

    // Submit to gateway (refunds use disbursement endpoint as reverse flow)
    // TODO: Check if gateway has specific refund endpoint or uses disbursement
    const result = await this.gateway.submitDisbursement({
      environment: input.environment,
      providerId: provider,
      externalId: input.gatewayExternalId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payee: {
        partyIdType: 'MSISDN',
        partyId: '', // TODO: Get from original payment
      },
      metadata: {
        merchantId: input.merchantId,
        environment: 'live', // Force live even for test refunds
        coreTransactionId: input.refundRef,
      },
    });

    // Handle result
    await this.handleSubmissionResult(input, provider, result);
  }

  private async handleSubmissionResult(
    input: SubmitRefundInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitDisbursement']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: 'gateway:accepted',
            source: 'gateway_event',
            occurredAt: new Date(),
            signal: { kind: 'processing', outcomeUnknown: false },
            identifiers: {
              provider,
              referenceId: result.referenceId,
            },
          })
        );
        this.logger.info(
          {
            refundRef: input.refundRef,
            provider,
            referenceId: result.referenceId,
            duplicate: result.duplicate,
          },
          'refund accepted by gateway'
        );
        break;

      case 'rejected':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: 'gateway:rejected',
            source: 'api',
            occurredAt: new Date(),
            signal: {
              kind: 'failed',
              failureCode: `gateway_${result.reason}`,
              failureReason: `Gateway rejected: ${result.reason}`,
            },
            identifiers: { provider },
          })
        );
        this.logger.warn(
          { refundRef: input.refundRef, provider, reason: result.reason },
          'refund rejected by gateway'
        );
        break;

      case 'ambiguous':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: 'gateway:ambiguous',
            source: 'api',
            occurredAt: new Date(),
            signal: { kind: 'processing', outcomeUnknown: true },
            identifiers: {
              provider,
              referenceId: result.referenceId ?? undefined,
            },
          })
        );
        this.logger.warn(
          {
            refundRef: input.refundRef,
            provider,
            httpStatus: result.httpStatus,
          },
          'refund submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: 'gateway:rate_limited',
            source: 'api',
            occurredAt: new Date(),
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
