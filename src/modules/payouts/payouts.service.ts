/**
 * Payouts service: public API facade for payout operations.
 * Thin wrapper over creator and repository for consistency with payments/refunds pattern.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  IdempotentResponse,
  type IdempotencyContext,
} from '../../common/idempotency/idempotency.types';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { ROOT_LOGGER } from '../../common/tokens';
import { PayoutCreator, type NewPayoutInput } from './payout-creator';
import { PayoutGatewaySubmitter } from './payout-gateway-submitter.service';
import { toPayoutView, type PayoutView } from './payout.views';
import { PayoutsRepository, type PayoutDetail } from './payouts.repository';

export interface PayoutListQuery {
  readonly status?: string;
  readonly currency?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly creator: PayoutCreator,
    private readonly payouts: PayoutsRepository,
    private readonly submitter: PayoutGatewaySubmitter,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Creates a payout, once per `Idempotency-Key`. The same key and body again returns the
   * first response. A live payout that does not need approval is submitted to the gateway
   * after commit; `processing` is not a settled payout.
   */
  create(
    scope: MerchantScope,
    input: Omit<NewPayoutInput, 'idempotencyKey'>,
    idempotency: IdempotencyContext
  ): Promise<IdempotentResponse<PayoutView>> {
    return this.idempotency.run(scope, idempotency, async (tx) => {
      let detail: PayoutDetail;
      try {
        detail = await this.creator.create(tx, scope, {
          ...input,
          idempotencyKey: idempotency.key,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'payouts_merchant_idempotency_key_idx')) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', { cause: error });
        }
        throw error;
      }
      const view = toPayoutView(detail);
      return {
        statusCode: 201,
        body: view,
        finalize: async (inner) => {
          await this.audit.record(inner, {
            action: 'payout.created',
            resourceType: 'payout',
            resourceId: view.id,
            merchantId: scope.merchantId,
            after: {
              status: view.status,
              amountMinor: view.amountMinor,
              currency: view.currency,
              environment: view.environment,
            },
          });
          if (scope.environment === 'live' && detail.payout.status === 'created') {
            const partyId = (detail.payout.destination as { value?: string }).value;
            if (!partyId || !detail.transaction.gatewayExternalId) return;
            this.submitter
              .submit({
                payoutId: detail.payout.id,
                payoutRef: detail.payout.ref,
                gatewayExternalId: detail.transaction.gatewayExternalId,
                amountMinor: detail.payout.amountMinor,
                currency: detail.payout.currency,
                recipient: { partyIdType: 'MSISDN', partyId },
                merchantId: scope.merchantId,
                environment: 'live',
              })
              .catch((error) => {
                this.logger.error(
                  { payoutRef: detail.payout.ref, err: error },
                  'payout gateway submission failed; chase job will resolve'
                );
              });
          }
        },
      };
    });
  }

  /** Get a single payout by ref. */
  async get(scope: MerchantScope, ref: string): Promise<PayoutView> {
    const detail = await this.payouts.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toPayoutView(detail);
  }

  /** List payouts with filtering and pagination. */
  async list(
    scope: MerchantScope,
    query: PayoutListQuery
  ): Promise<{
    data: PayoutView[];
    pagination: { limit: number; cursor: string | null; hasMore: boolean };
  }> {
    const window = resolveWindow(query, new Date());
    const fingerprint = filterFingerprint({
      merchantId: scope.merchantId,
      environment: scope.environment,
      status: query.status,
      currency: query.currency,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.payouts.list({
      scope,
      from: window.from,
      to: window.to,
      status: query.status,
      currency: query.currency,
      after,
      limit: query.limit + 1,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.payout.createdAt,
      id: row.payout.ref,
    }));
    return {
      data: page.items.map((row) => toPayoutView(row)),
      pagination: {
        limit: query.limit,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    };
  }
}
