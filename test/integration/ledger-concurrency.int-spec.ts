/**
 * Phase 2 concurrency (spec 12): parallel postings against real Postgres. Identical
 * postings produce one entry, parallel debits cannot overdraw a merchant, parallel
 * reversals produce one reversal, and opposite line orders do not deadlock (spec 5.3
 * rule 8).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import {
  createBankAccount,
  createMerchant,
  line,
  post,
  postedMinor,
  postingInput,
  startLedgerContext,
  SYSTEM_ACTOR,
  type LedgerContext,
} from '../support/ledger';

let ctx: LedgerContext;

beforeAll(async () => {
  ctx = await startLedgerContext({ DB_POOL_MAX: '30' });
});

afterAll(async () => {
  await ctx?.close();
});

function codeOf(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'ok';
  return result.reason instanceof AppError ? result.reason.code : String(result.reason);
}

describe('ledger concurrency', () => {
  it('posts 25 identical parallel postings exactly once', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    const input = postingInput(
      [line(bank, 'debit', 1_234n), line(merchant.payable, 'credit', 1_234n)],
      {
        merchantId: merchant.id,
        source: 'payment',
      }
    );
    const results = await Promise.all(Array.from({ length: 25 }, () => post(ctx, input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry.ref)).size).toBe(1);
    expect(await postedMinor(ctx, bank)).toBe(1_234n);
    expect(await postedMinor(ctx, merchant.payable)).toBe(1_234n);
  });

  it('never overdraws a merchant under 20 parallel debits', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    await post(
      ctx,
      postingInput([line(bank, 'debit', 1_000n), line(merchant.payable, 'credit', 1_000n)], {
        merchantId: merchant.id,
      })
    );
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        post(
          ctx,
          postingInput([line(merchant.payable, 'debit', 100n), line(bank, 'credit', 100n)], {
            merchantId: merchant.id,
            source: 'payout',
          })
        )
      )
    );
    const codes = results.map(codeOf);
    expect(codes.filter((c) => c === 'ok')).toHaveLength(10);
    expect(codes.filter((c) => c === 'INSUFFICIENT_BALANCE')).toHaveLength(10);
    expect(await postedMinor(ctx, merchant.payable)).toBe(0n);
    expect(await postedMinor(ctx, bank)).toBe(0n);
  });

  it('reverses an entry once under 10 parallel reversals', async () => {
    const bankA = await createBankAccount(ctx);
    const bankB = await createBankAccount(ctx);
    const original = await post(
      ctx,
      postingInput([line(bankA, 'debit', 77n), line(bankB, 'credit', 77n)])
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ctx.unitOfWork.run((tx) =>
          ctx.reversal.reverseEntry(tx, {
            entry: { ref: original.entry.ref },
            reason: `parallel reversal ${i}`,
            createdBy: SYSTEM_ACTOR,
          })
        )
      )
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry.ref)).size).toBe(1);
    expect(await postedMinor(ctx, bankA)).toBe(0n);
    expect(await postedMinor(ctx, bankB)).toBe(0n);
  });

  it('does not deadlock when parallel entries list the same accounts in opposite orders', async () => {
    const accounts = await Promise.all([1, 2, 3, 4].map(() => createBankAccount(ctx)));
    const [a, b, c, d] = accounts as [string, string, string, string];
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => {
        const forward = [
          line(a, 'debit', 10n),
          line(b, 'credit', 5n),
          line(c, 'debit', 5n),
          line(d, 'credit', 10n),
        ];
        const lines = i % 2 === 0 ? forward : [...forward].reverse();
        return post(ctx, postingInput(lines, { sourceId: randomUUID() }));
      })
    );
    expect(results.map(codeOf).filter((c) => c !== 'ok')).toEqual([]);
    expect(await postedMinor(ctx, a)).toBe(400n);
    expect(await postedMinor(ctx, b)).toBe(-200n);
    expect(await postedMinor(ctx, c)).toBe(200n);
    expect(await postedMinor(ctx, d)).toBe(-400n);
  });
});
