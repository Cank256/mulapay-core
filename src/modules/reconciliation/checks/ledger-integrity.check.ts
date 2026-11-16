/**
 * Ledger integrity reconciliation (spec 6.8 run 2), hourly. It asks the ledger to prove
 * itself and turns every failure into an exception and a sev1 incident:
 *
 *   unbalanced entries, `account_balances` that disagree with the journal, merchant payable
 *   in a debit position, a negative available balance (payable less holds, spec 5.3 rule 7),
 *   a non-empty suspense account, and totals whose debits differ from credits.
 *
 * The database prevents all of these; this run exists to prove it independently, so any
 * finding is treated as the platform's most serious signal and pages immediately (spec 10).
 * The incident is deduplicated per scope while it is open, so a standing failure is one
 * incident whose detection counter grows, not one per hour.
 */
import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { ledgerIntegrityFailures, suspenseBalanceMinor } from '../../../common/telemetry/metrics';
import { IncidentsService } from '../../incidents/incidents.service';
import { LedgerIntegrityService } from '../../ledger/ledger-integrity.service';
import type { RaiseInput } from '../exception-recorder';
import { ReconciliationQueriesRepository } from '../reconciliation-queries.repository';
import type {
  ReconciliationCheck,
  RunCheckContext,
  RunCheckResult,
} from '../reconciliation-run.service';

const FAILURE_KINDS = [
  'unbalanced_entry',
  'balance_mismatch',
  'negative_merchant_payable',
  'negative_available_balance',
  'suspense_nonzero',
  'totals_unbalanced',
] as const;

@Injectable()
export class LedgerIntegrityCheck implements ReconciliationCheck {
  readonly kind = 'ledger_integrity' as const;

  constructor(
    private readonly integrity: LedgerIntegrityService,
    private readonly queries: ReconciliationQueriesRepository,
    private readonly incidents: IncidentsService,
    private readonly unitOfWork: UnitOfWork
  ) {}

