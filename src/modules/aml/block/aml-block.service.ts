/**
 * The block action (spec 6.13): "places a hold on the merchant's balance and suspends further
 * payouts; it never reverses a completed transaction."
 *
 * Invariants upheld:
 *  - A block holds the merchant's whole available balance, one hold per currency, through
 *    `HoldsService` (reason `aml:block:{ref}`, so settlement counts it as an AML hold). The
 *    balance is read under the payable row lock and the hold placed in the same transaction,
 *    so a payout cannot slip between the two.
 *  - A block suspends payouts: while one is active every payout path must refuse through
 *    `PayoutControlService`. Money that arrives after the block is not held, but cannot leave.
 *  - A block touches no transaction and no ledger entry. Completed payments stay completed.
 *  - At most one block is active per merchant (a partial unique index). Blocking an already
 *    blocked merchant returns the existing block and changes nothing.
 *  - Lifting releases the holds the block placed, ends the suspension, and is audited. A hold
 *    that has already ended (captured by a dispute, for instance) is left as it is.
 *  - The merchant is not told. Telling a subject of suspicion about an AML action can be an
 *    offence in many jurisdictions; refused payouts carry a generic error.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import type { Transaction } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import { CLOCK } from '../../../common/tokens';
import { BalancesService } from '../../balances/balances.service';
import { HoldsRepository } from '../../holds/holds.repository';
import { HoldsService } from '../../holds/holds.service';
import { MerchantsRepository } from '../../merchants/merchants.repository';
import { AmlBlocksRepository, type BlockRow } from './aml-blocks.repository';

export interface ApplyBlockInput {
  readonly merchantId: string;
  readonly reason: string;
  readonly source: 'rule' | 'case' | 'manual';
  readonly alertId?: string;
  readonly caseId?: string;
  /** `user:{ref}` or `system:aml`. */
  readonly createdBy: string;
}

export interface BlockResult {
  readonly block: BlockRow;
  readonly created: boolean;
  readonly heldCurrencies: string[];
}

@Injectable()
export class AmlBlockService {
  constructor(
    private readonly blocks: AmlBlocksRepository,
    private readonly holds: HoldsService,
    private readonly holdsRepository: HoldsRepository,
    private readonly balances: BalancesService,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Blocks the merchant inside the caller's transaction. */
  async applyInTx(tx: Transaction, input: ApplyBlockInput): Promise<BlockResult> {
    const now = this.clock.now();
    const merchant = await this.merchants.lockById(tx, input.merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    const inserted = await this.blocks.insert(tx, {
      id: uuidv7(now),
      ref: publicId('amlBlock', now),
      merchantId: input.merchantId,
      reason: input.reason.slice(0, 500),
      source: input.source,
      alertId: input.alertId ?? null,
      caseId: input.caseId ?? null,
      createdBy: input.createdBy,
    });
    if (!inserted) {
      const existing = await this.blocks.findActive(input.merchantId, tx);
      if (!existing) throw new Error('block conflict without an active block');
      return { block: existing, created: false, heldCurrencies: [] };
    }
    const heldCurrencies: string[] = [];
    for (const balance of await this.balances.merchantBalances(input.merchantId, 'live', tx)) {
      const locked = await this.balances.lockedMerchantBalance(
        tx,
        input.merchantId,
        'live',
        balance.currency
      );
      if (locked.availableMinor <= 0n) continue;
      const { hold } = await this.holds.place(tx, {
        merchantId: input.merchantId,
        environment: 'live',
        currency: balance.currency,
        amountMinor: locked.availableMinor,
        reason: `aml:block:${inserted.ref}`,
        idempotencyKey: `aml-block:${inserted.ref}:${balance.currency}`,
        createdBy: 'system:aml',
      });
      await this.blocks.insertHold(tx, {
        blockId: inserted.id,
        holdId: hold.id,
        currency: balance.currency,
      });
      heldCurrencies.push(balance.currency);
    }
    await this.audit.record(tx, {
      action: 'aml.merchant.blocked',
      resourceType: 'aml_block',
      resourceId: inserted.ref,
      merchantId: input.merchantId,
      after: {
        source: input.source,
        reason: inserted.reason,
        payoutsSuspended: true,
        heldCurrencies,
        by: input.createdBy,
      },
      ...(input.createdBy.startsWith('system:')
        ? { actor: { type: 'system' as const, id: 'aml', label: 'AML' } }
        : {}),
    });
    return { block: inserted, created: true, heldCurrencies };
  }

  /** An analyst blocks a merchant. */
  async block(
    merchantRef: string,
    reason: string,
    actor: { userId: string; userRef: string },
    link: { caseId?: string } = {}
  ): Promise<BlockResult> {
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    return this.unitOfWork.run((tx) =>
      this.applyInTx(tx, {
        merchantId: merchant.id,
        reason,
        source: link.caseId ? 'case' : 'manual',
        caseId: link.caseId,
        createdBy: `user:${actor.userRef}`,
      })
    );
  }

  /** Lifts a block: releases its holds and lets payouts resume. */
  async lift(ref: string, note: string, actorUserId: string): Promise<BlockRow> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.blocks.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (current.status === 'lifted') {
        throw new AppError('AML_TRANSITION_INVALID', {
          messageParams: { reason: 'block_lifted' },
          details: { reason: 'block_lifted' },
        });
      }
      const released: string[] = [];
      for (const link of await this.blocks.holdsOf(current.id, tx)) {
        const hold = await this.holdsRepository.lockById(tx, link.holdId);
        if (hold?.state === 'active') {
          await this.holds.release(tx, hold.id, `aml-block-lift:${current.ref}:${link.currency}`);
          released.push(link.currency);
        }
      }
      const lifted = await this.blocks.markLifted(
        tx,
        current.id,
        actorUserId,
        note,
        this.clock.now()
      );
      await this.audit.record(tx, {
        action: 'aml.merchant.unblocked',
        resourceType: 'aml_block',
        resourceId: lifted.ref,
        merchantId: lifted.merchantId,
        before: { status: 'active' },
        after: { status: 'lifted', releasedCurrencies: released, noteLength: note.length },
      });
      return lifted;
    });
  }

  list(filter: { merchantId?: string; status?: string; limit: number }) {
    return this.blocks.list(filter);
  }

  async get(ref: string) {
    const found = await this.blocks.findByRef(ref);
    if (!found) throw new AppError('NOT_FOUND');
    return { ...found, holds: await this.blocks.holdsOf(found.block.id) };
  }
}
