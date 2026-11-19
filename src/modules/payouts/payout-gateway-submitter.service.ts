/**
 * Payout gateway submission: submits payouts to the gateway after creation.
 *
 * Similar to RefundGatewaySubmitter but for payouts (disbursements to recipients).
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
import { PayoutLifecycleService } from './payout-lifecycle.service';
import { PayoutsRepository } from './payouts.repository';
import type { PaymentProvider } from '../payments/domain/payment-event';

export interface SubmitPayoutInput {
  readonly payoutId: string;
  readonly payoutRef: string;
  readonly gatewayExternalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly recipient: {
    partyIdType: 'MSISDN' | 'EMAIL';
    partyId: string;
  };
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

@Injectable()
export class PayoutGatewaySubmitter {
  constructor(
    private readonly routing: RoutingService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly payouts: PayoutsRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Submit payout to gateway after creation. Routes to appropriate provider
   * and submits via disbursement endpoint.
   */
  async submit(input: SubmitPayoutInput): Promise<void> {
    // Route to provider
    let provider: PaymentProvider;
    try {
      const route = await this.routing.selectProvider({
        operation: 'payout',
        currency: input.currency as any,
        amountMinor: input.amountMinor,
        channel: 'mobile_money',
      });
      provider = route.provider;
      this.logger.info(
        {
          payoutRef: input.payoutRef,
          provider: route.provider,
          ruleRef: route.ruleRef,
        },
        'routed payout to provider'
      );
    } catch (error) {
      // No route available - mark payout as failed
      this.logger.warn({ payoutRef: input.payoutRef, error }, 'no route available for payout');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.payoutId, {
          eventKey: 'routing:no_route',
          source: 'api',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'no_route_available',
            failureReason: 'No available provider for this payout',
          },
        })
      );
      return;
    }

    // Submit to gateway
    const result = await this.gateway.submitDisbursement({
      environment: input.environment,
      providerId: provider,
      externalId: input.gatewayExternalId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payee: input.recipient,
      metadata: {
        merchantId: input.merchantId,
        environment: input.environment,
        coreTransactionId: input.payoutRef,
      },
    });

    // Handle result
    await this.handleSubmissionResult(input, provider, result);
  }

  private async handleSubmissionResult(
    input: SubmitPayoutInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitDisbursement']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
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
            payoutRef: input.payoutRef,
            provider,
            referenceId: result.referenceId,
            duplicate: result.duplicate,
          },
          'payout accepted by gateway'
        );
        break;

      case 'rejected':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
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
          { payoutRef: input.payoutRef, provider, reason: result.reason },
          'payout rejected by gateway'
        );
        break;

      case 'ambiguous':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
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
            payoutRef: input.payoutRef,
            provider,
            httpStatus: result.httpStatus,
          },
          'payout submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
            eventKey: 'gateway:rate_limited',
            source: 'api',
            occurredAt: new Date(),
            signal: { kind: 'processing', outcomeUnknown: true },
            identifiers: { provider },
          })
        );
        this.logger.warn(
          { payoutRef: input.payoutRef, provider, retryAfter: result.retryAfterMs },
          'payout rate limited, will retry'
        );
        break;
    }
  }
}
