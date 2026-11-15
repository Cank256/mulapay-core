/**
 * Phase 2 integrity validation (spec 6.6, 6.8 run 2) against real Postgres.
 *
 * The database prevents every corruption checked here, so the test injects them as the
 * superuser with `session_replication_role = replica`, which disables triggers and
 * foreign keys for that transaction only, then proves the integrity check finds each one.
 * Corruptions use the test environment in XOF, which no other ledger test file touches,
 * and are removed again in afterAll.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicId } from '../../src/common/ids/ids';
import {
  connect,
  createBankAccount,
  createMerchant,
  line,
  post,
  postingInput,
  startLedgerContext,
  SYSTEM_ACTOR,
  type LedgerContext,
  type TestMerchant,
} from '../support/ledger';

let ctx: LedgerContext;
let su: Client;
let merchant: TestMerchant;
let bankA: string;
let bankB: string;
const injected: { entryIds: string[]; tamperedAccountId?: string } = { entryIds: [] };
const SUSPENSE = '9000:suspense';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function accountId(code: string): Promise<string> {
  const result = await su.query<{ id: string }>(
    `select id from core.accounts where environment = 'test' and code = $1`,
    [code]
  );
  return result.rows[0]?.id as string;
}

/** Runs SQL as the superuser with triggers and foreign keys disabled. */
async function bypassingInvariants(work: (client: Client) => Promise<void>): Promise<void> {
  await su.query('begin');
  try {
    await su.query('set local session_replication_role = replica');
    await work(su);
    await su.query('commit');
  } catch (error) {
    await su.query('rollback');
    throw error;
  }
}

