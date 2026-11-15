/**
 * Transaction queries (spec 6.5): one read model over every money movement, scoped to the
 * caller's merchant and environment.
 *
 * Lists use a keyset cursor on `(created_at desc, ref desc)` and always a `created_at`
 * window (default 90 days, at most 366), so a query touches only the partitions in range
 * and never counts or offsets (spec 8.6, 9.2). A cursor is bound to the filters it was
 * issued under; changing a filter is `INVALID_CURSOR`.
 *
 * The timeline of a transaction comes from `transaction_events` (what core applied), never
 * from the gateway's own transaction logs, which carry provider payloads that are not
 * core's to expose (spec 6.5).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { CLOCK } from '../../common/tokens';
import {
  toTimeline,
  toTransactionView,
  type TransactionDetailView,
  type TransactionView,
} from './transaction.views';
import { TransactionsRepository } from './transactions.repository';

export const TRANSACTION_TYPES = [
  'payment',
  'payout',
  'refund',
  'fee',
  'adjustment',
  'transfer',
  'settlement',
] as const;

export interface TransactionListQuery {
  readonly type?: (typeof TRANSACTION_TYPES)[number];
  readonly status?: string;
  readonly currency?: string;
  readonly provider?: string;
  readonly channel?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly minAmountMinor?: bigint;
  readonly maxAmountMinor?: bigint;
  /** Exact match on the transaction ref, its external id or the provider's transaction id. */
  readonly reference?: string;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactions: TransactionsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(
    scope: MerchantScope,
    query: TransactionListQuery
  ): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
    const window = resolveWindow(query, this.clock.now());
    if (
      query.minAmountMinor !== undefined &&
      query.maxAmountMinor !== undefined &&
      query.minAmountMinor > query.maxAmountMinor
    ) {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [
            {
              path: 'minAmountMinor',
              code: 'invalid_range',
              message: 'must not exceed maxAmountMinor',
            },
          ],
        },
      });
    }
    const fingerprint = filterFingerprint({
      environment: scope.environment,
      type: query.type,
      status: query.status,
      currency: query.currency,
      provider: query.provider,
      channel: query.channel,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
      minAmountMinor: query.minAmountMinor?.toString(),
      maxAmountMinor: query.maxAmountMinor?.toString(),
      reference: query.reference,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.transactions.list({
      scope,
      ...window,
      type: query.type,
      status: query.status,
      currency: query.currency,
      provider: query.provider,
      channel: query.channel,
      minAmountMinor: query.minAmountMinor,
      maxAmountMinor: query.maxAmountMinor,
      reference: query.reference,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.createdAt,
      id: row.ref,
    }));
    return { items: page.items.map(toTransactionView), nextCursor: page.nextCursor };
  }

  /** One transaction with its status timeline, or `NOT_FOUND`. */
  async get(scope: MerchantScope, ref: string): Promise<TransactionDetailView> {
    const row = await this.transactions.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    const events = await this.transactions.listEvents(scope, row.id);
    return { ...toTransactionView(row), timeline: toTimeline(events) };
  }
}
