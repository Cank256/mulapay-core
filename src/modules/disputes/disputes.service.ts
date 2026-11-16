/**
 * Disputes and chargebacks (spec 6.14): "opening a dispute places a hold for the disputed
 * amount, and the outcome either releases it or posts a reversing entry".
 *
 * Invariants upheld, each in one transaction with its audit row last:
 *  - Opening. The dispute is about one successful live payment of the merchant and at most
 *    its amount, and a payment has at most one unresolved dispute. The disputed amount is held
 *    on the merchant's balance through `HoldsService`, under the balance lock. A chargeback
 *    cannot be refused, so if the balance cannot cover all of it, what is available is held
 *    and the rest is recorded as the shortfall; nothing is invented and nothing is dropped.
 *  - Won or withdrawn. The hold is released and the dispute resolves. No ledger entry.
 *  - Lost. The hold is captured and the money leaves the merchant's payable balance in the same
 *    transaction. When the whole payment is disputed and its collection entry can still be
 *    reversed, that entry is reversed through `ReversalService`; otherwise (a partial amount)
 *    a compensating entry moves the disputed amount from the merchant's payable to the
 *    provider clearing account. Either way debits equal credits and the original entry is
 *    never touched. Both are idempotent on the dispute.
 *  - A lost dispute that would take the merchant's balance negative is refused unless staff
 *    accept the deficit explicitly; the deficit then shows up in the ledger integrity run
 *    as a negative merchant payable (spec 5.3 rule 7), not silently.
 *  - A resolved dispute is final. The merchant is told of creation and resolution through
 *    merchant events.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { CLOCK } from '../../common/tokens';
import { merchantAccountCode, providerAccountCode } from '../accounts/domain/chart-of-accounts';
import { BalancesService } from '../balances/balances.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { HoldsService } from '../holds/holds.service';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { PostingService } from '../ledger/posting.service';
import { ReversalService } from '../ledger/reversal.service';
import type { PaymentProvider } from '../payments/domain/payment-event';
import { MerchantsRepository } from '../merchants/merchants.repository';
import {
  assertCanAddEvidence,
  assertCanResolve,
  assertCanReview,
  assertDisputable,
  MAX_EVIDENCE_LENGTH,
  splitHold,
  type DisputeKind,
  type DisputeOutcome,
  type DisputeStatus,
} from './domain/dispute-state';
import { DisputesRepository, type DisputeRow, type DisputeWithRefs } from './disputes.repository';
import { toDisputeEvent } from './dispute.views';

export interface OpenDisputeInput {
  readonly merchantRef: string;
  readonly transactionRef: string;
  readonly kind: DisputeKind;
  readonly amountMinor: bigint;
  readonly reasonCode: string;
  readonly evidenceDueAt?: Date;
  readonly internalNote?: string;
}

export interface ResolveDisputeInput {
  readonly outcome: DisputeOutcome;
  readonly note: string;
  /** Lets a lost dispute take the merchant's balance below zero. */
  readonly acceptDeficit?: boolean;
}

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

