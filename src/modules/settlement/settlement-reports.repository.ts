/** Reads behind the settlement statement: payout, destination, ledger and reconciliation refs. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import {
  providerStatementRows,
  providerStatements,
  reconciliationExceptions,
} from '../../db/schema';

@Injectable()
export class SettlementReportsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /**
   * Journal entry refs by idempotency key. A read of the key registry in plain SQL: only the
   * ledger repository references the journal tables through the schema (ledger-boundary.spec),
   * and nothing here writes them.
   */
  async entryRefs(keys: readonly string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const result = await this.db.execute<{ key: string; ref: string }>(sql`
      select idempotency_key as key, entry_ref as ref
        from core.journal_entry_keys where idempotency_key in ${[...keys]}`);
    return new Map(result.rows.map((r) => [r.key, r.ref]));
  }

  /** Provider statement rows that matched this transaction. */
  async statementMatches(transactionId: string) {
    return this.db
      .select({
        statement: providerStatements.ref,
        provider: providerStatements.provider,
        row: providerStatementRows.rowNo,
        providerRef: providerStatementRows.providerRef,
        status: providerStatementRows.matchStatus,
      })
      .from(providerStatementRows)
      .innerJoin(providerStatements, eq(providerStatements.id, providerStatementRows.statementId))
      .where(eq(providerStatementRows.matchedTransactionId, transactionId));
  }

  async exceptionsFor(transactionId: string) {
    return this.db
      .select({
        ref: reconciliationExceptions.ref,
        kind: reconciliationExceptions.kind,
        status: reconciliationExceptions.status,
      })
      .from(reconciliationExceptions)
      .where(and(eq(reconciliationExceptions.transactionId, transactionId)));
  }

  async payoutTransactionRef(id: string): Promise<string | undefined> {
    const result = await this.db.execute<{ ref: string }>(
      sql`select ref from core.transaction_keys where id = ${id}`
    );
    return result.rows[0]?.ref;
  }
}
