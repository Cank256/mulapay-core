/**
 * Unit tests for ledger service branches that a healthy database cannot produce. The
 * database-backed behaviour is proven in test/integration/ledger-*.int-spec.ts.
 */
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Executor } from '../../common/db/database.types';
import type { UnitOfWork } from '../../common/db/unit-of-work';
import { FixedClock } from '../../../test/support/fixed-clock';
import type { AccountsService } from '../accounts/accounts.service';
import type { BalancesRepository } from '../balances/balances.repository';
import { LedgerIntegrityRepository } from './ledger-integrity.repository';
import { DEFAULT_INTEGRITY_WINDOW_DAYS, LedgerIntegrityService } from './ledger-integrity.service';
import { LedgerRepository, type EntryKeyRow } from './ledger.repository';
import { PostingService } from './posting.service';

const tx = {} as Executor;
const unitOfWork = { run: vi.fn((work: (t: Executor) => unknown) => work(tx)) };

function integrityService(overrides: Partial<Record<keyof LedgerIntegrityRepository, unknown>>) {
  const empty = vi.fn(async () => []);
  const repository = {
    invalidEntries: empty,
    balanceMismatches: empty,
    nonZeroSuspense: empty,
    negativeMerchantBalances: empty,
    totals: vi.fn(async () => [
      { environment: 'live', currency: 'UGX', debits: '5', credits: '5' },
    ]),
    trialBalance: empty,
    ...overrides,
  } as unknown as LedgerIntegrityRepository;
  const logger = { error: vi.fn() };
  const clock = new FixedClock('2026-03-01T00:00:00.000Z');
  const service = new LedgerIntegrityService(
    repository,
    unitOfWork as unknown as UnitOfWork,
    clock,
    logger as unknown as Logger
  );
  return { service, repository, logger };
}

describe('LedgerIntegrityService', () => {
  it('reports ok without logging when nothing is wrong, over the default window', async () => {
    const { service, repository, logger } = integrityService({});
    const report = await service.check();
    expect(report.ok).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    expect(report.window.to.toISOString()).toBe('2026-03-01T00:00:00.001Z');
    expect(report.window.to.getTime() - report.window.from.getTime()).toBe(
      DEFAULT_INTEGRITY_WINDOW_DAYS * 86_400_000
    );
    expect(repository.invalidEntries).toHaveBeenCalledWith(
      tx,
      report.window.from,
      report.window.to
    );
    expect(unitOfWork.run).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });

  it('maps every finding, fails the report and logs counts only', async () => {
    const { service, logger } = integrityService({
      invalidEntries: vi.fn(async () => [
        {
          ref: 'je_1',
          created_at: '2026-02-01 00:00:00+00',
          line_count: 1,
          debits: '10',
          credits: '0',
          currency_mismatch: true,
        },
      ]),
      balanceMismatches: vi.fn(async () => [
        {
          code: '1100:bank:x',
          environment: 'test',
          currency: 'UGX',
          recorded_debits: '1',
          recorded_credits: '0',
          journal_debits: '0',
          journal_credits: '0',
        },
      ]),
      nonZeroSuspense: vi.fn(async () => [
        { code: '9000:suspense', environment: 'live', currency: 'UGX', balance: '7' },
      ]),
      negativeMerchantBalances: vi.fn(async () => [
        { code: '2000:merchant_payable:m', environment: 'live', currency: 'UGX', balance: '-3' },
      ]),
      totals: vi.fn(async () => [
        { environment: 'live', currency: 'UGX', debits: '5', credits: '4' },
        { environment: 'test', currency: 'UGX', debits: '5', credits: '5' },
      ]),
    });
    const from = new Date('2026-02-01T00:00:00Z');
    const to = new Date('2026-02-02T00:00:00Z');
    const report = await service.check({ from, to });
    expect(report.ok).toBe(false);
    expect(report.window).toEqual({ from, to });
    expect(report.invalidEntries).toEqual([
      {
        entryRef: 'je_1',
        createdAt: '2026-02-01 00:00:00+00',
        reasons: ['too_few_lines', 'unbalanced', 'currency_mismatch'],
        lineCount: 1,
        debitsMinor: 10n,
        creditsMinor: 0n,
      },
    ]);
    expect(report.balanceMismatches[0]?.recordedDebitsMinor).toBe(1n);
    expect(report.nonZeroSuspense[0]?.balanceMinor).toBe(7n);
    expect(report.negativeMerchantBalances[0]?.balanceMinor).toBe(-3n);
    expect(report.unbalancedTotals).toEqual([
      { environment: 'live', currency: 'UGX', debitsMinor: 5n, creditsMinor: 4n },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      {
        event: 'ledger.integrity_failed',
        invalidEntries: 1,
        balanceMismatches: 1,
        nonZeroSuspense: 1,
        negativeMerchantBalances: 1,
        unbalancedTotals: 1,
      },
      'ledger integrity check failed'
    );
  });

  it('flags each invalid-entry reason on its own', async () => {
    const row = { ref: 'je_2', created_at: 't', line_count: 2, debits: '3', credits: '3' };
    const { service } = integrityService({
      invalidEntries: vi.fn(async () => [{ ...row, currency_mismatch: true }]),
    });
    const report = await service.check();
    expect(report.invalidEntries[0]?.reasons).toEqual(['currency_mismatch']);
  });

  it('builds a trial balance and says whether it balances', async () => {
    const { service } = integrityService({
      trialBalance: vi.fn(async () => [
        {
          code: '1000:provider_clearing:mtn',
          name: 'c',
          type: 'asset',
          normal_balance: 'debit',
          debits: '100',
          credits: '30',
        },
        {
          code: '4000:fee_revenue',
          name: 'f',
          type: 'revenue',
          normal_balance: 'credit',
          debits: '0',
          credits: '60',
        },
      ]),
    });
    const trial = await service.trialBalance('live', 'UGX');
    expect(trial.accounts.map((a) => a.balanceMinor)).toEqual([70n, 60n]);
    expect(trial.totalDebitsMinor).toBe(100n);
    expect(trial.totalCreditsMinor).toBe(90n);
    expect(trial.balanced).toBe(false);
  });
});

describe('PostingService.load', () => {
  it('fails loudly when a registered entry is missing from the journal', async () => {
    const ledger = { findEntry: vi.fn(async () => undefined) } as unknown as LedgerRepository;
    const service = new PostingService(
      ledger,
      {} as AccountsService,
      {} as BalancesRepository,
      new FixedClock()
    );
    await expect(
      service.load(tx, { entryId: 'x', entryRef: 'je_x', entryCreatedAt: 't' } as EntryKeyRow)
    ).rejects.toThrow('journal entry je_x is registered but missing');
  });
});

describe('LedgerRepository.insertEntry', () => {
  it('fails loudly when the insert returns no row', async () => {
    const executor = {
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
    } as unknown as Executor;
    await expect(new LedgerRepository().insertEntry(executor, {} as never)).rejects.toThrow(
      'journal entry insert returned no row'
    );
  });
});
