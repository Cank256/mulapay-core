/**
 * Checkout sessions (spec 6.1, 7.1): a hosted-payment intent with an amount, an expiry and a
 * client secret. The payment is created lazily, on first use of the session.
 *
 * Invariants upheld:
 *
 *  - A session pays for at most one payment. Starting it twice, even under different
 *    idempotency keys, returns that one payment: the session row is locked, and
 *    `payment_id` is set once (also enforced by a unique constraint and a trigger).
 *  - A session ends once: `open` becomes `complete` (its payment succeeded) or `expired`
 *    (it lapsed, the merchant expired it, or its payment ended unsuccessfully). Both are
 *    final. `PaymentLifecycleService` moves the session in the same transaction as its
 *    payment's terminal status, so the two cannot disagree.
 *  - The client secret is stored only as a SHA-256 hash and shown once. It is never kept in
 *    an idempotency record.
 *  - A session whose payment is running at a provider (`requires_action` or `processing`)
 *    is not expired by time or by the merchant: only the provider's outcome may end it
 *    (spec 17.5). A session whose payment was never submitted (`created`) is expired, and
 *    that payment is cancelled (merchant) or expired (time).
 *
 * Lock order is session, payment, transaction, everywhere.
 *
 * Starting a payment has no HTTP route yet (see `PaymentLinksService`); `startPayment`
 * authenticates by client secret and derives the merchant and environment from the session.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { MerchantStatus } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { markAuditNotApplicable } from '../../common/context/request-context';
import { randomToken, safeEqual, sha256Hex } from '../../common/crypto/crypto';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { canonicalJson } from '../../common/idempotency/canonical-json';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type {
  IdempotencyContext,
  IdempotentResponse,
} from '../../common/idempotency/idempotency.types';
import { toLoggableError } from '../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { MerchantsRepository } from '../merchants/merchants.repository';
import {
  CHECKOUT_SESSION_DEFAULT_MINUTES,
  CHECKOUT_SESSION_MAX_MINUTES,
  sessionUnavailableReason,
  type CheckoutSessionStatus,
} from './domain/link-and-session';
import type { PaymentProvider } from './domain/payment-event';
import { assertMerchantMayTransact, assertPaymentAmount } from './domain/payment-input';
import {
  CheckoutSessionsRepository,
  type CheckoutSessionRow,
} from './checkout-sessions.repository';
import { PaymentCreator } from './payment-creator';
import { PaymentLifecycleService, type PaymentEventResult } from './payment-lifecycle.service';
import { observePaymentEvent } from './payment-metrics';
import { PaymentsRepository } from './payments.repository';
import {
  toCheckoutSessionView,
  toPaymentView,
  type CheckoutSessionView,
  type CreatedCheckoutSessionView,
  type PaymentView,
} from './payment.views';

export interface CreateCheckoutSessionRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description?: string;
  readonly successUrl?: string;
  readonly expiresInMinutes?: number;
  readonly metadata?: Record<string, string>;
}

/** What the payer supplies when the session starts its payment. */
export interface StartSessionPaymentRequest {
  readonly channel: 'mobile_money' | 'card' | 'bank';
  readonly msisdn?: string;
  readonly provider?: PaymentProvider;
}

const START_OPERATION = 'checkout_sessions.start';
const SECRET_SEPARATOR = '_secret_';

/** The session ref a client secret belongs to, or null if it is not shaped like one. */
export function sessionRefOfSecret(clientSecret: string): string | null {
  const index = clientSecret.indexOf(SECRET_SEPARATOR);
  return index > 0 ? clientSecret.slice(0, index) : null;
}

function unavailable(reason: string): AppError {
  return new AppError('CHECKOUT_SESSION_UNAVAILABLE', {
    messageParams: { reason },
    details: { reason },
  });
}

export interface ExpirySweepResult {
  readonly expired: number;
  readonly left: number;
  readonly failed: number;
}

