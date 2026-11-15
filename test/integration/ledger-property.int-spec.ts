/**
 * Phase 2 property suite (spec 12): ledger invariants under thousands of randomised
 * operations against real Postgres, checked against an in-memory model after every step.
 *
 *   - every accepted entry balances, and balances equal the sum of journal lines;
 *   - a merchant balance never goes negative: a debit is refused exactly when the model
 *     says it would overdraw, and a refused operation changes nothing;
 *   - a replay is a no-op, a conflicting replay is refused, an unbalanced posting is refused;
 *   - a reversal restores the prior balances exactly, and a second reversal is a replay.
 *
 * The sequence is deterministic: LEDGER_PROPERTY_SEED and LEDGER_PROPERTY_OPS reproduce a
 * failure. The suite uses only accounts it creates, so other test files cannot disturb it.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import type { CurrencyCode } from '../../src/common/money/currency-codes';
import type { PostEntryInput, PostingLineInput } from '../../src/modules/ledger/domain/posting';
import type { JournalEntry } from '../../src/modules/ledger/journal-entry';
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

const SEED = Number(process.env.LEDGER_PROPERTY_SEED ?? 20_260_301);
const OPS = Number(process.env.LEDGER_PROPERTY_OPS ?? 2_000);
const CURRENCIES: CurrencyCode[] = ['UGX', 'KES'];

/** mulberry32: small, fast, deterministic. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

interface Totals {
  debits: bigint;
  credits: bigint;
}

let ctx: LedgerContext;
let rw: Client;

beforeAll(async () => {
  ctx = await startLedgerContext();
  rw = await connect('rw');
});

afterAll(async () => {
  await rw?.end();
  await ctx?.close();
});

describe(`ledger property suite (seed ${SEED}, ${OPS} operations)`, () => {
  it('keeps every invariant under random operations', { timeout: 600_000 }, async () => {
    const random = prng(SEED);
    const merchants: TestMerchant[] = [];
    for (let i = 0; i < 3; i++) merchants.push(await createMerchant(ctx));
    const banks: Record<CurrencyCode, [string, string]> = {} as never;
    for (const currency of CURRENCIES) {
      banks[currency] = [
        await createBankAccount(ctx, 'test', currency),
        await createBankAccount(ctx, 'test', currency),
      ];
    }
    const merchantCodes = new Set(merchants.flatMap((m) => [m.payable, m.reserve]));
    const ownCodes = [...merchantCodes, ...CURRENCIES.flatMap((c) => banks[c])];

    // The model: posted debits and credits per (account code, currency).
    const model = new Map<string, Totals>();
    const key = (code: string, currency: string) => `${code}|${currency}`;
    const get = (code: string, currency: string): Totals =>
      model.get(key(code, currency)) ?? { debits: 0n, credits: 0n };
    const balanceOf = (code: string, currency: string) => {
      const t = get(code, currency);
      return merchantCodes.has(code) ? t.credits - t.debits : t.debits - t.credits;
    };
    const apply = (lines: readonly PostingLineInput[], currency: string) => {
      for (const l of lines) {
        const t = get(l.accountCode, currency);
        model.set(key(l.accountCode, currency), {
          debits: t.debits + (l.direction === 'debit' ? l.amountMinor : 0n),
          credits: t.credits + (l.direction === 'credit' ? l.amountMinor : 0n),
        });
      }
    };
    /** True when applying `lines` would take a merchant account below zero by lowering it. */
    const wouldOverdraw = (lines: readonly PostingLineInput[], currency: string) => {
      const change = new Map<string, bigint>();
      for (const l of lines) {
        if (!merchantCodes.has(l.accountCode)) continue;
        const signed = l.direction === 'credit' ? l.amountMinor : -l.amountMinor;
        change.set(l.accountCode, (change.get(l.accountCode) ?? 0n) + signed);
      }
      return [...change].some(
        ([code, delta]) => delta < 0n && balanceOf(code, currency) + delta < 0n
      );
    };

    const posted: { input: PostEntryInput; entry: JournalEntry; reversed: boolean }[] = [];
    const stats: Record<string, number> = {};
    const count = (name: string) => (stats[name] = (stats[name] ?? 0) + 1);

    async function attempt(
      input: PostEntryInput
    ): Promise<{ entry: JournalEntry; replayed: boolean } | AppError> {
      try {
        return await post(ctx, input);
      } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
      }
    }

    async function dbBalances(): Promise<Map<string, Totals>> {
      const result = await rw.query<{
        code: string;
        currency: string;
        posted_debits_minor: string;
        posted_credits_minor: string;
      }>(
        `select a.code, b.currency, b.posted_debits_minor, b.posted_credits_minor
           from core.account_balances b join core.accounts a on a.id = b.account_id
          where a.environment = 'test' and a.code = any($1)`,
        [ownCodes]
      );
      return new Map(
        result.rows.map((r) => [
          key(r.code, r.currency),
          { debits: BigInt(r.posted_debits_minor), credits: BigInt(r.posted_credits_minor) },
        ])
      );
    }

    async function expectModelMatchesDatabase(step: number, op: string) {
      const db = await dbBalances();
      const keys = new Set([...db.keys(), ...model.keys()]);
      for (const k of keys) {
        const actual = db.get(k) ?? { debits: 0n, credits: 0n };
        const expected = model.get(k) ?? { debits: 0n, credits: 0n };
        expect(actual, `step ${step} (${op}) ${k}`).toEqual(expected);
      }
      for (const code of merchantCodes) {
        for (const currency of CURRENCIES) {
          expect(
            balanceOf(code, currency) >= 0n,
            `step ${step} (${op}) ${code} ${currency} negative`
          ).toBe(true);
        }
      }
    }

    const amount = () => BigInt(random.int(1, 100_000));

    for (let step = 0; step < OPS; step++) {
      const currency = random.pick(CURRENCIES);
      const [bankA, bankB] = banks[currency];
      const merchant = random.pick(merchants);
      const roll = random.next();
      let op: string;

      if (roll < 0.3) {
        op = 'collect';
        const gross = amount();
        const fee = random.next() < 0.5 ? BigInt(random.int(0, Number(gross) - 1)) : 0n;
        const lines = [line(bankA, 'debit', gross), line(merchant.payable, 'credit', gross)];
        if (fee > 0n) lines.push(line(merchant.payable, 'debit', fee), line(bankB, 'credit', fee));
        const input = postingInput(lines, { currency, merchantId: merchant.id, source: 'payment' });
        const result = await attempt(input);
        expect(result, `step ${step} collect`).not.toBeInstanceOf(AppError);
        apply(lines, currency);
        posted.push({ input, entry: (result as { entry: JournalEntry }).entry, reversed: false });
      } else if (roll < 0.6) {
        const kind = random.pick(['payout', 'reserve', 'release'] as const);
        op = kind;
        const x = amount();
        const lines =
          kind === 'payout'
            ? [line(merchant.payable, 'debit', x), line(bankA, 'credit', x)]
            : kind === 'reserve'
              ? [line(merchant.payable, 'debit', x), line(merchant.reserve, 'credit', x)]
              : [line(merchant.reserve, 'debit', x), line(merchant.payable, 'credit', x)];
        const input = postingInput(lines, { currency, merchantId: merchant.id, source: 'payout' });
        const overdraw = wouldOverdraw(lines, currency);
        const result = await attempt(input);
        if (overdraw) {
          expect((result as AppError).code, `step ${step} ${kind}`).toBe('INSUFFICIENT_BALANCE');
          count(`${kind}_refused`);
        } else {
          expect(result, `step ${step} ${kind}`).not.toBeInstanceOf(AppError);
          apply(lines, currency);
          posted.push({ input, entry: (result as { entry: JournalEntry }).entry, reversed: false });
        }
      } else if (roll < 0.72) {
        op = 'reverse';
        const candidates = posted.filter((p) => !p.reversed);
        if (candidates.length === 0) continue;
        const target = random.pick(candidates);
        const flipped = target.entry.lines.map((l) =>
          line(l.accountCode, l.direction === 'debit' ? 'credit' : 'debit', l.amountMinor)
        );
        const overdraw = wouldOverdraw(flipped, target.input.currency);
        let result: unknown;
        try {
          result = await ctx.unitOfWork.run((tx) =>
            ctx.reversal.reverseEntry(tx, {
              entry: { ref: target.entry.ref },
              reason: `property step ${step}`,
              createdBy: SYSTEM_ACTOR,
            })
          );
        } catch (error) {
          result = error;
        }
        if (overdraw) {
          expect((result as AppError).code, `step ${step} reverse`).toBe('INSUFFICIENT_BALANCE');
          count('reverse_refused');
        } else {
          expect((result as { replayed: boolean }).replayed, `step ${step} reverse`).toBe(false);
          apply(flipped, target.input.currency);
          target.reversed = true;
          // Reversing again is a replay of the same reversal.
          const again = await ctx.unitOfWork.run((tx) =>
            ctx.reversal.reverseEntry(tx, {
              entry: { id: target.entry.id },
              reason: 'again',
              createdBy: SYSTEM_ACTOR,
            })
          );
          expect(again.replayed).toBe(true);
          expect(again.entry.ref).toBe((result as { entry: JournalEntry }).entry.ref);
        }
      } else if (roll < 0.8) {
        op = 'replay';
        if (posted.length === 0) continue;
        const target = random.pick(posted);
        const result = await attempt(target.input);
        expect((result as { replayed: boolean }).replayed, `step ${step} replay`).toBe(true);
        expect((result as { entry: JournalEntry }).entry.ref).toBe(target.entry.ref);
      } else if (roll < 0.86) {
        op = 'conflict';
        if (posted.length === 0) continue;
        const target = random.pick(posted);
        const [a, b] = banks[target.input.currency as CurrencyCode];
        const result = await attempt({
          ...target.input,
          lines: [line(a, 'debit', 1n), line(b, 'credit', 1n)],
        });
        expect((result as AppError).code, `step ${step} conflict`).toBe(
          'LEDGER_IDEMPOTENCY_CONFLICT'
        );
      } else if (roll < 0.92) {
        op = 'unbalanced';
        const x = amount();
        const result = await attempt(
          postingInput([line(bankA, 'debit', x), line(merchant.payable, 'credit', x + 1n)], {
            currency,
            merchantId: merchant.id,
          })
        );
        expect((result as AppError).code, `step ${step} unbalanced`).toBe(
          'LEDGER_ENTRY_UNBALANCED'
        );
      } else {
        op = 'round_trip';
        const before = await dbBalances();
        const x = amount();
        const lines = [
          line(bankA, 'debit', x),
          line(merchant.payable, 'credit', x),
          line(merchant.payable, 'debit', x / 2n || 1n),
          line(merchant.reserve, 'credit', x / 2n || 1n),
        ];
        const { entry } = await post(
          ctx,
          postingInput(lines, { currency, merchantId: merchant.id })
        );
        await ctx.unitOfWork.run((tx) =>
          ctx.reversal.reverseEntry(tx, {
            entry: { ref: entry.ref },
            reason: 'round trip',
            createdBy: SYSTEM_ACTOR,
          })
        );
        const after = await dbBalances();
        for (const [k, totals] of after) {
          const prior = before.get(k) ?? { debits: 0n, credits: 0n };
          // Totals only grow, so the restored balance shows as equal growth on both sides.
          expect(totals.debits - prior.debits, `step ${step} round trip ${k}`).toBe(
            totals.credits - prior.credits
          );
        }
        apply(lines, currency);
        apply(
          lines.map((l) =>
            line(l.accountCode, l.direction === 'debit' ? 'credit' : 'debit', l.amountMinor)
          ),
          currency
        );
      }
      count(op);
      await expectModelMatchesDatabase(step, op);
    }

    // Every operation type ran, including refusals.
    for (const name of [
      'collect',
      'payout',
      'payout_refused',
      'reserve',
      'release',
      'reverse',
      'replay',
      'conflict',
      'unbalanced',
      'round_trip',
    ]) {
      expect(stats[name] ?? 0, `${name} never ran: ${JSON.stringify(stats)}`).toBeGreaterThan(0);
    }

    // The journal agrees with the balances, and every entry of the run balances.
    const journal = await rw.query<{
      code: string;
      currency: string;
      debits: string;
      credits: string;
    }>(
      `select a.code, l.currency,
              coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)::text as debits,
              coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)::text as credits
         from core.journal_lines l join core.accounts a on a.id = l.account_id
        where a.environment = 'test' and a.code = any($1)
        group by a.code, l.currency`,
      [ownCodes]
    );
    for (const row of journal.rows) {
      expect({ debits: BigInt(row.debits), credits: BigInt(row.credits) }).toEqual(
        get(row.code, row.currency)
      );
    }
    const report = await ctx.integrity.check();
    const ownRefs = new Set(posted.map((p) => p.entry.ref));
    expect(report.invalidEntries.filter((e) => ownRefs.has(e.entryRef))).toEqual([]);
    expect(report.balanceMismatches.filter((m) => ownCodes.includes(m.accountCode))).toEqual([]);
    expect(report.negativeMerchantBalances.filter((m) => merchantCodes.has(m.accountCode))).toEqual(
      []
    );
  });
});
