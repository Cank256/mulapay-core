/**
 * The ledger's one write operation, `postEntry` (spec 6.6).
 *
 * Runs inside the caller's transaction, so the entry commits or rolls back with the
 * business change that caused it. In order:
 *
 *   1. validate the whole posting without touching the database (balanced, positive
 *      bigint amounts, 2 to 100 lines, supported currency, well-formed codes);
 *   2. take a transaction-scoped advisory lock on the idempotency key, then look the key
 *      up: the same posting again returns the original entry, a different one is refused;
 *   3. resolve account codes and check environment, currency and merchant ownership;
 *   4. lock the affected `account_balances` rows in ascending account id order;
 *   5. refuse a posting that would take a merchant liability account negative;
 *   6. insert the entry and its lines. Database triggers register the key, check each
 *      line, apply it to `account_balances`, and assert at commit that the entry balances.
 *
 * Callers must use READ COMMITTED (the UnitOfWork default): after waiting on the lock, the
 * key lookup has to see the entry the previous holder committed.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import type { AccountRow } from '../accounts/accounts.repository';
import { AccountsService } from '../accounts/accounts.service';
import { isMerchantPurpose, type NormalBalance } from '../accounts/domain/chart-of-accounts';
import { BalancesRepository } from '../balances/balances.repository';
import { applyDelta, postedBalance, type BalanceTotals } from '../balances/domain/posted-balance';
import {
  postingFingerprint,
  validatePosting,
  type PostEntryInput,
  type PostingDraft,
  type ValidatedPosting,
} from './domain/posting';
import { toJournalEntry, type JournalEntry } from './journal-entry';
import { LedgerRepository, type EntryKeyRow } from './ledger.repository';

export interface PostingResult {
  readonly entry: JournalEntry;
  /** True when the idempotency key had already posted this entry; nothing was written. */
  readonly replayed: boolean;
}

function invalid(reason: string): AppError {
  return new AppError('LEDGER_POSTING_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

@Injectable()
export class PostingService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly accounts: AccountsService,
    private readonly balances: BalancesRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Posts a balanced journal entry, or replays it when the idempotency key was used. */
  async postEntry(tx: Executor, input: PostEntryInput): Promise<PostingResult> {
    // Reversals are built from the original entry by ReversalService, never by callers.
    if ((input.source as string) === 'reversal') throw invalid('source');
    const { allowNegativeMerchantBalance, ...draft } = input;
    return this.post(tx, validatePosting(draft), allowNegativeMerchantBalance === true);
  }

  /** For ReversalService only: posts a draft that may carry `reversesEntryId`. */
  async postReversal(
    tx: Executor,
    draft: PostingDraft,
    allowNegativeMerchantBalance: boolean
  ): Promise<PostingResult> {
    return this.post(tx, validatePosting(draft), allowNegativeMerchantBalance);
  }

  /** Loads a posted entry with its lines through its registry row. */
  async load(tx: Executor, key: EntryKeyRow): Promise<JournalEntry> {
    const entry = await this.ledger.findEntry(tx, key.entryId, key.entryCreatedAt);
    if (!entry) throw new Error(`journal entry ${key.entryRef} is registered but missing`);
    const lines = await this.ledger.findLines(tx, entry.id, entry.createdAt);
    return toJournalEntry(entry, lines);
  }

  private async post(
    tx: Executor,
    posting: ValidatedPosting,
    allowNegativeMerchantBalance: boolean
  ): Promise<PostingResult> {
    const fingerprint = postingFingerprint(posting);
    await this.ledger.lockIdempotencyKey(tx, posting.idempotencyKey);
    const existing = await this.ledger.findKey(tx, posting.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new AppError('LEDGER_IDEMPOTENCY_CONFLICT');
      }
      return { entry: await this.load(tx, existing), replayed: true };
    }

    const accounts = await this.accounts.resolveForPosting(
      tx,
      posting.environment,
      posting.lines.map((l) => l.accountCode)
    );
    const deltas = new Map<string, { account: AccountRow; delta: BalanceTotals }>();
    for (const line of posting.lines) {
      const account = accounts.get(line.accountCode) as AccountRow;
      if (account.currency !== null && account.currency !== posting.currency) {
        throw invalid('account_currency');
      }
      if (account.merchantId !== null && account.merchantId !== posting.merchantId) {
        throw invalid('merchant_account');
      }
      const current = deltas.get(account.id)?.delta ?? { debits: 0n, credits: 0n };
      const step =
        line.direction === 'debit'
          ? { debits: line.amountMinor, credits: 0n }
          : { debits: 0n, credits: line.amountMinor };
      deltas.set(account.id, { account, delta: applyDelta(current, step) });
    }

    const locked = await this.balances.lockForPosting(tx, [...deltas.keys()], posting.currency);
    if (!allowNegativeMerchantBalance) {
      for (const row of locked) {
        const { account, delta } = deltas.get(row.accountId) as {
          account: AccountRow;
          delta: BalanceTotals;
        };
        if (!isMerchantPurpose(account.purpose)) continue;
        const normal = account.normalBalance as NormalBalance;
        const change = postedBalance(normal, delta.debits, delta.credits);
        const after = applyDelta(
          { debits: row.postedDebitsMinor, credits: row.postedCreditsMinor },
          delta
        );
        if (change < 0n && postedBalance(normal, after.debits, after.credits) < 0n) {
          throw new AppError('INSUFFICIENT_BALANCE');
        }
      }
    }

    const now = this.clock.now();
    const entry = await this.ledger.insertEntry(tx, {
      id: uuidv7(now),
      ref: publicId('journalEntry', now),
      idempotencyKey: posting.idempotencyKey,
      requestFingerprint: fingerprint,
      environment: posting.environment,
      merchantId: posting.merchantId,
      currency: posting.currency,
      kind: posting.kind,
      description: posting.description,
      transactionId: posting.transactionId,
      source: posting.source,
      sourceId: posting.sourceId,
      reversesEntryId: posting.reversesEntryId,
      createdBy: posting.createdBy,
    });
    const lines = posting.lines.map((line, index) => {
      const account = accounts.get(line.accountCode) as AccountRow;
      return {
        lineNo: index + 1,
        accountId: account.id,
        accountCode: account.code,
        direction: line.direction,
        amountMinor: line.amountMinor,
      };
    });
    await this.ledger.insertLines(
      tx,
      lines.map(({ accountCode: _code, ...line }) => ({
        ...line,
        entryId: entry.id,
        currency: posting.currency,
      }))
    );
    return { entry: toJournalEntry(entry, lines), replayed: false };
  }
}