@Injectable()
export class DisputesService {
  constructor(
    private readonly disputes: DisputesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly holds: HoldsService,
    private readonly balances: BalancesService,
    private readonly posting: PostingService,
    private readonly reversal: ReversalService,
    private readonly events: MerchantEventsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Staff record a dispute notice from a provider or scheme. */
  async open(input: OpenDisputeInput, staff: Staff): Promise<DisputeWithRefs> {
    const merchant = await this.merchants.findByRef(input.merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    let created: DisputeRow;
    try {
      created = await this.unitOfWork.run(async (tx) => {
        const transaction = await this.disputes.loadTransaction(tx, input.transactionRef);
        if (!transaction) throw new AppError('NOT_FOUND');
        assertDisputable(transaction, merchant.id, input.amountMinor);
        if (await this.disputes.hasUnresolved(tx, transaction.id)) {
          throw new AppError('DISPUTE_INVALID', {
            messageParams: { reason: 'already_disputed' },
            details: { reason: 'already_disputed' },
          });
        }
        const now = this.clock.now();
        const ref = publicId('dispute', now);
        const balance = await this.balances.lockedMerchantBalance(
          tx,
          merchant.id,
          'live',
          transaction.currency
        );
        const { heldMinor, shortfallMinor } = splitHold(balance.availableMinor, input.amountMinor);
        let holdId: string | null = null;
        if (heldMinor > 0n) {
          const { hold } = await this.holds.place(tx, {
            merchantId: merchant.id,
            environment: 'live',
            currency: transaction.currency,
            amountMinor: heldMinor,
            reason: `dispute:${ref}`,
            transactionId: transaction.id,
            idempotencyKey: `dispute-hold:${ref}`,
            createdBy: `user:${staff.userRef}`,
          });
          holdId = hold.id;
        }
        const row = await this.disputes.insert(tx, {
          id: uuidv7(now),
          ref,
          transactionId: transaction.id,
          merchantId: merchant.id,
          environment: 'live',
          kind: input.kind,
          amountMinor: input.amountMinor,
          currency: transaction.currency,
          reasonCode: input.reasonCode,
          evidenceDueAt: input.evidenceDueAt ?? null,
          internalNote: input.internalNote ?? null,
          holdId,
          holdMinor: heldMinor,
          shortfallMinor,
          createdBy: `user:${staff.userRef}`,
        });
        await this.events.emit(tx, {
          merchantId: merchant.id,
          environment: 'live',
          type: 'dispute.created',
          resourceType: 'dispute',
          resourceId: row.ref,
          object: toDisputeEvent(row, transaction.ref),
        });
        await this.audit.record(tx, {
          action: 'dispute.created',
          resourceType: 'dispute',
          resourceId: row.ref,
          merchantId: merchant.id,
          after: {
            transaction: transaction.ref,
            kind: row.kind,
            amountMinor: row.amountMinor.toString(),
            currency: row.currency,
            heldMinor: heldMinor.toString(),
            shortfallMinor: shortfallMinor.toString(),
          },
        });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'disputes_one_unresolved_key')) {
        throw new AppError('DISPUTE_INVALID', {
          messageParams: { reason: 'already_disputed' },
          details: { reason: 'already_disputed' },
        });
      }
      throw error;
    }
    const found = await this.disputes.findByRef(created.ref);
    if (!found) throw new Error('dispute vanished after creation');
    return found;
  }

  /** Staff move a dispute into investigation, and set what the merchant has until. */
  async update(
    ref: string,
    patch: { status?: 'under_review'; evidenceDueAt?: Date | null; internalNote?: string }
  ): Promise<DisputeWithRefs> {
    await this.unitOfWork.run(async (tx) => {
      const current = await this.disputes.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (current.status === 'resolved') {
        throw new AppError('DISPUTE_TRANSITION_INVALID', {
          messageParams: { reason: 'dispute_resolved' },
          details: { reason: 'dispute_resolved' },
        });
      }
      if (patch.status === 'under_review') assertCanReview(current.status as DisputeStatus);
      const updated = await this.disputes.update(tx, current.id, {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.evidenceDueAt !== undefined ? { evidenceDueAt: patch.evidenceDueAt } : {}),
        ...(patch.internalNote !== undefined ? { internalNote: patch.internalNote } : {}),
      });
      await this.audit.record(tx, {
        action: 'dispute.updated',
        resourceType: 'dispute',
        resourceId: updated.ref,
        merchantId: updated.merchantId,
        before: {
          status: current.status,
          evidenceDueAt: current.evidenceDueAt?.toISOString() ?? null,
        },
        after: {
          status: updated.status,
          evidenceDueAt: updated.evidenceDueAt?.toISOString() ?? null,
        },
      });
    });
    return this.require(ref);
  }

  /** The merchant answers a dispute with evidence, while the evidence period is open. */
  async addEvidence(scope: MerchantScope, ref: string, text: string): Promise<DisputeWithRefs> {
    if (text.length < 1 || text.length > MAX_EVIDENCE_LENGTH) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'text', message: `1 to ${MAX_EVIDENCE_LENGTH} characters` }] },
      });
    }
    await this.unitOfWork.run(async (tx) => {
      const current = await this.disputes.lockForMerchant(tx, scope, ref);
      if (!current) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      assertCanAddEvidence(
        {
          status: current.status as DisputeStatus,
          evidenceDueAt: current.evidenceDueAt,
          evidenceCount: current.evidence.length,
        },
        now
      );
      const updated = await this.disputes.update(tx, current.id, {
        evidence: [...current.evidence, { at: now.toISOString(), text }],
      });
      await this.audit.record(tx, {
        action: 'dispute.evidence_added',
        resourceType: 'dispute',
        resourceId: updated.ref,
        merchantId: updated.merchantId,
        after: { items: updated.evidence.length, length: text.length },
      });
    });
    const found = await this.disputes.findForMerchant(scope, ref);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  /** Staff decide a dispute. See the class comment for what each outcome does. */
  async resolve(ref: string, input: ResolveDisputeInput, staff: Staff): Promise<DisputeWithRefs> {
    await this.unitOfWork.run(async (tx) => {
      const current = await this.disputes.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      assertCanResolve(current.status as DisputeStatus);
      const now = this.clock.now();
      let entryRef: string | null = null;

      if (input.outcome === 'merchant_lost') {
        entryRef = await this.chargeMerchant(tx, current, input.acceptDeficit === true, staff);
      } else if (current.holdId) {
        await this.holds.release(tx, current.holdId, `dispute-release:${current.ref}`);
      }
      const resolved = await this.disputes.update(tx, current.id, {
        status: 'resolved',
        outcome: input.outcome,
        resolutionNote: input.note,
        resolutionEntryRef: entryRef,
        resolvedBy: staff.userId,
        resolvedAt: now,
      });
      const withRefs = await this.disputes.findByRef(resolved.ref, tx);
      await this.events.emit(tx, {
        merchantId: resolved.merchantId,
        environment: 'live',
        type: 'dispute.resolved',
        resourceType: 'dispute',
        resourceId: resolved.ref,
        object: toDisputeEvent(resolved, withRefs?.transactionRef ?? null),
      });
      await this.audit.record(tx, {
        action: 'dispute.resolved',
        resourceType: 'dispute',
        resourceId: resolved.ref,
        merchantId: resolved.merchantId,
        before: { status: current.status },
        after: {
          status: 'resolved',
          outcome: resolved.outcome,
          entry: entryRef,
          holdReleased: input.outcome !== 'merchant_lost' && current.holdId !== null,
        },
      });
    });
    return this.require(ref);
  }

  async get(scope: MerchantScope, ref: string): Promise<DisputeWithRefs> {
    const found = await this.disputes.findForMerchant(scope, ref);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  async getAny(ref: string): Promise<DisputeWithRefs> {
    return this.require(ref);
  }

  async list(query: {
    scope?: MerchantScope;
    merchantRef?: string;
    status?: DisputeStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<DisputeWithRefs>> {
    let merchantId: string | undefined;
    if (query.merchantRef) {
      const merchant = await this.merchants.findByRef(query.merchantRef);
      if (!merchant) return { items: [], nextCursor: null };
      merchantId = merchant.id;
    }
    const fingerprint = filterFingerprint({
      env: query.scope?.environment,
      merchant: query.merchantRef,
      status: query.status,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.disputes.list({
      scope: query.scope,
      merchantId,
      status: query.status,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.createdAt,
      id: r.row.ref,
    }));
  }

  /**
   * Takes the disputed amount from the merchant: captures the hold and posts the ledger entry,
   * which leaves the merchant's payable balance as the hold stops reserving it.
   */
  private async chargeMerchant(
    tx: Transaction,
    dispute: DisputeRow,
    acceptDeficit: boolean,
    staff: Staff
  ): Promise<string> {
    const transaction = await this.disputes.loadTransaction(
      tx,
      (await this.disputes.findByRef(dispute.ref, tx))?.transactionRef ?? ''
    );
    const merchant = await this.merchants.findById(dispute.merchantId, tx);
    if (!transaction || !merchant || !transaction.provider) {
      throw new AppError('INTERNAL_ERROR', { cause: new Error('dispute without its payment') });
    }
    const balance = await this.balances.lockedMerchantBalance(
      tx,
      dispute.merchantId,
      'live',
      dispute.currency
    );
    // The capture ends the reservation; the posting then takes the money for good.
    if (dispute.holdId)
      await this.holds.capture(tx, dispute.holdId, `dispute-capture:${dispute.ref}`);
    if (balance.postedMinor < dispute.amountMinor && !acceptDeficit) {
      throw new AppError('INSUFFICIENT_BALANCE', {
        details: {
          available: (balance.postedMinor < 0n ? 0n : balance.postedMinor).toString(),
          requested: dispute.amountMinor.toString(),
          currency: dispute.currency,
        },
      });
    }
    const createdBy = { type: 'user' as const, id: staff.userRef };
    const collectionRef = await this.disputes.reversibleCollectionEntry(
      tx,
      transaction.id,
      transaction.createdAt
    );
    if (dispute.amountMinor === transaction.amountMinor && collectionRef) {
      const result = await this.reversal.reverseEntry(tx, {
        entry: { ref: collectionRef },
        reason: `Chargeback ${dispute.ref}: payment ${transaction.ref} reversed`,
        createdBy,
        allowNegativeMerchantBalance: acceptDeficit,
      });
      return result.entry.ref;
    }
    const result = await this.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('adjustment', `dispute:${dispute.ref}`),
      environment: 'live',
      currency: dispute.currency,
      source: 'adjustment',
      sourceId: `dispute:${dispute.ref}`,
      kind: 'dispute.lost',
      merchantId: dispute.merchantId,
      transactionId: transaction.id,
      description: `Dispute ${dispute.ref} lost: ${dispute.amountMinor} of payment ${transaction.ref} returned`,
      lines: [
        {
          accountCode: merchantAccountCode('merchant_payable', merchant.ref),
          direction: 'debit',
          amountMinor: dispute.amountMinor,
        },
        {
          accountCode: providerAccountCode(
            'provider_clearing',
            transaction.provider as PaymentProvider
          ),
          direction: 'credit',
          amountMinor: dispute.amountMinor,
        },
      ],
      createdBy,
      allowNegativeMerchantBalance: acceptDeficit,
    });
    return result.entry.ref;
  }

  private async require(ref: string): Promise<DisputeWithRefs> {
    const found = await this.disputes.findByRef(ref);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }
}
