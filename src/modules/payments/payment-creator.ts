/**
 * Creates a payment and its transaction. The one place that does, whether the request is a
 * direct `POST /v1/payments`, the first use of a payment link, or the first use of a
 * checkout session, so the rules below are not repeated per entry point (spec 6.1).
 *
 * Runs inside the caller's transaction. In order it checks the merchant's status and the
 * amount, then writes the transaction (`created`), the payment, and the first transaction
 * event. A deferred database trigger asserts at commit that the two rows agree.
 *
 * Nothing here talks to the gateway: the payment stays `created` until a later phase submits
 * it. The gateway `externalId` is already fixed (the payment ref), so a retried submission
 * can never become a second collection (spec 3.4).
 *
 * Not checked yet, because the data does not exist: merchant limits (`merchant_limits`),
 * AML pre-checks (Phase 7) and route availability (Phase 4). They must exist before payments
 * are submitted to a provider.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { TransactionsRepository } from '../transactions/transactions.repository';
import {
  assertMerchantMayTransact,
  assertPaymentAmount,
  msisdnLast4,
  normalizeMsisdn,
  paymentExpiry,
} from './domain/payment-input';
import type { PaymentProvider } from './domain/payment-event';
import { gatewayExternalIdFor, newPaymentIds } from './domain/payment-references';
import { PaymentsRepository, type PaymentDetail } from './payments.repository';

export interface NewPaymentInput {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly channel: 'mobile_money' | 'card' | 'bank';
  /** A phone number in international format; required for mobile money. */
  readonly msisdn?: string;
  /** A provider the merchant pins; honoured by routing if that route is enabled (spec 6.1). */
  readonly provider?: PaymentProvider;
  readonly description?: string;
  readonly statementDescriptor?: string;
  readonly returnUrl?: string;
  readonly metadata?: Record<string, string>;
  /** The caller's `Idempotency-Key`; stored on the payment and unique per merchant. */
  readonly idempotencyKey: string;
  /** At most one: the link or session this payment pays for. */
  readonly origin?: { readonly paymentLinkId?: string; readonly checkoutSessionId?: string };
}

function invalid(reason: string): AppError {
  return new AppError('PAYMENT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

@Injectable()
export class PaymentCreator {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly encryption: FieldEncryption,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'PAYMENT_EXPIRY_MINUTES'>
  ) {}

  /** Validated, stored form of the caller's payment method. */
  private paymentMethod(
    input: NewPaymentInput,
    paymentRef: string
  ): { provider?: string; msisdnEnc?: string; msisdnLast4?: string } {
    const method: { provider?: string; msisdnEnc?: string; msisdnLast4?: string } = {};
    if (input.provider) method.provider = input.provider;
    if (input.msisdn === undefined) {
      if (input.channel === 'mobile_money') throw invalid('msisdn_required');
      return method;
    }
    if (input.channel !== 'mobile_money') throw invalid('msisdn_only_for_mobile_money');
    const normalized = normalizeMsisdn(input.msisdn);
    if (!normalized) throw invalid('msisdn_invalid');
    method.msisdnEnc = this.encryption.encrypt(normalized, `payments.msisdn:${paymentRef}`);
    method.msisdnLast4 = msisdnLast4(normalized);
    return method;
  }

  async create(
    tx: Transaction,
    scope: MerchantScope,
    input: NewPaymentInput
  ): Promise<PaymentDetail> {
    assertMerchantMayTransact(scope);
    const currency = assertPaymentAmount(input.amountMinor, input.currency);
    const now = this.clock.now();
    const ids = newPaymentIds(now);
    const paymentMethod = this.paymentMethod(input, ids.paymentRef);

    const transaction = await this.transactions.insert(tx, {
      id: ids.transactionId,
      ref: ids.transactionRef,
      merchantId: scope.merchantId,
      environment: scope.environment,
      type: 'payment',
      status: 'created',
      amountMinor: input.amountMinor,
      feeMinor: 0n,
      netMinor: input.amountMinor,
      currency,
      channel: input.channel,
      gatewayExternalId: gatewayExternalIdFor(ids.paymentRef),
      metadata: input.metadata ?? {},
      createdAt: now,
    });
    await this.payments.insert(tx, {
      id: ids.paymentId,
      ref: ids.paymentRef,
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      amountMinor: input.amountMinor,
      currency,
      status: 'created',
      channel: input.channel,
      paymentMethod,
      description: input.description ?? null,
      statementDescriptor: input.statementDescriptor ?? null,
      returnUrl: input.returnUrl ?? null,
      paymentLinkId: input.origin?.paymentLinkId ?? null,
      checkoutSessionId: input.origin?.checkoutSessionId ?? null,
      idempotencyKey: input.idempotencyKey,
      expiresAt: paymentExpiry(now, this.config.PAYMENT_EXPIRY_MINUTES),
      metadata: input.metadata ?? {},
      createdAt: now,
    });
    await this.transactions.insertEvent(tx, {
      id: uuidv7(now),
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      eventKey: 'created',
      source: 'api',
      outcome: 'applied',
      fromStatus: null,
      toStatus: 'created',
      occurredAt: now,
    });
    const detail = await this.payments.findDetailById(ids.paymentId, tx);
    if (!detail) throw new Error('payment not found after insert');
    return detail;
  }
}
