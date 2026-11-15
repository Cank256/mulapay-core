/**
 * Ledger integrity validation (spec 5.3 rule 6, 6.6, 6.8 run 2). Reports:
 *
 *   - entries in the window whose lines do not balance, number fewer than two, or carry
 *     another currency than the entry;
 *   - (account, currency) pairs where `account_balances` disagrees with the journal;
 *   - non-zero suspense balances;
 *   - merchant payable or reserve accounts in a debit position;
 *   - environments and currencies whose total debits differ from total credits.
 *
 * The database prevents all of these; this check exists to prove it independently and to
 * catch anything that bypassed the application role. All queries run in one REPEATABLE
 * READ transaction so the journal and the balances are compared at the same instant.
 *
 * Phase 6 schedules it as the hourly reconciliation run and Phase 8 opens a sev1 incident
 * on failure. Until then a failure is logged at error level.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { LedgerEnvironment, NormalBalance } from '../accounts/domain/chart-of-accounts';
import { postedBalance } from '../balances/domain/posted-balance';
import { LedgerIntegrityRepository } from './ledger-integrity.repository';

/** Entries checked by default: the last 90 days, the standard window (spec 9.2 rule 6). */
export const DEFAULT_INTEGRITY_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InvalidEntryReason = 'too_few_lines' | 'unbalanced' | 'currency_mismatch';

export interface LedgerIntegrityReport {
  readonly ok: boolean;
  readonly checkedAt: Date;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly invalidEntries: readonly {
    readonly entryRef: string;
    readonly createdAt: string;
    readonly reasons: readonly InvalidEntryReason[];
    readonly lineCount: number;
    readonly debitsMinor: bigint;
    readonly creditsMinor: bigint;
  }[];
  readonly balanceMismatches: readonly {
    readonly accountCode: string;
    readonly environment: string;
    readonly currency: string;
    readonly recordedDebitsMinor: bigint;
    readonly recordedCreditsMinor: bigint;
    readonly journalDebitsMinor: bigint;
    readonly journalCreditsMinor: bigint;
  }[];
  readonly nonZeroSuspense: readonly AccountAmount[];
  readonly negativeMerchantBalances: readonly AccountAmount[];
  readonly unbalancedTotals: readonly {
    readonly environment: string;
    readonly currency: string;
    readonly debitsMinor: bigint;
    readonly creditsMinor: bigint;
  }[];
}

export interface AccountAmount {
  readonly accountCode: string;
  readonly environment: string;
  readonly currency: string;
  /** Debit-positive for suspense, credit-positive (so negative here) for merchant accounts. */
  readonly balanceMinor: bigint;
}

export interface TrialBalance {
  readonly environment: LedgerEnvironment;
  readonly currency: string;
  readonly accounts: readonly {
    readonly accountCode: string;
    readonly name: string;
    readonly type: string;
    readonly debitsMinor: bigint;
    readonly creditsMinor: bigint;
    readonly balanceMinor: bigint;
  }[];
  readonly totalDebitsMinor: bigint;
  readonly totalCreditsMinor: bigint;
  readonly balanced: boolean;
}

