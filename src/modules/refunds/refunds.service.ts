/**
 * Refunds as the merchant sees them: create, read, list. Application service: it owns the
 * use case and the transaction.
 *
 * A refund is created in `created` and stays there until a later phase submits it to the
 * provider gateway. The create route never sets a terminal state.
 *
 * Every read and write is scoped to the merchant and environment of the caller; a refund
 * of another merchant or environment is `NOT_FOUND`, never `FORBIDDEN`, so its existence is
 * not revealed.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AuditService } from '../../common/audit/audit.service';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type {
  IdempotencyContext,
  IdempotentResponse,
} from '../../common/idempotency/idempotency.types';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { CLOCK } from '../../common/tokens';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { toTimeline, type TimelineEntryView } from '../transactions/transaction.views';
import type { RefundStatus } from './domain/refund-state-machine';
import { RefundCreator } from './refund-creator';
import { RefundLifecycleService } from './refund-lifecycle.service';
import { toRefundView, type RefundView } from './refund.views';
import { RefundsRepository, type RefundDetail } from './refunds.repository';

export interface CreateRefundRequest {
  readonly paymentId: string;
  readonly amountMinor: bigint;
  readonly reason?: string;
  readonly metadata?: Record<string, string>;
}

export interface RefundListQuery {
  readonly status?: RefundStatus;
  readonly currency?: string;
  readonly paymentRef?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly refunds: RefundsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly creator: RefundCreator,
    private readonly lifecycle: RefundLifecycleService,
    private readonly idempotency: IdempotencyService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Creates a refund, once per `Idempotency-Key`. The same key and body again returns the
   * first response; the same key with another body is `IDEMPOTENCY_KEY_REUSED`.
   */
  create(
    scope: MerchantScope,
    request: CreateRefundRequest,
    idempotency: IdempotencyContext
  ): Promise<IdempotentResponse<RefundView>> {
    return this.idempotency.run(scope, idempotency, async (tx) => {
      let detail: RefundDetail;
      try {
        detail = await this.creator.create(tx, scope, {
          paymentId: request.paymentId,
          amountMinor: request.amountMinor,
          reason: request.reason,
          metadata: request.metadata,
          idempotencyKey: idempotency.key,
        });
      } catch (error) {
        // The key outlived its 24-hour record: the refund it made still holds it.
        if (isUniqueViolation(error, 'refunds_merchant_idempotency_key_idx')) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', { cause: error });
        }
        throw error;
      }
      const view = toRefundView(detail);
      return {
        statusCode: 201,
        body: view,
        finalize: async (inner) => {
          await this.audit.record(inner, {
            action: 'refund.created',
            resourceType: 'refund',
            resourceId: view.id,
            merchantId: scope.merchantId,
            after: {
              status: view.status,
              paymentId: view.paymentId,
              amountMinor: view.amountMinor,
              currency: view.currency,
              environment: view.environment,
            },
          });

          // Submit refund to gateway after transaction commits (Phase 4)
          // This will be implemented in refund-gateway-submitter.service.ts
          // For now, refund stays in 'created' status until gateway integration is complete
        },
      };
    });
  }

  /** Retrieves a refund by its ref. */
  async get(scope: MerchantScope, ref: string): Promise<RefundView> {
    const detail = await this.refunds.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toRefundView(detail);
  }

  /** Lists refunds with optional filtering. */
  async list(
    scope: MerchantScope,
    query: RefundListQuery
  ): Promise<{
    data: RefundView[];
    pagination: { limit: number; cursor: string | null; hasMore: boolean };
  }> {
    const fingerprint = filterFingerprint({ scope, ...query });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const filter = {
      scope,
      from: query.from ?? new Date(0),
      to: query.to ?? new Date(),
      status: query.status,
      currency: query.currency,
      paymentRef: query.paymentRef,
      after,
      limit: query.limit + 1,
    };
    const rows = await this.refunds.list(filter);
    const page = toPage(rows, query.limit, fingerprint, (detail) => ({
      createdAt: detail.refund.createdAt,
      id: detail.refund.ref,
    }));
    return {
      data: page.items.map((detail) => toRefundView(detail)),
      pagination: {
        limit: query.limit,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    };
  }

  /** Retrieves the status timeline for a refund. */
  async timeline(scope: MerchantScope, ref: string): Promise<TimelineEntryView[]> {
    const detail = await this.refunds.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toTimeline(await this.transactions.listEvents(scope, detail.transaction.id));
  }
}
