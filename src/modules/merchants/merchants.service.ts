/**
 * Merchant profile and lifecycle use cases (spec 6.10). Every change and its audit row
 * commit in one transaction; lifecycle changes lock the merchant row first so two
 * concurrent transitions apply one after the other against the current status.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantStatus } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import { ApiKeyCache } from '../../common/auth/api-key-cache';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import {
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../common/pagination/cursor';
import { toLoggableError } from '../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { Logger } from 'pino';
import { AccountsService } from '../accounts/accounts.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { nextMerchantStatus, type MerchantEvent } from './domain/merchant-lifecycle';
import { InvitationsService } from './invitations.service';
import { MERCHANT_BALANCE_CHECK, type MerchantBalanceCheck } from './merchant-balance.check';
import {
  merchantAuditSnapshot,
  toMerchantView,
  type CreatedInvitationView,
  type MerchantView,
} from './merchant.views';
import { MerchantsRepository, type MerchantPatch, type MerchantRow } from './merchants.repository';

export interface CreateMerchantInput {
  readonly legalName: string;
  readonly tradingName?: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly mcc?: string;
  readonly website?: string;
  readonly supportEmail?: string;
  readonly metadata?: Record<string, string>;
  /** When set, an owner invitation is created for this email. */
  readonly ownerEmail?: string;
}

export interface Actor {
  /** Internal user id of the person acting. */
  readonly userId: string;
}

@Injectable()
export class MerchantsService {
  constructor(
    private readonly merchants: MerchantsRepository,
    private readonly invitations: InvitationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly events: MerchantEventsService,
    private readonly keyCache: ApiKeyCache,
    @Inject(MERCHANT_BALANCE_CHECK) private readonly balances: MerchantBalanceCheck,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Admin creates a merchant in `draft`, optionally inviting its owner. */
  async create(
    input: CreateMerchantInput,
    actor: Actor
  ): Promise<{ merchant: MerchantView; ownerInvitation: CreatedInvitationView | null }> {
    return this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      const row = await this.merchants.insert(tx, {
        id: uuidv7(now),
        ref: publicId('merchant', now),
        legalName: input.legalName,
        tradingName: input.tradingName ?? null,
        country: input.country,
        defaultCurrency: input.defaultCurrency,
        status: 'draft',
        mcc: input.mcc ?? null,
        website: input.website ?? null,
        supportEmail: input.supportEmail ?? null,
        metadata: input.metadata ?? {},
      });
      await this.accounts.openMerchantAccounts(tx, row);
      await this.audit.record(tx, {
        action: 'merchant.created',
        resourceType: 'merchant',
        resourceId: row.ref,
        merchantId: row.id,
        after: merchantAuditSnapshot(row),
      });
      const ownerInvitation = input.ownerEmail
        ? await this.invitations.createInTx(
            tx,
            row,
            { email: input.ownerEmail, role: 'owner' },
            actor
          )
        : null;
      return { merchant: toMerchantView(row), ownerInvitation };
    });
  }

  async getByRef(ref: string): Promise<MerchantView> {
    const row = await this.merchants.findByRef(ref);
    if (!row) throw new AppError('NOT_FOUND');
    return toMerchantView(row);
  }

  async getById(id: string): Promise<MerchantView> {
    const row = await this.merchants.findById(id);
    if (!row) throw new AppError('NOT_FOUND');
    return toMerchantView(row);
  }

  async list(query: {
    status?: MerchantStatus;
    limit?: number;
    cursor?: string;
  }): Promise<Page<MerchantView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const fingerprint = filterFingerprint({ status: query.status });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.merchants.list({ status: query.status, after, limit });
    const page = toPage(rows, limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
    return { items: page.items.map(toMerchantView), nextCursor: page.nextCursor };
  }

  /** Profile edit. `lookup` locks the target row: by ref (admin) or by id (dashboard). */
  async update(
    lookup: { ref: string } | { id: string },
    patch: MerchantPatch
  ): Promise<MerchantView> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.lock(tx, lookup);
      if (Object.keys(patch).length === 0) return toMerchantView(current);
      const updated = await this.merchants.update(tx, current.id, patch);
      await this.audit.record(tx, {
        action: 'merchant.updated',
        resourceType: 'merchant',
        resourceId: updated.ref,
        merchantId: updated.id,
        before: merchantAuditSnapshot(current),
        after: merchantAuditSnapshot(updated),
      });
      return toMerchantView(updated);
    });
  }

  /**
   * Admin lifecycle action (suspend, activate, close). The transition is checked against
   * the locked current status, so a stale request cannot skip a state.
   */
  async transition(
    ref: string,
    event: MerchantEvent,
    reason: string | undefined
  ): Promise<MerchantView> {
    const result = await this.unitOfWork.run(async (tx) => {
      const current = await this.lock(tx, { ref });
      const to = nextMerchantStatus(current.status as MerchantStatus, event, 'admin');
      if (event === 'close' && (await this.balances.hasNonZeroBalance(current.id, tx))) {
        throw new AppError('MERCHANT_BALANCE_NOT_ZERO');
      }
      const updated = await this.merchants.setStatus(tx, current.id, to);
      await this.audit.record(tx, {
        action: `merchant.${event === 'close' ? 'closed' : event === 'suspend' ? 'suspended' : 'activated'}`,
        resourceType: 'merchant',
        resourceId: updated.ref,
        merchantId: updated.id,
        before: { status: current.status },
        after: { status: updated.status, ...(reason ? { reason } : {}) },
      });
      // Merchants see suspension and reactivation of their live account (spec 6.11).
      if (event === 'suspend' || event === 'activate') {
        await this.events.emit(tx, {
          merchantId: updated.id,
          environment: 'live',
          type: event === 'suspend' ? 'merchant.suspended' : 'merchant.activated',
          resourceType: 'merchant',
          resourceId: updated.ref,
          object: { id: updated.ref, status: updated.status },
        });
      }
      return { view: toMerchantView(updated), merchantId: updated.id };
    });
    // After commit: cached API keys carry the merchant's status, so drop them (spec 8.3). If
    // Redis is down the change is still committed and cached copies lapse within 60 s.
    await this.keyCache.evictMerchant(result.merchantId).catch((error: unknown) => {
      this.logger.error(
        { err: toLoggableError(error), merchantId: result.merchantId },
        'api key cache eviction failed; cached keys expire within 60 seconds'
      );
    });
    return result.view;
  }

  private async lock(
    tx: Transaction,
    lookup: { ref: string } | { id: string }
  ): Promise<MerchantRow> {
    const row =
      'ref' in lookup
        ? await this.merchants.lockByRef(tx, lookup.ref)
        : await this.merchants.lockById(tx, lookup.id);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }
}
