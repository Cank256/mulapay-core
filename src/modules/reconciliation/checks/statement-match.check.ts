/**
 * Provider statement matching (spec 6.8 run 3). Reads a stored statement, matches its rows
 * to core transactions (see `domain/statement-matching.ts`), writes each row's result and
 * raises exceptions for what does not match:
 *
 *   statement_unmatched_row                the provider reports money core has no record of
 *   statement_amount_mismatch              same reference, different amount or currency
 *   statement_duplicate_row                a reference repeated, or already matched earlier
 *   statement_unmatched_core_transaction   core says it moved money the statement lacks
 *
 * Matching writes row results and exceptions only. A transaction is never changed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { APP_CONFIG } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import { matchStatement, type RowMatch } from '../domain/statement-matching';
import { ReconciliationQueriesRepository } from '../reconciliation-queries.repository';
import type {
  ReconciliationCheck,
  RunCheckContext,
  RunCheckResult,
} from '../reconciliation-run.service';
import { StatementsRepository } from '../statements.repository';

const HOUR_MS = 3_600_000;

@Injectable()
export class StatementMatchCheck implements ReconciliationCheck {
  readonly kind = 'provider_statement' as const;

  constructor(
    private readonly statements: StatementsRepository,
    private readonly queries: ReconciliationQueriesRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async execute(ctx: RunCheckContext): Promise<RunCheckResult> {
    const ref = ctx.scope.statement;
    const statement = ref ? await this.statements.findByRef(ref) : undefined;
    if (!statement) throw new AppError('NOT_FOUND');

    const windowMs = this.config.RECON_STATEMENT_DATE_WINDOW_HOURS * HOUR_MS;
    const lines = await this.statements.linesOf(statement.id);
    const candidates = await this.queries.statementCandidates(
      statement.provider,
      statement.currency,
      new Date(statement.periodStart.getTime() - windowMs),
      new Date(statement.periodEnd.getTime() + windowMs)
    );
    const previously = await this.unitOfWork.run((tx) =>
      this.statements.refsMatchedElsewhere(tx, statement.provider, statement.currency, statement.id)
    );
    const result = matchStatement(
      lines.map((l) => ({
        rowNo: l.rowNo,
        providerRef: l.providerRef,
        amountMinor: l.amountMinor,
        currency: l.currency,
        occurredAt: l.occurredAt,
      })),
      candidates.map((c) => ({
        id: c.id,
        ref: c.ref,
        providerTransactionId: c.providerTransactionId,
        amountMinor: c.amountMinor,
        currency: c.currency,
        completedAt: c.completedAt,
      })),
      { windowMs, previouslyMatchedRefs: previously }
    );

    const byRow = new Map<number, RowMatch>(result.rows.map((r) => [r.rowNo, r]));
    const counts = { matched: 0, unmatched: 0, mismatch: 0, duplicate: 0 };
    await this.unitOfWork.run(async (tx) => {
      for (const line of lines) {
        const match = byRow.get(line.rowNo) as RowMatch;
        await this.statements.setLineMatch(tx, line.id, {
          matchStatus: match.status,
          matchedTransactionId: match.transactionId,
          matchNote: match.note,
        });
      }
    });

    for (const line of lines) {
      const match = byRow.get(line.rowNo) as RowMatch;
      const common = {
        environment: 'live' as const,
        currency: line.currency,
        amountMinor: line.amountMinor,
      };
      const row = { statement: statement.ref, row: line.rowNo, providerRef: line.providerRef };
      if (match.status === 'matched_reference' || match.status === 'matched_amount') {
        counts.matched += 1;
      } else if (match.status === 'unmatched') {
        counts.unmatched += 1;
        await ctx.raise({
          ...common,
          kind: 'statement_unmatched_row',
          dedupeKey: `stmt:row:${statement.ref}:${line.rowNo}`,
          expected: { coreTransactionFor: line.providerRef },
          actual: { ...row, amountMinor: line.amountMinor, occurredAt: line.occurredAt },
        });
      } else if (match.status === 'mismatch') {
        counts.mismatch += 1;
        const core = candidates.find((c) => c.id === match.transactionId);
        await ctx.raise({
          ...common,
          kind: 'statement_amount_mismatch',
          dedupeKey: `stmt:amount:${statement.ref}:${line.rowNo}`,
          ...(core ? { transactionId: core.id, merchantId: core.merchantId } : {}),
          expected: {
            transaction: match.transactionRef,
            amountMinor: core?.amountMinor,
            currency: core?.currency,
          },
          actual: { ...row, amountMinor: line.amountMinor, currency: line.currency },
        });
      } else {
        counts.duplicate += 1;
        await ctx.raise({
          ...common,
          kind: 'statement_duplicate_row',
          dedupeKey: `stmt:dup:${statement.ref}:${line.rowNo}`,
          expected: { occurrences: 1 },
          actual: { ...row, reason: match.note },
        });
      }
    }

    // Only transactions that completed inside the statement's own period can be "missing".
    const missing = result.unmatchedCore.filter(
      (c) => c.completedAt >= statement.periodStart && c.completedAt < statement.periodEnd
    );
    for (const c of missing) {
      const full = candidates.find((x) => x.id === c.id);
      await ctx.raise({
        kind: 'statement_unmatched_core_transaction',
        dedupeKey: `stmt:core:${statement.ref}:${c.ref}`,
        environment: 'live',
        currency: c.currency,
        amountMinor: c.amountMinor,
        transactionId: c.id,
        ...(full ? { merchantId: full.merchantId } : {}),
        expected: { statementRowFor: c.providerTransactionId ?? c.ref },
        actual: { statement: statement.ref, transaction: c.ref, completedAt: c.completedAt },
      });
    }

    await this.unitOfWork.run((tx) =>
      this.statements.setResult(tx, statement.id, {
        status: 'matched',
        matchedCount: counts.matched,
        unmatchedCount: counts.unmatched,
        mismatchCount: counts.mismatch,
        duplicateCount: counts.duplicate,
        matchedAt: ctx.now,
      })
    );
    return {
      checked: lines.length + missing.length,
      matched: counts.matched,
      summary: { statement: statement.ref, ...counts, unmatchedCoreTransactions: missing.length },
    };
  }
}
