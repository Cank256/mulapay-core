/**
 * Phase 2: posting and reversal through the services, against real Postgres.
 *
 * Covers the seeded chart of accounts, merchant account provisioning, canonical postings
 * (spec 5.5), idempotent replay, every refusal path, the no-negative-merchant-balance rule,
 * reversals, transaction atomicity and the ledger-backed merchant close check.
 *
 * Shared platform accounts are used here in the live environment only; other ledger test
 * files use the test environment with their own accounts, so balance deltas here are exact.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { isPublicId } from '../../src/common/ids/ids';
import { CURRENCY_EXPONENTS } from '../../src/common/money/currency-codes';
import { seededAccounts } from '../../src/modules/accounts/domain/chart-of-accounts';
import { OnboardingService } from '../../src/modules/merchants/onboarding.service';
import {
  connect,
  createBankAccount,
  createMerchant,
  line,
  post,
  postedMinor,
  postingInput,
  startLedgerContext,
  SYSTEM_ACTOR,
  type LedgerContext,
  type TestMerchant,
} from '../support/ledger';

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

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

async function keyExists(idempotencyKey: string): Promise<boolean> {
  const result = await rw.query(
    'select 1 from core.journal_entry_keys where idempotency_key = $1',
    [idempotencyKey]
  );
  return result.rowCount === 1;
}

const CLEARING = '1000:provider_clearing:mtn';
const FEES = '4000:fee_revenue';
const PROVIDER_FEES = '5000:provider_fee_expense';

describe('seeded data', () => {
  it('seeds the currencies of spec 3.8 with their exponents', async () => {
    const result = await rw.query<{ code: string; exponent: number; is_zero_decimal: boolean }>(
      'select code, exponent, is_zero_decimal from core.currencies'
    );
    const seeded = Object.fromEntries(result.rows.map((r) => [r.code, r.exponent]));
    expect(seeded).toEqual(CURRENCY_EXPONENTS);
    for (const row of result.rows) expect(row.is_zero_decimal).toBe(row.exponent === 0);
  });

  it('seeds the platform and provider chart of accounts in both environments', async () => {
    const result = await rw.query<{
      environment: string;
      code: string;
      ref: string;
      id: string;
      is_system: boolean;
    }>(
      'select environment, code, ref, id, is_system from core.accounts where merchant_id is null and purpose <> $1',
      ['bank']
    );
    const expected = seededAccounts()
      .map((a) => a.code)
      .sort();
    for (const environment of ['test', 'live']) {
      expect(
        result.rows
          .filter((r) => r.environment === environment)
          .map((r) => r.code)
          .sort()
      ).toEqual(expected);
    }
    for (const row of result.rows) {
      expect(isPublicId('account', row.ref)).toBe(true);
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(row.is_system).toBe(true);
    }
  });
});

describe('merchant accounts', () => {
  it('opens payable and reserve accounts in both environments when a merchant is created', async () => {
    const merchant = await createMerchant(ctx);
    const accounts = await ctx.accounts.listForMerchant(merchant.id);
    expect(
      accounts.map((a) => [a.environment, a.code, a.type, a.normalBalance, a.isSystem])
    ).toEqual([
      ['live', merchant.payable, 'liability', 'credit', false],
      ['live', merchant.reserve, 'liability', 'credit', false],
      ['test', merchant.payable, 'liability', 'credit', false],
      ['test', merchant.reserve, 'liability', 'credit', false],
    ]);
  });

  it('opens them for self-registered merchants too, and opening again is a no-op', async () => {
    const onboarding = ctx.app.get(OnboardingService, { strict: false });
    const registration = await onboarding.register({
      email: `ledger.${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      name: 'Ledger Owner',
      merchant: { legalName: 'Self Registered Ltd', country: 'UG', defaultCurrency: 'UGX' },
    });
    const row = await ctx.merchantsRepository.findByRef(registration.merchant.id);
    expect(row).toBeDefined();
    const before = await ctx.accounts.listForMerchant(row!.id);
    expect(before).toHaveLength(4);
    await ctx.unitOfWork.run((tx) => ctx.accounts.openMerchantAccounts(tx, row!));
    expect(await ctx.accounts.listForMerchant(row!.id)).toEqual(before);
  });

  it('opens a bank account once per code', async () => {
    const code = await createBankAccount(ctx, 'test', 'KES');
    const key = code.split(':')[2] as string;
    const again = await ctx.unitOfWork.run((tx) =>
      ctx.accounts.openBankAccount(tx, {
        environment: 'test',
        bankKey: key,
        name: 'renamed',
        currency: 'KES',
      })
    );
    expect(again.code).toBe(code);
    expect(again.name).toBe(`Test bank ${key}`);
    expect(again.currency).toBe('KES');
  });
});

describe('postEntry', () => {
  let merchant: TestMerchant;
  beforeAll(async () => {
    merchant = await createMerchant(ctx);
  });

  it('posts the canonical collection entry and moves every balance as intended (spec 5.5)', async () => {
    const before = {
      clearing: await postedMinor(ctx, CLEARING, 'UGX', 'live'),
      fees: await postedMinor(ctx, FEES, 'UGX', 'live'),
      providerFees: await postedMinor(ctx, PROVIDER_FEES, 'UGX', 'live'),
    };
    const [G, F, P] = [100_000n, 2_900n, 1_000n];
    const input = postingInput(
      [
        line(CLEARING, 'debit', G),
        line(merchant.payable, 'credit', G),
        line(merchant.payable, 'debit', F),
        line(FEES, 'credit', F),
        line(PROVIDER_FEES, 'debit', P),
        line(CLEARING, 'credit', P),
      ],
      {
        environment: 'live',
        source: 'payment',
        kind: 'collection.succeeded',
        merchantId: merchant.id,
        transactionId: randomUUID(),
      }
    );
    const { entry, replayed } = await post(ctx, input);
    expect(replayed).toBe(false);
    expect(isPublicId('journalEntry', entry.ref)).toBe(true);
    expect(entry).toMatchObject({
      environment: 'live',
      currency: 'UGX',
      source: 'payment',
      sourceId: input.sourceId,
      kind: 'collection.succeeded',
      merchantId: merchant.id,
      transactionId: input.transactionId,
      reversesEntryId: null,
      createdBy: 'system:ledger-test',
      idempotencyKey: input.idempotencyKey,
    });
    expect(entry.lines.map((l) => [l.lineNo, l.accountCode, l.direction, l.amountMinor])).toEqual(
      input.lines.map((l, i) => [i + 1, l.accountCode, l.direction, l.amountMinor])
    );

    expect(await postedMinor(ctx, merchant.payable, 'UGX', 'live')).toBe(G - F);
    expect(await postedMinor(ctx, CLEARING, 'UGX', 'live')).toBe(before.clearing + G - P);
    expect(await postedMinor(ctx, FEES, 'UGX', 'live')).toBe(before.fees + F);
    expect(await postedMinor(ctx, PROVIDER_FEES, 'UGX', 'live')).toBe(before.providerFees + P);

    const stored = await rw.query(
      `select l.line_no, l.merchant_id, l.currency, l.created_at = e.created_at as same_partition
         from core.journal_lines l join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
        where e.ref = $1 order by l.line_no`,
      [entry.ref]
    );
    expect(stored.rows.map((r) => r.merchant_id)).toEqual([
      null,
      merchant.id,
      merchant.id,
      null,
      null,
      null,
    ]);
    expect(stored.rows.every((r) => r.currency === 'UGX' && r.same_partition)).toBe(true);
  });

  it('records the provider settlement and the settlement-in-transit round trip', async () => {
    const bank = await createBankAccount(ctx, 'live', 'UGX');
    const settled = await post(
      ctx,
      postingInput([line(bank, 'debit', 50_000n), line(CLEARING, 'credit', 50_000n)], {
        environment: 'live',
        source: 'settlement',
      })
    );
    expect(settled.replayed).toBe(false);
    expect(await postedMinor(ctx, bank, 'UGX', 'live')).toBe(50_000n);
  });

  it('replays the same posting: same entry, nothing posted twice', async () => {
    const bank = await createBankAccount(ctx);
    const input = postingInput(
      [line(bank, 'debit', 700n), line(merchant.payable, 'credit', 700n)],
      {
        merchantId: merchant.id,
      }
    );
    const first = await post(ctx, input);
    const second = await post(ctx, { ...input, description: 'retried with another description' });
    expect(second.replayed).toBe(true);
    expect(second.entry).toEqual(first.entry);
    expect(second.entry.description).toBe('ledger integration test');
    expect(await postedMinor(ctx, bank)).toBe(700n);
    expect(await postedMinor(ctx, merchant.payable)).toBe(700n);
  });

  it('refuses a different posting under a used idempotency key and writes nothing', async () => {
    const bank = await createBankAccount(ctx);
    const input = postingInput([line(bank, 'debit', 100n), line(FEES, 'credit', 100n)]);
    await post(ctx, input);
    const error = await errorOf(
      post(ctx, { ...input, lines: [line(bank, 'debit', 101n), line(FEES, 'credit', 101n)] })
    );
    expect(error.code).toBe('LEDGER_IDEMPOTENCY_CONFLICT');
    expect(await postedMinor(ctx, bank)).toBe(100n);
  });

  it('refuses an unbalanced posting before touching the database', async () => {
    const bank = await createBankAccount(ctx);
    const input = postingInput([line(bank, 'debit', 100n), line(FEES, 'credit', 99n)]);
    const error = await errorOf(post(ctx, input));
    expect(error.code).toBe('LEDGER_ENTRY_UNBALANCED');
    expect(await keyExists(input.idempotencyKey)).toBe(false);
    expect(await postedMinor(ctx, bank)).toBe(0n);
  });

  it('refuses unknown accounts, and accounts of the other environment', async () => {
    const liveBank = await createBankAccount(ctx, 'live');
    for (const code of ['1100:bank:does_not_exist', liveBank]) {
      const error = await errorOf(
        post(ctx, postingInput([line(code, 'debit', 5n), line(FEES, 'credit', 5n)]))
      );
      expect(error.code).toBe('LEDGER_ACCOUNT_NOT_FOUND');
      expect(error.details).toEqual({ code, environment: 'test' });
    }
  });

  it('refuses inactive accounts', async () => {
    const bank = await createBankAccount(ctx);
    await rw.query(
      `update core.accounts set active = false where environment = 'test' and code = $1`,
      [bank]
    );
    const error = await errorOf(
      post(ctx, postingInput([line(bank, 'debit', 5n), line(FEES, 'credit', 5n)]))
    );
    expect(error.code).toBe('LEDGER_ACCOUNT_INACTIVE');
  });

  it('refuses a currency the account does not hold', async () => {
    const kesBank = await createBankAccount(ctx, 'test', 'KES');
    const error = await errorOf(
      post(ctx, postingInput([line(kesBank, 'debit', 5n), line(FEES, 'credit', 5n)]))
    );
    expect(error.details).toEqual({ reason: 'account_currency' });
  });

  it("refuses a merchant account outside that merchant's entry", async () => {
    const other = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    for (const merchantId of [undefined, other.id]) {
      const error = await errorOf(
        post(
          ctx,
          postingInput([line(bank, 'debit', 5n), line(merchant.payable, 'credit', 5n)], {
            ...(merchantId ? { merchantId } : {}),
          })
        )
      );
      expect(error.details).toEqual({ reason: 'merchant_account' });
    }
  });

  it('refuses reversal as a direct source', async () => {
    const error = await errorOf(
      post(
        ctx,
        postingInput([line(FEES, 'debit', 5n), line(FEES, 'credit', 5n)], {
          source: 'reversal' as never,
        })
      )
    );
    expect(error.details).toEqual({ reason: 'source' });
  });

  it('is atomic with the caller: a failed business transaction leaves no trace', async () => {
    const bank = await createBankAccount(ctx);
    const input = postingInput([line(bank, 'debit', 900n), line(FEES, 'credit', 900n)]);
    await expect(
      ctx.unitOfWork.run(async (tx) => {
        await ctx.posting.postEntry(tx, input);
        throw new Error('business step failed after posting');
      })
    ).rejects.toThrow('business step failed after posting');
    expect(await keyExists(input.idempotencyKey)).toBe(false);
    expect(await postedMinor(ctx, bank)).toBe(0n);
  });
});

describe('merchant balances never go negative by default (spec 5.3 rule 7)', () => {
  it('refuses a debit beyond the posted balance, and allows up to it', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    await post(
      ctx,
      postingInput([line(bank, 'debit', 1_000n), line(merchant.payable, 'credit', 1_000n)], {
        merchantId: merchant.id,
      })
    );
    const overdraw = postingInput(
      [line(merchant.payable, 'debit', 1_001n), line(bank, 'credit', 1_001n)],
      { merchantId: merchant.id, source: 'payout' }
    );
    expect((await errorOf(post(ctx, overdraw))).code).toBe('INSUFFICIENT_BALANCE');
    expect(await keyExists(overdraw.idempotencyKey)).toBe(false);
    expect(await postedMinor(ctx, merchant.payable)).toBe(1_000n);

    await post(
      ctx,
      postingInput([line(merchant.payable, 'debit', 1_000n), line(bank, 'credit', 1_000n)], {
        merchantId: merchant.id,
        source: 'payout',
      })
    );
    expect(await postedMinor(ctx, merchant.payable)).toBe(0n);
  });

  it('checks the net effect per account, not each line', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    // Debit 500 and credit 800 on the same payable in one entry: net +300, allowed from zero.
    await post(
      ctx,
      postingInput(
        [
          line(merchant.payable, 'debit', 500n),
          line(bank, 'debit', 300n),
          line(merchant.payable, 'credit', 800n),
        ],
        { merchantId: merchant.id }
      )
    );
    expect(await postedMinor(ctx, merchant.payable)).toBe(300n);
  });

  it('allows a negative balance only when the caller says so, then allows paying it back', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    await post(
      ctx,
      postingInput([line(merchant.reserve, 'debit', 250n), line(bank, 'credit', 250n)], {
        merchantId: merchant.id,
        allowNegativeMerchantBalance: true,
      })
    );
    expect(await postedMinor(ctx, merchant.reserve)).toBe(-250n);
    // A credit that leaves it still negative is allowed: it reduces what the merchant owes.
    await post(
      ctx,
      postingInput([line(bank, 'debit', 100n), line(merchant.reserve, 'credit', 100n)], {
        merchantId: merchant.id,
      })
    );
    expect(await postedMinor(ctx, merchant.reserve)).toBe(-150n);
    await post(
      ctx,
      postingInput([line(bank, 'debit', 150n), line(merchant.reserve, 'credit', 150n)], {
        merchantId: merchant.id,
      })
    );
    expect(await postedMinor(ctx, merchant.reserve)).toBe(0n);
  });
});

describe('reverseEntry', () => {
  it('posts the mirror entry, restores every balance exactly and mutates nothing', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    const original = await post(
      ctx,
      postingInput(
        [
          line(bank, 'debit', 10_000n),
          line(merchant.payable, 'credit', 10_000n),
          line(merchant.payable, 'debit', 300n),
          line(merchant.reserve, 'credit', 300n),
        ],
        { merchantId: merchant.id, transactionId: randomUUID(), source: 'payment' }
      )
    );
    const snapshot = await rw.query('select * from core.journal_entries where ref = $1', [
      original.entry.ref,
    ]);

    const reversal = await ctx.unitOfWork.run((tx) =>
      ctx.reversal.reverseEntry(tx, {
        entry: { ref: original.entry.ref },
        reason: 'Duplicate collection',
        createdBy: { type: 'user', id: 'usr_01JTESTREVIEWER0000000000' },
      })
    );
    expect(reversal.replayed).toBe(false);
    expect(reversal.entry).toMatchObject({
      source: 'reversal',
      sourceId: original.entry.ref,
      kind: 'reversal',
      description: 'Duplicate collection',
      reversesEntryId: original.entry.id,
      merchantId: merchant.id,
      transactionId: original.entry.transactionId,
      currency: 'UGX',
      environment: 'test',
    });
    expect(reversal.entry.lines.map((l) => [l.accountCode, l.direction, l.amountMinor])).toEqual([
      [bank, 'credit', 10_000n],
      [merchant.payable, 'debit', 10_000n],
      [merchant.payable, 'credit', 300n],
      [merchant.reserve, 'debit', 300n],
    ]);
    expect(await postedMinor(ctx, bank)).toBe(0n);
    expect(await postedMinor(ctx, merchant.payable)).toBe(0n);
    expect(await postedMinor(ctx, merchant.reserve)).toBe(0n);
    const after = await rw.query('select * from core.journal_entries where ref = $1', [
      original.entry.ref,
    ]);
    expect(after.rows).toEqual(snapshot.rows);

    // Asking again returns the same reversal, whatever the reason; by id works too.
    const again = await ctx.unitOfWork.run((tx) =>
      ctx.reversal.reverseEntry(tx, {
        entry: { id: original.entry.id },
        reason: 'Another reason',
        createdBy: SYSTEM_ACTOR,
      })
    );
    expect(again.replayed).toBe(true);
    expect(again.entry.ref).toBe(reversal.entry.ref);
    expect(await postedMinor(ctx, bank)).toBe(0n);

    const reverseReversal = await errorOf(
      ctx.unitOfWork.run((tx) =>
        ctx.reversal.reverseEntry(tx, {
          entry: { ref: reversal.entry.ref },
          reason: 'x',
          createdBy: SYSTEM_ACTOR,
        })
      )
    );
    expect(reverseReversal.code).toBe('LEDGER_ENTRY_NOT_REVERSIBLE');
  });

  it('reports an unknown entry as not found', async () => {
    const error = await errorOf(
      ctx.unitOfWork.run((tx) =>
        ctx.reversal.reverseEntry(tx, {
          entry: { ref: 'je_01JZZZZZZZZZZZZZZZZZZZZZZZ' },
          reason: 'x',
          createdBy: SYSTEM_ACTOR,
        })
      )
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('will not take a merchant negative unless allowed', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    const collection = await post(
      ctx,
      postingInput([line(bank, 'debit', 800n), line(merchant.payable, 'credit', 800n)], {
        merchantId: merchant.id,
      })
    );
    await post(
      ctx,
      postingInput([line(merchant.payable, 'debit', 500n), line(bank, 'credit', 500n)], {
        merchantId: merchant.id,
        source: 'payout',
      })
    );
    const reverse = (allowNegativeMerchantBalance?: boolean) =>
      ctx.unitOfWork.run((tx) =>
        ctx.reversal.reverseEntry(tx, {
          entry: { ref: collection.entry.ref },
          reason: 'Chargeback',
          createdBy: SYSTEM_ACTOR,
          ...(allowNegativeMerchantBalance ? { allowNegativeMerchantBalance } : {}),
        })
      );
    expect((await errorOf(reverse())).code).toBe('INSUFFICIENT_BALANCE');
    expect(await postedMinor(ctx, merchant.payable)).toBe(300n);
    await reverse(true);
    expect(await postedMinor(ctx, merchant.payable)).toBe(-500n);
    // Clear the negative position so the integrity suite sees no finding for it.
    await post(
      ctx,
      postingInput([line(bank, 'debit', 500n), line(merchant.payable, 'credit', 500n)], {
        merchantId: merchant.id,
      })
    );
  });
});

describe('balances and merchant close', () => {
  it('reads balances per account and per merchant', async () => {
    const merchant = await createMerchant(ctx);
    const bank = await createBankAccount(ctx);
    await post(
      ctx,
      postingInput([line(bank, 'debit', 42n), line(merchant.payable, 'credit', 42n)], {
        merchantId: merchant.id,
      })
    );
    expect(await ctx.balances.forMerchant(merchant.id, 'test')).toEqual([
      {
        accountCode: merchant.payable,
        currency: 'UGX',
        postedDebitsMinor: 0n,
        postedCreditsMinor: 42n,
        postedMinor: 42n,
      },
    ]);
    expect(await ctx.balances.forMerchant(merchant.id, 'live')).toEqual([]);
    await expect(ctx.balances.forAccount('test', '1100:bank:missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to close a merchant with a live balance; test balances do not count', async () => {
    const merchant = await createMerchant(ctx);
    const testBank = await createBankAccount(ctx, 'test');
    const liveBank = await createBankAccount(ctx, 'live');
    await post(
      ctx,
      postingInput([line(testBank, 'debit', 10n), line(merchant.payable, 'credit', 10n)], {
        merchantId: merchant.id,
      })
    );
    const live = await post(
      ctx,
      postingInput([line(liveBank, 'debit', 10n), line(merchant.payable, 'credit', 10n)], {
        merchantId: merchant.id,
        environment: 'live',
      })
    );
    const closeError = await errorOf(ctx.merchants.transition(merchant.ref, 'close', 'test'));
    expect(closeError.code).toBe('MERCHANT_BALANCE_NOT_ZERO');

    await ctx.unitOfWork.run((tx) =>
      ctx.reversal.reverseEntry(tx, {
        entry: { ref: live.entry.ref },
        reason: 'Return funds before closing',
        createdBy: SYSTEM_ACTOR,
      })
    );
    const closed = await ctx.merchants.transition(merchant.ref, 'close', 'test');
    expect(closed.status).toBe('closed');
  });

  it('produces a balanced trial balance that includes posted accounts', async () => {
    const trial = await ctx.integrity.trialBalance('live', 'UGX');
    expect(trial.balanced).toBe(true);
    expect(trial.totalDebitsMinor).toBe(trial.totalCreditsMinor);
    expect(trial.accounts.map((a) => a.accountCode)).toContain(FEES);
  });
});