  async execute(ctx: RunCheckContext): Promise<RunCheckResult> {
    const { environment, currency } = ctx.scope;
    const inScope = (env: string, ccy: string) =>
      env === environment && (currency === undefined || ccy === currency);
    const report = await this.integrity.check();

    const entryScopes = await this.queries.entryScopes(
      report.invalidEntries.map((e) => ({ ref: e.entryRef, createdAt: e.createdAt }))
    );
    const findings: RaiseInput[] = [];
    const counts: Record<(typeof FAILURE_KINDS)[number], number> = {
      unbalanced_entry: 0,
      balance_mismatch: 0,
      negative_merchant_payable: 0,
      negative_available_balance: 0,
      suspense_nonzero: 0,
      totals_unbalanced: 0,
    };
    const suspenseByCurrency = new Map<string, bigint>();

    for (const entry of report.invalidEntries) {
      const scope = entryScopes.get(entry.entryRef);
      if (!scope || !inScope(scope.environment, scope.currency)) continue;
      counts.unbalanced_entry += 1;
      findings.push({
        kind: 'ledger_unbalanced_entry',
        dedupeKey: `ledger:entry:${entry.entryRef}`,
        environment,
        currency: scope.currency,
        amountMinor: absDiff(entry.debitsMinor, entry.creditsMinor),
        expected: { debitsEqualCredits: true, minimumLines: 2 },
        actual: {
          entry: entry.entryRef,
          reasons: entry.reasons,
          lineCount: entry.lineCount,
          debitsMinor: entry.debitsMinor,
          creditsMinor: entry.creditsMinor,
        },
      });
    }
    for (const m of report.balanceMismatches) {
      if (!inScope(m.environment, m.currency)) continue;
      counts.balance_mismatch += 1;
      findings.push({
        kind: 'ledger_balance_mismatch',
        dedupeKey: `ledger:balance:${m.environment}:${m.accountCode}:${m.currency}`,
        environment,
        currency: m.currency,
        amountMinor: absDiff(
          m.recordedDebitsMinor - m.recordedCreditsMinor,
          m.journalDebitsMinor - m.journalCreditsMinor
        ),
        expected: { debitsMinor: m.journalDebitsMinor, creditsMinor: m.journalCreditsMinor },
        actual: {
          account: m.accountCode,
          debitsMinor: m.recordedDebitsMinor,
          creditsMinor: m.recordedCreditsMinor,
        },
      });
    }
    for (const n of report.negativeMerchantBalances) {
      if (!inScope(n.environment, n.currency)) continue;
      counts.negative_merchant_payable += 1;
      findings.push({
        kind: 'ledger_negative_merchant_payable',
        dedupeKey: `ledger:negative:${n.environment}:${n.accountCode}:${n.currency}`,
        environment,
        currency: n.currency,
        amountMinor: n.balanceMinor < 0n ? -n.balanceMinor : n.balanceMinor,
        expected: { position: 'credit' },
        actual: { account: n.accountCode, balanceMinor: n.balanceMinor },
      });
    }
    for (const s of report.nonZeroSuspense) {
      if (!inScope(s.environment, s.currency)) continue;
      counts.suspense_nonzero += 1;
      suspenseByCurrency.set(s.currency, s.balanceMinor);
      findings.push({
        kind: 'ledger_suspense_nonzero',
        dedupeKey: `ledger:suspense:${s.environment}:${s.currency}`,
        environment,
        currency: s.currency,
        amountMinor: s.balanceMinor < 0n ? -s.balanceMinor : s.balanceMinor,
        expected: { balanceMinor: 0n },
        actual: { account: s.accountCode, balanceMinor: s.balanceMinor },
      });
    }
    for (const t of report.unbalancedTotals) {
      if (!inScope(t.environment, t.currency)) continue;
      counts.totals_unbalanced += 1;
      findings.push({
        kind: 'ledger_totals_unbalanced',
        dedupeKey: `ledger:totals:${t.environment}:${t.currency}`,
        environment,
        currency: t.currency,
        amountMinor: absDiff(t.debitsMinor, t.creditsMinor),
        expected: { debitsEqualCredits: true },
        actual: { debitsMinor: t.debitsMinor, creditsMinor: t.creditsMinor },
      });
    }
    for (const n of await this.queries.negativeAvailable(environment, currency)) {
      counts.negative_available_balance += 1;
      findings.push({
        kind: 'ledger_negative_available_balance',
        dedupeKey: `ledger:available:${n.merchantRef}:${n.currency}`,
        environment,
        currency: n.currency,
        merchantId: n.merchantId,
        amountMinor: -n.availableMinor,
        expected: { availableMinorAtLeast: 0n },
        actual: { merchant: n.merchantRef, availableMinor: n.availableMinor },
      });
    }

    for (const finding of findings) await ctx.raise(finding);
    this.publishMetrics(counts, suspenseByCurrency);
    if (findings.length > 0) await this.openIncident(ctx, counts);

    const failing = FAILURE_KINDS.filter((k) => counts[k] > 0).length;
    return {
      checked: FAILURE_KINDS.length,
      matched: FAILURE_KINDS.length - failing,
      summary: { ok: findings.length === 0, findings: counts },
    };
  }

  private openIncident(ctx: RunCheckContext, counts: Record<string, number>): Promise<unknown> {
    const kinds = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ');
    return this.unitOfWork.run((tx) =>
      this.incidents.openAutomatic(tx, {
        dedupeKey: `ledger_integrity:${ctx.scope.environment}:${ctx.scope.currency ?? 'all'}`,
        title: `Ledger integrity failure (${ctx.scope.environment})`,
        severity: 'sev1',
        impact: `The hourly ledger integrity run found: ${kinds}. See reconciliation run ${ctx.run.ref}.`,
        affectedServices: ['ledger'],
        source: 'reconciliation',
      })
    );
  }

  private publishMetrics(counts: Record<string, number>, suspense: Map<string, bigint>): void {
    for (const kind of FAILURE_KINDS) ledgerIntegrityFailures.set({ kind }, counts[kind] ?? 0);
    suspenseBalanceMinor.reset();
    for (const [currency, balance] of suspense) {
      suspenseBalanceMinor.set({ currency }, Number(balance));
    }
  }
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
