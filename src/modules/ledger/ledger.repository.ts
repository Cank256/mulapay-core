/**
 * SQL for the journal: `journal_entries`, `journal_lines` and the `journal_entry_keys`
 * registry. This is the only file that writes journal tables (spec 6.6: posting is the
 * only code path allowed to insert into them); ledger-boundary.spec.ts enforces it.
 *
 * Journal tables are partitioned by `created_at`, so every read carries the entry's
 * `created_at`, found first through the unpartitioned key registry (spec 5.1).
 */
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { accounts, journalEntries, journalEntryKeys, journalLines } from '../../db/schema';

export type JournalEntryRow = typeof journalEntries.$inferSelect;
export type NewJournalEntry = Omit<typeof journalEntries.$inferInsert, 'createdAt' | 'postedAt'>;
export type NewJournalLine = Omit<
  typeof journalLines.$inferInsert,
  'createdAt' | 'merchantId' | 'metadata'
>;
export type EntryKeyRow = typeof journalEntryKeys.$inferSelect;

export interface JournalLineWithCode {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly direction: string;
  readonly amountMinor: bigint;
}

/** First key of the two-key advisory lock space used for posting idempotency ("LEDG"). */
export const LEDGER_LOCK_NAMESPACE = 0x4c454447;

export type EntryLookup = { readonly id: string } | { readonly ref: string };

@Injectable()
export class LedgerRepository {
  /**
   * Serialises postings that share an idempotency key until the holder commits, so the
   * second one sees the first and replays it instead of failing on the unique key.
   * Transaction-scoped, so safe behind PgBouncer in transaction mode.
   */
  async lockIdempotencyKey(tx: Executor, idempotencyKey: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LEDGER_LOCK_NAMESPACE}::int4, hashtext(${idempotencyKey}))`
    );
  }

  async findKey(tx: Executor, idempotencyKey: string): Promise<EntryKeyRow | undefined> {
    const [row] = await tx
      .select()
      .from(journalEntryKeys)
      .where(eq(journalEntryKeys.idempotencyKey, idempotencyKey))
      .limit(1);
    return row;
  }

  async findKeyByEntry(tx: Executor, lookup: EntryLookup): Promise<EntryKeyRow | undefined> {
    const condition =
      'id' in lookup
        ? eq(journalEntryKeys.entryId, lookup.id)
        : eq(journalEntryKeys.entryRef, lookup.ref);
    const [row] = await tx.select().from(journalEntryKeys).where(condition).limit(1);
    return row;
  }

  async insertEntry(tx: Executor, values: NewJournalEntry): Promise<JournalEntryRow> {
    const [row] = await tx.insert(journalEntries).values(values).returning();
    if (!row) throw new Error('journal entry insert returned no row');
    return row;
  }

  async insertLines(tx: Executor, values: readonly NewJournalLine[]): Promise<void> {
    await tx.insert(journalLines).values([...values]);
  }

  async findEntry(
    tx: Executor,
    id: string,
    createdAt: string
  ): Promise<JournalEntryRow | undefined> {
    const [row] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.createdAt, createdAt)))
      .limit(1);
    return row;
  }

  async findLines(
    tx: Executor,
    entryId: string,
    createdAt: string
  ): Promise<JournalLineWithCode[]> {
    return tx
      .select({
        lineNo: journalLines.lineNo,
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        direction: journalLines.direction,
        amountMinor: journalLines.amountMinor,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.createdAt, createdAt)))
      .orderBy(asc(journalLines.lineNo));
  }
}
