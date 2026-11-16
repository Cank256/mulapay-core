/** SQL for `core.provider_statements` and `core.provider_statement_rows`. Never deleted. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { newestFirst, olderThan } from '../../common/pagination/keyset';
import { providerStatementRows, providerStatements } from '../../db/schema';

export type StatementRow = typeof providerStatements.$inferSelect;
export type NewStatement = typeof providerStatements.$inferInsert;
export type StatementLineRow = typeof providerStatementRows.$inferSelect;
export type NewStatementLine = typeof providerStatementRows.$inferInsert;

const CHUNK = 500;

@Injectable()
export class StatementsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewStatement): Promise<StatementRow> {
    const [row] = await tx.insert(providerStatements).values(values).returning();
    if (!row) throw new Error('statement insert returned no row');
    return row;
  }

  async insertLines(tx: Executor, lines: readonly NewStatementLine[]): Promise<void> {
    for (let i = 0; i < lines.length; i += CHUNK) {
      await tx.insert(providerStatementRows).values(lines.slice(i, i + CHUNK));
    }
  }

  async findByContent(
    tx: Executor,
    provider: string,
    currency: string,
    contentSha256: string
  ): Promise<StatementRow | undefined> {
    const [row] = await tx
      .select()
      .from(providerStatements)
      .where(
        and(
          eq(providerStatements.provider, provider),
          eq(providerStatements.currency, currency),
          eq(providerStatements.contentSha256, contentSha256)
        )
      );
    return row;
  }

  async findByRef(ref: string, executor: Executor = this.db): Promise<StatementRow | undefined> {
    const [row] = await executor
      .select()
      .from(providerStatements)
      .where(eq(providerStatements.ref, ref))
      .limit(1);
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<StatementRow | undefined> {
    const [row] = await tx
      .select()
      .from(providerStatements)
      .where(eq(providerStatements.id, id))
      .for('update');
    return row;
  }

  async setResult(
    tx: Executor,
    id: string,
    patch: Partial<
      Pick<
        NewStatement,
        | 'status'
        | 'matchedCount'
        | 'unmatchedCount'
        | 'mismatchCount'
        | 'duplicateCount'
        | 'matchedAt'
      >
    >
  ): Promise<void> {
    await tx.update(providerStatements).set(patch).where(eq(providerStatements.id, id));
  }

  linesOf(statementId: string, executor: Executor = this.db): Promise<StatementLineRow[]> {
    return executor
      .select()
      .from(providerStatementRows)
      .where(eq(providerStatementRows.statementId, statementId))
      .orderBy(asc(providerStatementRows.rowNo));
  }

  pageOfLines(
    statementId: string,
    afterRowNo: number,
    limit: number,
    executor: Executor = this.db
  ): Promise<StatementLineRow[]> {
    return executor
      .select()
      .from(providerStatementRows)
      .where(
        and(
          eq(providerStatementRows.statementId, statementId),
          gt(providerStatementRows.rowNo, afterRowNo)
        )
      )
      .orderBy(asc(providerStatementRows.rowNo))
      .limit(limit + 1);
  }

  async setLineMatch(
    tx: Executor,
    id: string,
    patch: { matchStatus: string; matchedTransactionId: string | null; matchNote: string | null }
  ): Promise<void> {
    await tx.update(providerStatementRows).set(patch).where(eq(providerStatementRows.id, id));
  }

  /** References an earlier statement of this provider matched to a core transaction. */
  async refsMatchedElsewhere(
    tx: Executor,
    provider: string,
    currency: string,
    statementId: string
  ): Promise<Set<string>> {
    const rows = await tx
      .select({ ref: providerStatementRows.providerRef })
      .from(providerStatementRows)
      .innerJoin(providerStatements, eq(providerStatements.id, providerStatementRows.statementId))
      .where(
        and(
          eq(providerStatements.provider, provider),
          eq(providerStatements.currency, currency),
          ne(providerStatementRows.statementId, statementId),
          sql`${providerStatementRows.matchStatus} in ('matched_reference', 'matched_amount')`
        )
      );
    return new Set(rows.map((r) => r.ref));
  }

  list(
    filter: { provider?: string; after?: CursorKey; limit: number },
    executor: Executor = this.db
  ): Promise<StatementRow[]> {
    return executor
      .select()
      .from(providerStatements)
      .where(
        and(
          filter.provider ? eq(providerStatements.provider, filter.provider) : undefined,
          ...(filter.after
            ? olderThan(providerStatements.createdAt, providerStatements.ref, filter.after)
            : [])
        )
      )
      .orderBy(...newestFirst(providerStatements.createdAt, providerStatements.ref))
      .limit(filter.limit + 1);
  }
}
