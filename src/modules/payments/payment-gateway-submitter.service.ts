/**
 * Payment gateway submission (P4-08): submits payments to the gateway after creation and
 * handles the result. Called outside the payment creation transaction so the gateway sees
 * a committed payment.
 *
 * Submission flow (spec 3.4, 3.7):
 *  1. Route to a provider
 *  2. Submit collection to gateway
 *  3. Handle result:
 *     - accepted: payment moves to processing, wait for events
 *     - rejected: payment moves to failed immediately
 *     - ambiguous: payment marked outcome_unknown, chase job will resolve
 *     - rate_limited: payment marked outcome_unknown, will retry later
 *
 * The payment was created with a `gatewayExternalId` that is stable across retries (spec 3.4),
 * so a duplicate submission is idempotent at the gateway.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../common/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import { RoutingService } from '../operations/routing/routing.service';
import {
  GATEWAY_OPERATIONS,
  type GatewayOperationsPort,
} from '../../integrations/gateway/gateway-operations.port';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentsRepository } from './payments.repository';
import type { PaymentProvider } from './domain/payment-event';

export interface SubmitPaymentInput {
  readonly paymentId: string;
  readonly paymentRef: string;
  readonly gatewayExternalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly msisdn?: string | null;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

@Injectable()
export class PaymentGatewaySubmitter {
  constructor(
    private readonly routing: RoutingService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly payments: PaymentsRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Submit payment to gateway after creation. Called outside the creation transaction.
   * Handles routing, submission, and updating payment status based on gateway response.
   */
  async submit(input: SubmitPaymentInput): Promise<void> {
    // Route to a provider
    let provider: PaymentProvider;
    try {
      const route = await this.routing.selectProvider({
        operation: 'collection',
        currency: input.currency as any, // TODO: type narrowing
        amountMinor: input.amountMinor,
        msisdn: input.msisdn ?? undefined,
        channel: 'mobile_money', // TODO: get from payment
      });
      provider = route.provider;
      this.logger.info(
        {
          paymentRef: input.paymentRef,
          provider: route.provider,
          ruleRef: route.ruleRef,
        },
        'routed payment to provider'
      );
    } catch (error) {
      // No route available - mark payment as failed
      this.logger.warn(
        { paymentRef: input.paymentRef, error },
        'no route available for payment'
      );
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.paymentId, {
          eventKey: 'routing:no_route',
          source: 'job',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'no_route_available',
            failureReason: 'No available provider for this payment',
          },
        })
      );
      return;
    }

    // Submit to gateway
    const result = await this.gateway.submitCollection({
      environment: input.environment,
      providerId: provider,
      externalId: input.gatewayExternalId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payer: {
        partyIdType: 'MSISDN',
        partyId: input.msisdn ?? '', // TODO: handle missing MSISDN
      },
      metadata: {
        merchantId: input.merchantId,
        environment: input.environment,
        coreTransactionId: input.paymentRef,
      },
    });

    // Handle result
    await this.handleSubmissionResult(input, provider, result);
  }

  private async handleSubmissionResult(
    input: SubmitPaymentInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitCollection']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        // Payment accepted, move to processing
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.paymentId, {
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
            paymentRef: input.paymentRef,
            provider,
            referenceId: result.referenceId,
            duplicate: result.duplicate,
          },
          'payment accepted by gateway'
        );
        break;

      case 'rejected':
        // Payment rejected before submission
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.paymentId, {
            eventKey: 'gateway:rejected',
            source: 'job',
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
          { paymentRef: input.paymentRef, provider, reason: result.reason },
          'payment rejected by gateway'
        );
        break;

      case 'ambiguous':
        // Outcome unknown - mark for chase job
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.paymentId, {
            eventKey: 'gateway:ambiguous',
            source: 'job',
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
            paymentRef: input.paymentRef,
            provider,
            httpStatus: result.httpStatus,
          },
          'payment submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        // Rate limited - mark for retry
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.paymentId, {
            eventKey: 'gateway:rate_limited',
            source: 'job',
            occurredAt: new Date(),
            signal: { kind: 'processing', outcomeUnknown: true },
            identifiers: { provider },
          })
        );
        this.logger.warn(
          { paymentRef: input.paymentRef, provider, retryAfter: result.retryAfterMs },
          'payment rate limited, will retry'
        );
        break;
    }
  }
}
