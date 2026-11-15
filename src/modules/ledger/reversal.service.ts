/**
 * `reverseEntry` (spec 6.6): corrects a posted entry with a new entry whose lines are the
 * original's with every direction flipped, `source = 'reversal'` and `reverses_entry_id`
 * set. Nothing is mutated.
 *
 * - Idempotent: the key is `ledgerIdempotencyKey('reversal', originalId)`, so asking again
 *   returns the existing reversal (`replayed: true`) whatever the reason text.
 * - An entry is reversed at most once, and a reversal is never reversed: post a new entry
 *   instead. The database enforces both, and that the lines mirror the original exactly.
 * - Manual reversals need maker-checker approval (spec 6.6, 11). The approvals workflow
 *   (Phase 4) is the caller that will enforce it; this service does not.
 */
import { Injectable } from '@nestjs/common';
import type { Executor } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { ledgerIdempotencyKey, reverseLines, type LedgerActor } from './domain/posting';
import { LedgerRepository, type EntryLookup } from './ledger.repository';
import { PostingService, type PostingResult } from './posting.service';

export interface ReverseEntryInput {
  readonly entry: EntryLookup;
  /** Why the entry is reversed. Stored as the reversal's description. */
  readonly reason: string;
  readonly createdBy: LedgerActor;
  /** See PostEntryInput.allowNegativeMerchantBalance. */
  readonly allowNegativeMerchantBalance?: boolean;
}

@Injectable()
export class ReversalService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly posting: PostingService
  ) {}

  async reverseEntry(tx: Executor, input: ReverseEntryInput): Promise<PostingResult> {
    const key = await this.ledger.findKeyByEntry(tx, input.entry);
    if (!key) throw new AppError('NOT_FOUND');
    const original = await this.posting.load(tx, key);
    if (original.reversesEntryId !== null) {
      throw new AppError('LEDGER_ENTRY_NOT_REVERSIBLE', {
        messageParams: { reason: 'it is itself a reversal' },
      });
    }
    return this.posting.postReversal(
      tx,
      {
        idempotencyKey: ledgerIdempotencyKey('reversal', original.id),
        environment: original.environment,
        currency: original.currency,
        source: 'reversal',
        sourceId: original.ref,
        kind: 'reversal',
        ...(original.merchantId === null ? {} : { merchantId: original.merchantId }),
        ...(original.transactionId === null ? {} : { transactionId: original.transactionId }),
        reversesEntryId: original.id,
        description: input.reason,
        lines: reverseLines(original.lines),
        createdBy: input.createdBy,
      },
      input.allowNegativeMerchantBalance === true
    );
  }
}
