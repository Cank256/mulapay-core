/**
 * Payment links (spec 6.1, 7.1): a reusable page-less way to ask for money. A link holds the
 * terms (a fixed amount, or an open one the payer chooses), and every use creates a payment,
 * lazily, on first use.
 *
 * Invariants upheld:
 *
 *  - A use is taken atomically with the payment it pays for. `takeUse` increments
 *    `used_count` only while the link is active, unexpired and under `max_uses`, in one
 *    statement, and runs in the same transaction as the payment insert: two payers racing
 *    for the last use cannot both get it, and a payment that fails to create does not
 *    consume a use. A CHECK constraint repeats the limit.
 *  - A link's terms (amount, currency, slug) never change; to change them, create a link.
 *  - A use is not given back when its payment fails. The counter limits attempts made, not
 *    money collected (a decision to confirm, docs/ARCHITECTURE.md).
 *  - Links are deactivated, never deleted: payments refer to them.
 *
 * Redeeming has no HTTP route yet: the spec lists no unauthenticated hosted-checkout surface,
 * so how a payer reaches a link is a decision for the phase that builds it. The service is
 * complete and tested; `redeemBySlug` derives the merchant and environment from the link.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { MerchantStatus } from '../../common/auth/principal';
import type { Clock } from '../../common/clock/clock';
import { AuditService } from '../../common/audit/audit.service';
import { markAuditNotApplicable } from '../../common/context/request-context';
import { canonicalJson } from '../../common/idempotency/canonical-json';
import { randomAlphanumeric, sha256Hex } from '../../common/crypto/crypto';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type {
  IdempotencyContext,
  IdempotentResponse,
} from '../../common/idempotency/idempotency.types';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { CLOCK } from '../../common/tokens';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { linkUnavailableReason } from './domain/link-and-session';
import { assertMerchantMayTransact, assertPaymentAmount } from './domain/payment-input';
import { PaymentCreator } from './payment-creator';
import { PaymentLinksRepository } from './payment-links.repository';
import {
  toPaymentLinkView,
  toPaymentView,
  type PaymentLinkView,
  type PaymentView,
} from './payment.views';
import type { PaymentProvider } from './domain/payment-event';

export interface CreatePaymentLinkRequest {
  readonly title: string;
  readonly description?: string;
  /** Omit for an open-amount link: the payer chooses. */
  readonly amountMinor?: bigint;
  readonly currency: string;
  readonly maxUses?: number;
  readonly expiresAt?: Date;
  readonly successUrl?: string;
  readonly metadata?: Record<string, string>;
}

export interface UpdatePaymentLinkRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly maxUses?: number | null;
  readonly expiresAt?: Date | null;
  readonly successUrl?: string | null;
  readonly metadata?: Record<string, string>;
}