@Injectable()
export class CheckoutSessionsService {
  constructor(
    private readonly sessions: CheckoutSessionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly creator: PaymentCreator,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly idempotency: IdempotencyService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  create(
    scope: MerchantScope,
    request: CreateCheckoutSessionRequest,
    idempotency: IdempotencyContext
  ): Promise<IdempotentResponse<CreatedCheckoutSessionView>> {
    return this.idempotency.run<CreatedCheckoutSessionView>(scope, idempotency, async (tx) => {
      assertMerchantMayTransact(scope);
      const currency = assertPaymentAmount(request.amountMinor, request.currency);
      const minutes = request.expiresInMinutes ?? CHECKOUT_SESSION_DEFAULT_MINUTES;
      if (minutes < 1 || minutes > CHECKOUT_SESSION_MAX_MINUTES) {
        throw new AppError('PAYMENT_REQUEST_INVALID', {
          messageParams: { reason: 'expires_in_out_of_range' },
          details: { reason: 'expires_in_out_of_range' },
        });
      }
      const now = this.clock.now();
      const ref = publicId('checkoutSession', now);
      const clientSecret = `${ref}${SECRET_SEPARATOR}${randomToken(24)}`;
      const row = await this.sessions.insert(tx, {
        id: uuidv7(now),
        ref,
        merchantId: scope.merchantId,
        environment: scope.environment,
        amountMinor: request.amountMinor,
        currency,
        description: request.description ?? null,
        successUrl: request.successUrl ?? null,
        metadata: request.metadata ?? {},
        expiresAt: new Date(now.getTime() + minutes * 60_000),
        clientSecretHash: sha256Hex(clientSecret),
        createdAt: now,
      });
      const view = toCheckoutSessionView({ session: row, paymentRef: null });
      return {
        statusCode: 201,
        body: { ...view, clientSecret },
        stored: { ...view, clientSecret: null },
        finalize: async (inner) => {
          await this.audit.record(inner, {
            action: 'checkout_session.created',
            resourceType: 'checkout_session',
            resourceId: ref,
            merchantId: scope.merchantId,
            after: { amountMinor: view.amountMinor, currency: view.currency },
          });
        },
      };
    });
  }

  async get(scope: MerchantScope, ref: string): Promise<CheckoutSessionView> {
    const found = await this.sessions.findByRef(scope, ref);
    if (!found) throw new AppError('NOT_FOUND');
    return toCheckoutSessionView(found);
  }

  /**
   * Starts the session's payment on first use (spec 6.1). The payer proves possession of the
   * client secret; an unknown session and a wrong secret are both `NOT_FOUND`.
   */
  async startPayment(
    clientSecret: string,
    request: StartSessionPaymentRequest,
    key: string
  ): Promise<IdempotentResponse<PaymentView>> {
    const ref = sessionRefOfSecret(clientSecret);
    const found = ref ? await this.sessions.findByRefUnscoped(ref) : undefined;
    if (!found || !safeEqual(sha256Hex(clientSecret), found.clientSecretHash)) {
      throw new AppError('NOT_FOUND');
    }
    const merchant = await this.merchants.findById(found.merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    const scope: MerchantScope = {
      merchantId: merchant.id,
      merchantRef: merchant.ref,
      merchantStatus: merchant.status as MerchantStatus,
      environment: found.environment as MerchantScope['environment'],
    };
    const context: IdempotencyContext = {
      operation: START_OPERATION,
      key,
      fingerprint: sha256Hex(canonicalJson({ session: found.ref, ...request })),
    };
    return this.idempotency.run(scope, context, async (tx) => {
      assertMerchantMayTransact(scope);
      const session = await this.sessions.lockById(tx, found.id);
      if (!session) throw new AppError('NOT_FOUND');
      if (session.paymentId) {
        // Already started, perhaps under another key: the session has one payment.
        const existing = await this.payments.findDetailById(session.paymentId, tx);
        if (!existing) throw new AppError('NOT_FOUND');
        return { statusCode: 200, body: toPaymentView(existing) };
      }
      const reason = sessionUnavailableReason(
        { status: session.status as CheckoutSessionStatus, expiresAt: session.expiresAt },
        this.clock.now()
      );
      if (reason) throw unavailable(reason);
      const detail = await this.creator.create(tx, scope, {
        amountMinor: session.amountMinor,
        currency: session.currency,
        channel: request.channel,
        msisdn: request.msisdn,
        provider: request.provider,
        description: session.description ?? undefined,
        returnUrl: session.successUrl ?? undefined,
        metadata: session.metadata,
        idempotencyKey: key,
        origin: { checkoutSessionId: session.id },
      });
      await this.sessions.attachPayment(tx, session.id, detail.payment.id);
      const view = toPaymentView(detail);
      return {
        statusCode: 201,
        body: view,
        finalize: async (inner) => {
          await this.audit.record(inner, {
            action: 'payment.created',
            resourceType: 'payment',
            resourceId: view.id,
            merchantId: scope.merchantId,
            after: { status: view.status, via: 'checkout_session', session: session.ref },
          });
        },
      };
    });
  }

  /**
   * Expires a session the merchant no longer wants paid. Expiring an expired session
   * returns it. A completed session, or one whose payment is running at a provider, is
   * `CHECKOUT_SESSION_UNAVAILABLE`.
   */
  async expire(scope: MerchantScope, ref: string): Promise<CheckoutSessionView> {
    const outcome = await this.unitOfWork.run(async (tx) => {
      const session = await this.sessions.lockByRef(tx, scope, ref);
      if (!session) throw new AppError('NOT_FOUND');
      if (session.status === 'expired') {
        markAuditNotApplicable();
        return { session, results: [] };
      }
      if (session.status === 'complete') throw unavailable('complete');
      const results = await this.endPayment(tx, session, 'merchant');
      if (results === 'in_progress') throw unavailable('payment_in_progress');
      const ended = await this.expireIfOpen(tx, session);
      await this.audit.record(tx, {
        action: 'checkout_session.expired',
        resourceType: 'checkout_session',
        resourceId: ref,
        merchantId: scope.merchantId,
        before: { status: 'open' },
        after: { status: 'expired' },
      });
      return { session: ended, results };
    });
    for (const result of outcome.results) observePaymentEvent(result, 'api');
    const found = await this.sessions.findByRef(scope, ref);
    if (!found) throw new AppError('NOT_FOUND');
    return toCheckoutSessionView(found);
  }

  /**
   * Expires open sessions past their `expires_at` (spec 6.1). Each session runs in its own
   * short transaction, so one failure does not hold up the rest or roll back the others, and
   * running the sweep twice expires each session once. A session whose payment is at a
   * provider is left open (`left`) for the gateway's outcome. Failures are logged and
   * counted; the next sweep retries them.
   */
  async expireDue(limit: number): Promise<ExpirySweepResult> {
    const due = await this.sessions.findDueForExpiry(this.clock.now(), limit);
    let expired = 0;
    let left = 0;
    let failed = 0;
    for (const candidate of due) {
      try {
        const outcome = await this.unitOfWork.run(async (tx) => {
          const session = await this.sessions.lockById(tx, candidate.id);
          if (
            !session ||
            session.status !== 'open' ||
            session.expiresAt.getTime() > this.clock.now().getTime()
          ) {
            return { state: 'skipped' as const, results: [] };
          }
          const results = await this.endPayment(tx, session, 'time');
          if (results === 'in_progress') return { state: 'left' as const, results: [] };
          await this.expireIfOpen(tx, session);
          return { state: 'expired' as const, results };
        });
        for (const result of outcome.results) observePaymentEvent(result, 'job');
        if (outcome.state === 'left') left += 1;
        else if (outcome.state === 'expired') expired += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          { err: toLoggableError(error), sessionRef: candidate.ref },
          'checkout session expiry failed'
        );
      }
    }
    return { expired, left, failed };
  }

  /**
   * Ends the payment of a session that is being expired, if it has one and it never reached
   * a provider. Returns `in_progress` when the payment is running at a provider.
   */
  private async endPayment(
    tx: Transaction,
    session: CheckoutSessionRow,
    by: 'merchant' | 'time'
  ): Promise<PaymentEventResult[] | 'in_progress'> {
    if (!session.paymentId) return [];
    const payment = await this.payments.findById(tx, session.paymentId);
    if (!payment) throw new AppError('NOT_FOUND');
    if (payment.status !== 'created') return 'in_progress' as const;
    const now = this.clock.now();
    const result = await this.lifecycle.apply(
      tx,
      payment.id,
      by === 'merchant'
        ? {
            eventKey: 'api:session_expire',
            source: 'api',
            occurredAt: now,
            signal: { kind: 'cancelled', failureCode: 'cancelled_by_merchant' },
          }
        : {
            eventKey: 'job:expiry',
            source: 'job',
            occurredAt: now,
            signal: { kind: 'expired', failureCode: 'payment_expired' },
          },
      { requireStatus: 'created' }
    );
    // The session lock keeps the payment still, so this is defensive: never expire a
    // session whose payment moved on.
    return result.result === 'skipped' ? 'in_progress' : [result];
  }

  /** Expires the session unless the payment's terminal transition already did. */
  private async expireIfOpen(
    tx: Transaction,
    session: CheckoutSessionRow
  ): Promise<CheckoutSessionRow> {
    const current = await this.sessions.lockById(tx, session.id);
    if (!current) throw new AppError('NOT_FOUND');
    if (current.status !== 'open') return current;
    return this.sessions.setStatus(tx, session.id, 'expired', this.clock.now());
  }
}
