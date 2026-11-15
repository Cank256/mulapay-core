/**
 * The posted journal entry returned by the ledger services. Internal: it carries internal
 * ids and is never serialised to a client as is.
 */
import type { CurrencyCode } from '../../common/money/currency-codes';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';
import type { Direction, EntrySource } from './domain/posting';
import type { JournalEntryRow } from './ledger.repository';

export interface JournalLine {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly direction: Direction;
  readonly amountMinor: bigint;
}

export interface JournalEntry {
  readonly id: string;
  readonly ref: string;
  readonly idempotencyKey: string;
  readonly environment: LedgerEnvironment;
  readonly currency: CurrencyCode;
  readonly source: EntrySource;
  readonly sourceId: string;
  readonly kind: string;
  readonly description: string;
  readonly merchantId: string | null;
  readonly transactionId: string | null;
  readonly reversesEntryId: string | null;
  readonly createdBy: string;
  readonly postedAt: Date;
  /** Partition key, exactly as stored. */
  readonly createdAt: string;
  readonly lines: readonly JournalLine[];
}

export function toJournalEntry(
  row: JournalEntryRow,
  lines: readonly {
    lineNo: number;
    accountId: string;
    accountCode: string;
    direction: string;
    amountMinor: bigint;
  }[]
): JournalEntry {
  return {
    id: row.id,
    ref: row.ref,
    idempotencyKey: row.idempotencyKey,
    environment: row.environment as LedgerEnvironment,
    currency: row.currency as CurrencyCode,
    source: row.source as EntrySource,
    sourceId: row.sourceId,
    kind: row.kind,
    description: row.description,
    merchantId: row.merchantId,
    transactionId: row.transactionId,
    reversesEntryId: row.reversesEntryId,
    createdBy: row.createdBy,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.accountCode,
      direction: l.direction as Direction,
      amountMinor: l.amountMinor,
    })),
  };
}