async function injectEntry(
  lines: { account: string; direction: string; amount: number; currency: string }[]
): Promise<string> {
  const id = randomUUID();
  const ref = publicId('journalEntry');
  await bypassingInvariants(async (c) => {
    await c.query(
      `insert into core.journal_entries (id, ref, idempotency_key, request_fingerprint, environment, currency, kind, description, source, source_id, created_by)
       values ($1, $2, $3, $3, 'test', 'XOF', 'corrupt', 'injected by integrity test', 'adjustment', $4, 'system:integrity-test')`,
      [id, ref, hex(id), id]
    );
    for (const [i, l] of lines.entries()) {
      await c.query(
        `insert into core.journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, i + 1, l.account, l.direction, l.amount, l.currency]
      );
    }
  });
  injected.entryIds.push(id);
  return ref;
}

beforeAll(async () => {
  ctx = await startLedgerContext();
  su = await connect('superuser');
  merchant = await createMerchant(ctx);
  bankA = await createBankAccount(ctx, 'test', 'XOF');
  bankB = await createBankAccount(ctx, 'test', 'XOF');
});

afterAll(async () => {
  // Remove the injected corruption so the shared database is consistent again.
  await bypassingInvariants(async (c) => {
    await c.query('delete from core.journal_lines where entry_id = any($1)', [injected.entryIds]);
    await c.query('delete from core.journal_entries where id = any($1)', [injected.entryIds]);
    if (injected.tamperedAccountId) {
      await c.query(
        `update core.account_balances set posted_debits_minor = posted_debits_minor - 13
          where account_id = $1 and currency = 'XOF'`,
        [injected.tamperedAccountId]
      );
    }
  });
  await su?.end();
  await ctx?.close();
});

describe('ledger integrity validation', () => {
  it('reports nothing for healthy postings', async () => {
    const { entry } = await post(
      ctx,
      postingInput([line(bankA, 'debit', 500n), line(merchant.payable, 'credit', 500n)], {
        currency: 'XOF',
        merchantId: merchant.id,
      })
    );
    const report = await ctx.integrity.check();
    expect(report.invalidEntries.map((e) => e.entryRef)).not.toContain(entry.ref);
    const codes = [bankA, bankB, merchant.payable];
    expect(report.balanceMismatches.filter((m) => codes.includes(m.accountCode))).toEqual([]);
    expect(report.negativeMerchantBalances.filter((m) => codes.includes(m.accountCode))).toEqual(
      []
    );
    expect(report.unbalancedTotals.filter((t) => t.currency === 'XOF')).toEqual([]);
  });

  it('finds every kind of corruption the database would have refused', async () => {
    const [idA, idB] = [await accountId(bankA), await accountId(bankB)];

    // An entry with one line: too few lines, unbalanced, and a balance the journal disagrees with.
    const oneLine = await injectEntry([
      { account: idA, direction: 'debit', amount: 50, currency: 'XOF' },
    ]);
    // A balanced entry whose lines are in another currency than the entry.
    const foreign = await injectEntry([
      { account: idB, direction: 'debit', amount: 9, currency: 'XAF' },
      { account: idB, direction: 'credit', amount: 9, currency: 'XAF' },
    ]);
    // A balance changed without a journal line.
    await bypassingInvariants(async (c) => {
      await c.query(
        `update core.account_balances set posted_debits_minor = posted_debits_minor + 13
          where account_id = $1 and currency = 'XOF'`,
        [idA]
      );
    });
    injected.tamperedAccountId = idA;
    // Legitimate postings that still need attention: money in suspense, and a merchant
    // taken negative by an explicitly allowed posting.
    const suspense = await post(
      ctx,
      postingInput([line(SUSPENSE, 'debit', 99n), line(bankB, 'credit', 99n)], { currency: 'XOF' })
    );
    await post(
      ctx,
      postingInput([line(merchant.reserve, 'debit', 40n), line(bankB, 'credit', 40n)], {
        currency: 'XOF',
        merchantId: merchant.id,
        allowNegativeMerchantBalance: true,
      })
    );

    const report = await ctx.integrity.check();
    expect(report.ok).toBe(false);
    expect(report.invalidEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryRef: oneLine,
          reasons: ['too_few_lines', 'unbalanced'],
          lineCount: 1,
          debitsMinor: 50n,
          creditsMinor: 0n,
        }),
        expect.objectContaining({ entryRef: foreign, reasons: ['currency_mismatch'] }),
      ])
    );
    expect(report.balanceMismatches).toEqual(
      expect.arrayContaining([
        {
          accountCode: bankA,
          environment: 'test',
          currency: 'XOF',
          recordedDebitsMinor: 500n + 13n,
          recordedCreditsMinor: 0n,
          journalDebitsMinor: 500n + 50n,
          journalCreditsMinor: 0n,
        },
        {
          accountCode: bankB,
          environment: 'test',
          currency: 'XAF',
          recordedDebitsMinor: 0n,
          recordedCreditsMinor: 0n,
          journalDebitsMinor: 9n,
          journalCreditsMinor: 9n,
        },
      ])
    );
    expect(report.nonZeroSuspense).toContainEqual({
      accountCode: SUSPENSE,
      environment: 'test',
      currency: 'XOF',
      balanceMinor: 99n,
    });
    expect(report.negativeMerchantBalances).toContainEqual({
      accountCode: merchant.reserve,
      environment: 'test',
      currency: 'XOF',
      balanceMinor: -40n,
    });
    expect(report.unbalancedTotals).toContainEqual(
      expect.objectContaining({ environment: 'test', currency: 'XOF' })
    );
    const totals = report.unbalancedTotals.find(
      (t) => t.currency === 'XOF' && t.environment === 'test'
    );
    expect((totals?.debitsMinor ?? 0n) - (totals?.creditsMinor ?? 0n)).toBe(13n);

    // The entry scan honours its window, so partitions outside it are not read.
    const later = new Date(Date.now() + 86_400_000);
    const outside = await ctx.integrity.check({ from: later, to: new Date(later.getTime() + 1) });
    expect(outside.invalidEntries).toEqual([]);
    expect(outside.window.from).toEqual(later);

    // Clearing the legitimate findings the normal way leaves only the injected ones.
    await ctx.unitOfWork.run((tx) =>
      ctx.reversal.reverseEntry(tx, {
        entry: { ref: suspense.entry.ref },
        reason: 'Identified the suspense item',
        createdBy: SYSTEM_ACTOR,
      })
    );
    await post(
      ctx,
      postingInput([line(bankB, 'debit', 40n), line(merchant.reserve, 'credit', 40n)], {
        currency: 'XOF',
        merchantId: merchant.id,
      })
    );
    const cleared = await ctx.integrity.check();
    expect(cleared.nonZeroSuspense.filter((s) => s.currency === 'XOF')).toEqual([]);
    expect(
      cleared.negativeMerchantBalances.filter((m) => m.accountCode === merchant.reserve)
    ).toEqual([]);
  });

  it('reports the trial balance of an environment and currency', async () => {
    const trial = await ctx.integrity.trialBalance('test', 'XOF');
    expect(trial.environment).toBe('test');
    expect(trial.accounts.find((a) => a.accountCode === merchant.payable)?.balanceMinor).toBe(500n);
    // The tampered balance from the previous test is still in place until afterAll.
    expect(trial.totalDebitsMinor - trial.totalCreditsMinor).toBe(13n);
    expect(trial.balanced).toBe(false);
  });
});