export interface PaymentLinkListQuery {
  readonly active?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

/** What a payer supplies on first use of a link. */
export interface RedeemLinkRequest {
  /** Required for an open-amount link; refused for a fixed-amount one. */
  readonly amountMinor?: bigint;
  readonly channel: 'mobile_money' | 'card' | 'bank';
  readonly msisdn?: string;
  readonly provider?: PaymentProvider;
}

const REDEEM_OPERATION = 'payment_links.redeem';

function invalid(reason: string): AppError {
  return new AppError('PAYMENT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

@Injectable()
export class PaymentLinksService {
  constructor(
    private readonly links: PaymentLinksRepository,
    private readonly merchants: MerchantsRepository,
    private readonly creator: PaymentCreator,
    private readonly idempotency: IdempotencyService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  create(
    scope: MerchantScope,
    request: CreatePaymentLinkRequest,
    idempotency: IdempotencyContext
  ): Promise<IdempotentResponse<PaymentLinkView>> {
    return this.idempotency.run(scope, idempotency, async (tx) => {
      assertMerchantMayTransact(scope);
      // An open-amount link has no amount to check; 1n only exercises the currency check.
      const currency = assertPaymentAmount(request.amountMinor ?? 1n, request.currency);
      const now = this.clock.now();
      if (request.expiresAt && request.expiresAt.getTime() <= now.getTime()) {
        throw invalid('expires_at_in_past');
      }
      const row = await this.links.insert(tx, {
        id: uuidv7(now),
        ref: publicId('paymentLink', now),
        merchantId: scope.merchantId,
        environment: scope.environment,
        amountMinor: request.amountMinor ?? null,
        currency,
        title: request.title,
        description: request.description ?? null,
        slug: randomAlphanumeric(12),
        maxUses: request.maxUses ?? null,
        expiresAt: request.expiresAt ?? null,
        successUrl: request.successUrl ?? null,
        metadata: request.metadata ?? {},
        createdAt: now,
      });
      const view = toPaymentLinkView(row);
      return {
        statusCode: 201,
        body: view,
        finalize: async (inner) => {
          await this.audit.record(inner, {
            action: 'payment_link.created',
            resourceType: 'payment_link',
            resourceId: view.id,
            merchantId: scope.merchantId,
            after: { currency: view.currency, amountMinor: view.amountMinor, active: view.active },
          });
        },
      };
    });
  }

  async get(scope: MerchantScope, ref: string): Promise<PaymentLinkView> {
    const row = await this.links.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    return toPaymentLinkView(row);
  }

  async list(
    scope: MerchantScope,
    query: PaymentLinkListQuery
  ): Promise<{ items: PaymentLinkView[]; nextCursor: string | null }> {
    const fingerprint = filterFingerprint({ environment: scope.environment, active: query.active });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.links.list({ scope, active: query.active, after, limit: query.limit });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.createdAt,
      id: row.ref,
    }));
    return { items: page.items.map(toPaymentLinkView), nextCursor: page.nextCursor };
  }

  /** Changes the descriptive fields and limits of a link. Its amount and currency are fixed. */
  async update(
    scope: MerchantScope,
    ref: string,
    request: UpdatePaymentLinkRequest
  ): Promise<PaymentLinkView> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.links.lockByRef(tx, scope, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (request.maxUses !== undefined && request.maxUses !== null) {
        if (request.maxUses < current.usedCount) throw invalid('max_uses_below_used_count');
      }
      if (request.expiresAt && request.expiresAt.getTime() <= this.clock.now().getTime()) {
        throw invalid('expires_at_in_past');
      }
      const row = await this.links.update(tx, current.id, { ...request });
      const view = toPaymentLinkView(row);
      await this.audit.record(tx, {
        action: 'payment_link.updated',
        resourceType: 'payment_link',
        resourceId: ref,
        merchantId: scope.merchantId,
        before: toPaymentLinkView(current),
        after: view,
      });
      return view;
    });
  }

  /** Stops a link taking new payments. Deactivating an inactive link returns it unchanged. */
  async deactivate(scope: MerchantScope, ref: string): Promise<PaymentLinkView> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.links.lockByRef(tx, scope, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (!current.active) {
        markAuditNotApplicable();
        return toPaymentLinkView(current);
      }
      const row = await this.links.update(tx, current.id, { active: false });
      await this.audit.record(tx, {
        action: 'payment_link.deactivated',
        resourceType: 'payment_link',
        resourceId: ref,
        merchantId: scope.merchantId,
        before: { active: true },
        after: { active: false },
      });
      return toPaymentLinkView(row);
    });
  }

  /**
   * First use of a link by a payer who holds only its slug (spec 6.1). Creates the payment,
   * once per `Idempotency-Key` the payer's page generated, and takes one use of the link in
   * the same transaction. The merchant and environment come from the link, never from the
   * request.
   */
  async redeemBySlug(
    slug: string,
    request: RedeemLinkRequest,
    key: string
  ): Promise<IdempotentResponse<PaymentView>> {
    const link = await this.links.findBySlug(slug);
    if (!link) throw new AppError('NOT_FOUND');
    const merchant = await this.merchants.findById(link.merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    const scope: MerchantScope = {
      merchantId: merchant.id,
      merchantRef: merchant.ref,
      merchantStatus: merchant.status as MerchantStatus,
      environment: link.environment as MerchantScope['environment'],
    };
    const context: IdempotencyContext = {
      operation: REDEEM_OPERATION,
      key,
      fingerprint: sha256Hex(
        canonicalJson({ slug, ...request, amountMinor: request.amountMinor?.toString() })
      ),
    };
    return this.idempotency.run(scope, context, async (tx) => {
      assertMerchantMayTransact(scope);
      const now = this.clock.now();
      const used = await this.links.takeUse(tx, scope, link.ref, now);
      if (!used) {
        const current = await this.links.findByRef(scope, link.ref, tx);
        const reason = current ? linkUnavailableReason(current, now) : null;
        throw new AppError('PAYMENT_LINK_UNAVAILABLE', {
          messageParams: { reason: reason ?? 'inactive' },
          details: { reason: reason ?? 'inactive' },
        });
      }
      if (used.amountMinor !== null && request.amountMinor !== undefined) {
        throw invalid('amount_is_fixed');
      }
      const amountMinor = used.amountMinor ?? request.amountMinor;
      if (amountMinor === undefined) throw invalid('amount_required');
      const detail = await this.creator.create(tx, scope, {
        amountMinor,
        currency: used.currency,
        channel: request.channel,
        msisdn: request.msisdn,
        provider: request.provider,
        description: used.title,
        returnUrl: used.successUrl ?? undefined,
        metadata: used.metadata,
        idempotencyKey: key,
        origin: { paymentLinkId: used.id },
      });
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
            after: { status: view.status, via: 'payment_link', link: link.ref },
          });
        },
      };
    });
  }
}
