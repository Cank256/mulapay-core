/**
 * Payments as the merchant sees them (spec 6.1, 7.1): create, read, list, cancel and the
 * status timeline. Application service: it owns the use case and the transaction, and leaves
 * every status change to `PaymentLifecycleService`.
 *
 * A payment is created in `created` and stays there until a later phase submits it to a
 * provider. The create route never sets a terminal state (spec 6.1).
 *
 * Every read and write is scoped to the merchant and environment of the caller; a payment
 * of another merchant or environment is `NOT_FOUND`, never `FORBIDDEN`, so its existence is
 * not revealed.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AuditService } from '../../common/audit/audit.service';
import { markAuditNotApplicable } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type {
  IdempotencyContext,
  IdempotentResponse,
} from '../../common/idempotency/idempotency.types';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { CLOCK } from '../../common/tokens';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { toTimeline, type TimelineEntryView } from '../transactions/transaction.views';
import type { PaymentProvider } from './domain/payment-event';
import type { PaymentStatus } from './domain/payment-state-machine';
import { PaymentCreator } from './payment-creator';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { observePaymentEvent } from './payment-metrics';
import { toPaymentView, type PaymentView } from './payment.views';
import { PaymentsRepository, type PaymentDetail } from './payments.repository';

export interface CreatePaymentRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly channel: 'mobile_money' | 'card' | 'bank';
  readonly paymentMethod?: { readonly provider?: PaymentProvider; readonly msisdn?: string };
  readonly description?: string;
  readonly statementDescriptor?: string;
  readonly returnUrl?: string;
  readonly metadata?: Record<string, string>;
}

export interface PaymentListQuery {
  readonly status?: PaymentStatus;
  readonly currency?: string;
  readonly channel?: 'mobile_money' | 'card' | 'bank';
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

/** Event keys of the actions a merchant can take. One per payment, so a repeat is a duplicate. */
export const CANCEL_EVENT_KEY = 'api:cancel';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly creator: PaymentCreator,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly idempotency: IdempotencyService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Creates a payment, once per `Idempotency-Key`. The same key and body again returns the
   * first response; the same key with another body is `IDEMPOTENCY_KEY_REUSED`.
   */
  create(
    scope: MerchantScope,
    request: CreatePaymentRequest,
    idempotency: IdempotencyContext
  ): Promise<IdempotentResponse<PaymentView>> {
    return this.idempotency.run(scope, idempotency, async (tx) => {
      let detail: PaymentDetail;
      try {
        detail = await this.creator.create(tx, scope, {
          amountMinor: request.amountMinor,
          currency: request.currency,
          channel: request.channel,
          msisdn: request.paymentMethod?.msisdn,
          provider: request.paymentMethod?.provider,
          description: request.description,
          statementDescriptor: request.statementDescriptor,
          returnUrl: request.returnUrl,
          metadata: request.metadata,
          idempotencyKey: idempotency.key,
        });
      } catch (error) {
        // The key outlived its 24-hour record: the payment it made still holds it.
        if (isUniqueViolation(error, 'payments_idempotency_key_key')) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', { cause: error });
        }
        throw error;
      }
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
            after: {
              status: view.status,
              amountMinor: view.amountMinor,
              currency: view.currency,
              channel: view.channel,
              environment: view.environment,
            },
          });
        },
      };
    });
  }

  async get(scope: MerchantScope, ref: string): Promise<PaymentView> {
    const detail = await this.payments.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toPaymentView(detail);
  }

  async list(
    scope: MerchantScope,
    query: PaymentListQuery
  ): Promise<{ items: PaymentView[]; nextCursor: string | null }> {
    const window = resolveWindow(query, this.clock.now());
    const fingerprint = filterFingerprint({
      environment: scope.environment,
      status: query.status,
      currency: query.currency,
      channel: query.channel,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.payments.list({
      scope,
      ...window,
      status: query.status,
      currency: query.currency,
      channel: query.channel,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.payment.createdAt,
      id: row.payment.ref,
    }));
    return { items: page.items.map(toPaymentView), nextCursor: page.nextCursor };
  }

  /** The statuses the payment went through, oldest first. */
  async timeline(scope: MerchantScope, ref: string): Promise<TimelineEntryView[]> {
    const detail = await this.payments.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toTimeline(await this.transactions.listEvents(scope, detail.transaction.id));
  }

  /**
   * Cancels a payment that has not been submitted to a provider, or one awaiting customer
   * action (spec 6.1). Cancelling a payment that is already cancelled returns it unchanged.
   * A payment that is processing or in any other terminal state is `PAYMENT_INVALID_TRANSITION`:
   * once a provider operation is running only the provider can end it.
   *
   * Cancelling from `requires_action` is local until the gateway integration exists: it does
   * not tell the provider, so a customer who still approves is a late success that the
   * lifecycle refuses and reconciliation picks up.
   */
  async cancel(scope: MerchantScope, ref: string): Promise<PaymentView> {
    const found = await this.payments.findDetailByRef(scope, ref);
    if (!found) throw new AppError('NOT_FOUND');
    const now = this.clock.now();
    const { result, detail } = await this.unitOfWork.run(async (tx) => {
      const outcome = await this.lifecycle.apply(tx, found.payment.id, {
        eventKey: CANCEL_EVENT_KEY,
        source: 'api',
        occurredAt: now,
        signal: { kind: 'cancelled', failureCode: 'cancelled_by_merchant' },
      });
      if (outcome.result === 'rejected') {
        throw new AppError('PAYMENT_INVALID_TRANSITION', {
          messageParams: { from: outcome.status, to: 'cancelled' },
          details: { from: outcome.status, to: 'cancelled' },
        });
      }
      const current = await this.payments.findDetailById(found.payment.id, tx);
      if (!current) throw new AppError('NOT_FOUND');
      if (outcome.result !== 'applied') markAuditNotApplicable();
      else {
        await this.audit.record(tx, {
          action: 'payment.cancelled',
          resourceType: 'payment',
          resourceId: ref,
          merchantId: scope.merchantId,
          before: { status: outcome.from },
          after: { status: outcome.to },
        });
      }
      return { result: outcome, detail: current };
    });
    observePaymentEvent(result, 'api');
    return toPaymentView(detail);
  }
}
