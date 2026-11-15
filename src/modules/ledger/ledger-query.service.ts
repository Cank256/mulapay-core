/**
 * Admin ledger reads (spec 6.6 reads, 7.3): account list and detail, statements with a
 * running balance, entry list and detail. Staff only; the surface layer authorises.
 * Pages are cursor-based over `(created_at, id)` (spec 8.6); `created_at` is carried as
 * the database's microsecond text so a cursor compares exactly.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { AppError } from '../../common/errors/app-error';
import { sha256Hex } from '../../common/crypto/crypto';
import { resolveWindow } from '../../common/pagination/window';
import { CLOCK } from '../../common/tokens';
import { AccountsRepository, type AccountRow } from '../accounts/accounts.repository';
import type { LedgerEnvironment, NormalBalance } from '../accounts/domain/chart-of-accounts';
import { BalancesService } from '../balances/balances.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import type { JournalEntry } from './journal-entry';
import { LedgerQueryRepository, type MovementRow } from './ledger-query.repository';
import { LedgerRepository } from './ledger.repository';
import { PostingService } from './posting.service';
export const LEDGER_PAGE_MAX = 200;
const cursorSchema = z.strictObject({
  k: z.tuple([z.string(), z.string()]),
  f: z.string(),
});
function fingerprint(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256Hex(JSON.stringify(entries)).slice(0, 16);
}
function encode(k: [string, string], f: string): string {
  return Buffer.from(JSON.stringify({ k, f }), 'utf8').toString('base64url');
}
function decode(cursor: string, f: string): [string, string] {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    if (parsed.f !== f) throw new Error('filters changed');
    return parsed.k;
  } catch {
    throw new AppError('INVALID_CURSOR');
  }
}
export interface Paged<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
export interface ListEntriesQuery {
  readonly environment?: LedgerEnvironment;
  readonly merchantRef?: string;
  readonly source?: string;
  readonly transactionId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}
export interface StatementQuery {
  readonly environment: LedgerEnvironment;
  readonly currency: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}
@Injectable()
export class LedgerQueryService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly balances: BalancesService,
    private readonly query: LedgerQueryRepository,
    private readonly ledger: LedgerRepository,
    private readonly posting: PostingService,
    private readonly merchants: MerchantsRepository,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}
  async listAccounts(filter: {
    environment: LedgerEnvironment;
    purpose?: string;
    merchantRef?: string;
    limit: number;
    cursor?: string;
  }): Promise<Paged<AccountRow>> {
    const limit = clampLimit(filter.limit);
    const f = fingerprint({ ...filter, cursor: undefined, limit: undefined });
    const after = filter.cursor ? decode(filter.cursor, f)[0] : undefined;
    const merchant = await this.merchantFilter(filter.merchantRef);
    if (merchant === null) return { items: [], nextCursor: null };
    const merchantId = merchant;
    const rows = await this.accounts.list({
      environment: filter.environment,
      purpose: filter.purpose,
      merchantId,
      afterCode: after,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encode([last.code, last.ref], f) : null,
    };
  }
  /** One account with its posted balance in every currency it has been posted in. */
  async getAccount(environment: LedgerEnvironment, code: string) {
    const account = await this.accounts.findByCode(environment, code);
    if (!account) throw new AppError('NOT_FOUND');
    return { account, balances: await this.balances.forAccount(environment, code) };
  }
  async statement(code: string, query: StatementQuery) {
    const account = await this.accounts.findByCode(query.environment, code);
    if (!account) throw new AppError('NOT_FOUND');
    const now = this.clock.now();
    const window = resolveWindow({ from: query.from, to: query.to }, now);
    const limit = clampLimit(query.limit);
    const f = fingerprint({
      code,
      environment: query.environment,
      currency: query.currency,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });
    const after = query.cursor ? decode(query.cursor, f) : undefined;
    const rows = await this.query.statement({
      accountId: account.id,
      normalBalance: account.normalBalance as NormalBalance,
      currency: query.currency,
      from: window.from,
      to: window.to,
      after: after ? { createdAt: after[0], key: after[1] } : undefined,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      account,
      currency: query.currency,
      window,
      items,
      nextCursor:
        rows.length > limit && last
          ? encode(
              [last.created_at, `${last.entry_id}:${String(last.line_no).padStart(3, '0')}`],
              f
            )
          : null,
    };
  }
  async listEntries(query: ListEntriesQuery) {
    const limit = clampLimit(query.limit);
    const window = resolveWindow({ from: query.from, to: query.to }, this.clock.now());
    const f = fingerprint({
      environment: query.environment,
      merchantRef: query.merchantRef,
      source: query.source,
      transactionId: query.transactionId,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });
    const after = query.cursor ? decode(query.cursor, f) : undefined;
    const merchant = await this.merchantFilter(query.merchantRef);
    if (merchant === null) return { items: [], nextCursor: null };
    const merchantId = merchant;
    const rows = await this.query.listEntries(
      {
        environment: query.environment,
        merchantId,
        source: query.source,
        transactionId: query.transactionId,
        from: window.from,
        to: window.to,
        after: after ? { createdAt: after[0], id: after[1] } : undefined,
      },
      limit + 1
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encode([last.created_at, last.id], f) : null,
    };
  }
  /**
   * A merchant's movements on its payable account in one environment, newest first: what
   * `GET /v1/balance-transactions` shows. Never another merchant's, never the reserve or
   * provider accounts.
   */
  async merchantMovements(
    scope: { merchantId: string; environment: LedgerEnvironment },
    query: { currency?: string; from?: Date; to?: Date; limit: number; cursor?: string }
  ) {
    const window = resolveWindow({ from: query.from, to: query.to }, this.clock.now());
    // The filters as asked, not the resolved window: a default window ends "now", which is
    // different on every request, and a cursor must survive that.
    const f = fingerprint({
      environment: scope.environment,
      currency: query.currency,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decode(query.cursor, f) : undefined;
    const payable = (await this.accounts.listForMerchant(scope.merchantId)).find(
      (account) =>
        account.purpose === 'merchant_payable' && account.environment === scope.environment
    );
    if (!payable) return { items: [] as MovementRow[], nextCursor: null };
    const rows = await this.query.merchantMovements({
      merchantId: scope.merchantId,
      accountId: payable.id,
      currency: query.currency,
      ...window,
      after: after ? { createdAt: after[0], key: after[1] } : undefined,
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? encode([last.created_at, last.movement_key], f) : null,
    };
  }
  /** `undefined`: no filter. `null`: a ref that matches no merchant, so nothing can match. */
  private async merchantFilter(ref: string | undefined): Promise<string | null | undefined> {
    if (ref === undefined) return undefined;
    const merchant = await this.merchants.findByRef(ref);
    return merchant ? merchant.id : null;
  }
  /** One entry with its lines, by public ref. */
  async getEntry(ref: string): Promise<JournalEntry> {
    const key = await this.ledger.findKeyByEntry(this.db, { ref });
    if (!key) throw new AppError('NOT_FOUND');
    return this.posting.load(this.db, key);
  }
}
function clampLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), LEDGER_PAGE_MAX);
}
