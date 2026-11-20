/**
 * Payout gateway submission: submits payouts to the gateway after creation.
 *
 * Similar to RefundGatewaySubmitter but for disbursements to recipients.
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
import type { Clock } from '../../common/clock/clock';
import { CLOCK } from '../../common/tokens';
import type { CurrencyCode } from '../../common/money/currency-codes';

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
  readonly environment: 'live';
}

@Injectable()
export class PayoutGatewaySubmitter {
  constructor(
    private readonly routing: RoutingService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly payouts: PayoutsRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
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
        operation: 'disbursement',
        currency: input.currency as CurrencyCode,
        amountMinor: input.amountMinor,
        channel: 'mobile_money',
      });
      provider = route.provider;
      this.logger.info(
        { payoutRef: input.payoutRef, provider: route.provider, ruleRef: route.ruleRef },
        'routed payout to provider'
      );
    } catch (error) {
      this.logger.warn({ payoutRef: input.payoutRef, error }, 'no route available for payout');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.payoutId, {
          eventKey: 'routing:no_route',
          source: 'api',
          occurredAt: this.clock.now(),
          signal: { kind: 'failed', code: 'no_route_available' },
        })
      );
      return;
    }

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

    await this.handleResult(input, provider, result);
  }

  private async handleResult(
    input: SubmitPayoutInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitDisbursement']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
            eventKey: `gateway:accepted:${result.referenceId}`,
            source: 'gateway',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: false },
            gatewayDetails: { provider, referenceId: result.referenceId },
          })
        );
        this.logger.info(
          { payoutRef: input.payoutRef, provider, referenceId: result.referenceId },
          'payout accepted by gateway'
        );
        break;

      case 'rejected':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
            eventKey: `gateway:rejected:${result.reason}`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'failed', code: `gateway_${result.reason}` },
            gatewayDetails: { provider },
          })
        );
        this.logger.warn(
          { payoutRef: input.payoutRef, provider, reason: result.reason },
          'payout rejected by gateway'
        );
        break;

      case 'ambiguous':
        // Key is deterministic: one submission → one ambiguous event (retries reuse the key).
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
            eventKey: `gateway:ambiguous:submit`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: true },
            gatewayDetails: {
              provider,
              referenceId: result.referenceId ?? undefined,
            },
          })
        );
        this.logger.warn(
          { payoutRef: input.payoutRef, provider, httpStatus: result.httpStatus },
          'payout submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.payoutId, {
            eventKey: `gateway:rate_limited:submit`,
            source: 'api',
            occurredAt: this.clock.now(),
            signal: { kind: 'processing', outcomeUnknown: true },
            gatewayDetails: { provider },
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
