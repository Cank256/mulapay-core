/**
 * Refund gateway submission: submits a refund to the Provider Gateway.
 *
 * A refund is a disbursement back to the original payer. The payer's MSISDN was stored
 * encrypted on the original payment (payments.paymentMethod.msisdnEnc); it is decrypted
 * here, used for the gateway call, and never logged.
 *
 * The gateway call uses `submitDisbursement` with the refund's own `gatewayExternalId` as
 * the external reference, so a retried submission cannot create a second disbursement.
 *
 * The correct environment (`test` or `live`) is always passed to the gateway — test refunds
 * never touch the live provider.
 *
 * Failure outcomes:
 *  - No MSISDN on the original payment → `failed` (missing_payment_method)
 *  - MSISDN decryption error → `failed` (msisdn_decryption_failed)
 *  - No routing rule → `failed` (no_route_available)
 *  - Gateway accepted → `processing`
 *  - Gateway rejected → `failed`
 *  - Gateway ambiguous / rate-limited → `processing` with `outcomeUnknown: true`
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../common/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { RoutingService } from '../operations/routing/routing.service';
import {
  GATEWAY_OPERATIONS,
  type GatewayOperationsPort,
} from '../../integrations/gateway/gateway-operations.port';
import type { PaymentProvider } from '../payments/domain/payment-event';
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
    private readonly routing: RoutingService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    private readonly lifecycle: RefundLifecycleService,
    private readonly refunds: RefundsRepository,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async submit(input: SubmitRefundInput): Promise<void> {
    // Retrieve the original payment's payer MSISDN from the refund detail.
    const detail = await this.refunds.findDetailById(input.refundId);
    if (!detail) {
      this.logger.error({ refundRef: input.refundRef }, 'refund not found during gateway submission');
      return;
    }

    const msisdnEnc = detail.payment.paymentMethod?.msisdnEnc ?? null;
    if (!msisdnEnc) {
      this.logger.error({ refundRef: input.refundRef }, 'missing MSISDN on original payment');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.refundId, {
          eventKey: 'validation:missing_msisdn',
          source: 'api',
          occurredAt: new Date(),
          signal: { kind: 'failed', failureCode: 'missing_payment_method' },
        })
      );
      return;
    }

    // Decrypt — the context mirrors how the payment gateway submitter encrypts it.
    let msisdn: string;
    try {
      msisdn = this.encryption.decrypt(
        msisdnEnc,
        `payments.msisdn:${detail.payment.ref}`
      );
    } catch (error) {
      this.logger.error({ refundRef: input.refundRef, error }, 'failed to decrypt payer MSISDN');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.refundId, {
          eventKey: 'decryption:failed',
          source: 'api',
          occurredAt: new Date(),
          signal: { kind: 'failed', failureCode: 'msisdn_decryption_failed' },
        })
      );
      return;
    }

    // Route to the same provider as the original payment where possible.
    let provider: PaymentProvider;
    try {
      const route = await this.routing.selectProvider({
        operation: 'refund',
        currency: input.currency as Parameters<RoutingService['selectProvider']>[0]['currency'],
        amountMinor: input.amountMinor,
        channel: 'mobile_money',
      });
      provider = route.provider;
      this.logger.info(
        { refundRef: input.refundRef, provider: route.provider, ruleRef: route.ruleRef },
        'routed refund to provider'
      );
    } catch (error) {
      this.logger.warn({ refundRef: input.refundRef, error }, 'no route available for refund');
      await this.unitOfWork.run((tx) =>
        this.lifecycle.apply(tx, input.refundId, {
          eventKey: 'routing:no_route',
          source: 'api',
          occurredAt: new Date(),
          signal: { kind: 'failed', failureCode: 'no_route_available' },
        })
      );
      return;
    }

    const result = await this.gateway.submitDisbursement({
      environment: input.environment,       // ← use the refund's own environment
      providerId: provider,
      externalId: input.gatewayExternalId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payee: { partyIdType: 'MSISDN', partyId: msisdn },
      metadata: {
        merchantId: input.merchantId,
        environment: 'live',               // gateway metadata always live (disbursements only run live)
        coreTransactionId: input.refundRef,
      },
    });

    await this.handleResult(input, provider, result);
  }

  private async handleResult(
    input: SubmitRefundInput,
    provider: PaymentProvider,
    result: Awaited<ReturnType<GatewayOperationsPort['submitDisbursement']>>
  ): Promise<void> {
    switch (result.kind) {
      case 'accepted':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:accepted:${result.referenceId}`,
            source: 'gateway_event',
            occurredAt: new Date(),
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
            occurredAt: new Date(),
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
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:ambiguous:${Date.now()}`,
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
          { refundRef: input.refundRef, provider, httpStatus: result.httpStatus },
          'refund submission ambiguous, will be chased'
        );
        break;

      case 'rate_limited':
        await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(tx, input.refundId, {
            eventKey: `gateway:rate_limited:${Date.now()}`,
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