@Injectable()
export class LedgerIntegrityService {
  constructor(
    private readonly integrity: LedgerIntegrityRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async check(window: { from?: Date; to?: Date } = {}): Promise<LedgerIntegrityReport> {
    const checkedAt = this.clock.now();
    const to = window.to ?? new Date(checkedAt.getTime() + 1);
    const from = window.from ?? new Date(to.getTime() - DEFAULT_INTEGRITY_WINDOW_DAYS * DAY_MS);
    const report = await this.unitOfWork.run(async (tx) => this.collect(tx, from, to, checkedAt), {
      isolationLevel: 'repeatable read',
    });
    if (!report.ok) {
      this.logger.error(
        {
          event: 'ledger.integrity_failed',
          invalidEntries: report.invalidEntries.length,
          balanceMismatches: report.balanceMismatches.length,
          nonZeroSuspense: report.nonZeroSuspense.length,
          negativeMerchantBalances: report.negativeMerchantBalances.length,
          unbalancedTotals: report.unbalancedTotals.length,
        },
        'ledger integrity check failed'
      );
    }
    return report;
  }

  async trialBalance(environment: LedgerEnvironment, currency: string): Promise<TrialBalance> {
    const rows = await this.unitOfWork.run(
      (tx) => this.integrity.trialBalance(tx, environment, currency),
      { isolationLevel: 'repeatable read' }
    );
    const accounts = rows.map((row) => {
      const debitsMinor = BigInt(row.debits);
      const creditsMinor = BigInt(row.credits);
      return {
        accountCode: row.code,
        name: row.name,
        type: row.type,
        debitsMinor,
        creditsMinor,
        balanceMinor: postedBalance(row.normal_balance as NormalBalance, debitsMinor, creditsMinor),
      };
    });
    const totalDebitsMinor = accounts.reduce((sum, a) => sum + a.debitsMinor, 0n);
    const totalCreditsMinor = accounts.reduce((sum, a) => sum + a.creditsMinor, 0n);
    return {
      environment,
      currency,
      accounts,
      totalDebitsMinor,
      totalCreditsMinor,
      balanced: totalDebitsMinor === totalCreditsMinor,
    };
  }

  private async collect(
    tx: Executor,
    from: Date,
    to: Date,
    checkedAt: Date
  ): Promise<LedgerIntegrityReport> {
    const invalidEntries = (await this.integrity.invalidEntries(tx, from, to)).map((row) => {
      const debitsMinor = BigInt(row.debits);
      const creditsMinor = BigInt(row.credits);
      const reasons: InvalidEntryReason[] = [];
      if (row.line_count < 2) reasons.push('too_few_lines');
      if (debitsMinor !== creditsMinor) reasons.push('unbalanced');
      if (row.currency_mismatch) reasons.push('currency_mismatch');
      return {
        entryRef: row.ref,
        createdAt: row.created_at,
        reasons,
        lineCount: row.line_count,
        debitsMinor,
        creditsMinor,
      };
    });
    const balanceMismatches = (await this.integrity.balanceMismatches(tx)).map((row) => ({
      accountCode: row.code,
      environment: row.environment,
      currency: row.currency,
      recordedDebitsMinor: BigInt(row.recorded_debits),
      recordedCreditsMinor: BigInt(row.recorded_credits),
      journalDebitsMinor: BigInt(row.journal_debits),
      journalCreditsMinor: BigInt(row.journal_credits),
    }));
    const toAmount = (row: {
      code: string;
      environment: string;
      currency: string;
      balance: string;
    }): AccountAmount => ({
      accountCode: row.code,
      environment: row.environment,
      currency: row.currency,
      balanceMinor: BigInt(row.balance),
    });
    const nonZeroSuspense = (await this.integrity.nonZeroSuspense(tx)).map(toAmount);
    const negativeMerchantBalances = (await this.integrity.negativeMerchantBalances(tx)).map(
      toAmount
    );
    const unbalancedTotals = (await this.integrity.totals(tx))
      .map((row) => ({
        environment: row.environment,
        currency: row.currency,
        debitsMinor: BigInt(row.debits),
        creditsMinor: BigInt(row.credits),
      }))
      .filter((row) => row.debitsMinor !== row.creditsMinor);
    return {
      ok:
        invalidEntries.length === 0 &&
        balanceMismatches.length === 0 &&
        nonZeroSuspense.length === 0 &&
        negativeMerchantBalances.length === 0 &&
        unbalancedTotals.length === 0,
      checkedAt,
      window: { from, to },
      invalidEntries,
      balanceMismatches,
      nonZeroSuspense,
      negativeMerchantBalances,
      unbalancedTotals,
    };
  }
}
