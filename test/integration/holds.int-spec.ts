/**
 * Holds and available balance (spec 6.7, 12): placement under a lock, idempotent capture
 * and release, the one-way state machine, expiry, and the database guards behind them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { HoldsRepository } from '../../src/modules/holds/holds.repository';
import type { PlaceHoldInput } from '../../src/modules/holds/holds.service';
import {
  connect,
  createBankAccount,
  createMerchant,
  line,
  post,
  postingInput,
  startLedgerContext,
  type LedgerContext,
  type TestMerchant,
} from '../support/ledger';
let ctx: LedgerContext;
beforeAll(async () => {
  ctx = await startLedgerContext({ DB_POOL_MAX: '30' });
});
afterAll(async () => {
  await ctx?.close();
});
async function fundedMerchant(amount = 10_000n): Promise<TestMerchant> {
  const merchant = await createMerchant(ctx);
  const bank = await createBankAccount(ctx);
  await post(
    ctx,
    postingInput([line(bank, 'debit', amount), line(merchant.payable, 'credit', amount)], {
      merchantId: merchant.id,
      source: 'payment',
    })
  );
  return merchant;
}
function holdInput(
  merchant: TestMerchant,
  overrides: Partial<PlaceHoldInput> = {}
): PlaceHoldInput {
  return {
    merchantId: merchant.id,
    environment: 'test',
    currency: 'UGX',
    amountMinor: 1_000n,
    reason: 'payout test',
    idempotencyKey: `hold:${randomUUID()}`,
    createdBy: 'system:holds-test',
    ...overrides,
  };
}
const place = (input: PlaceHoldInput) => ctx.unitOfWork.run((tx) => ctx.holds.place(tx, input));
const capture = (id: string, key: string) =>
  ctx.unitOfWork.run((tx) => ctx.holds.capture(tx, id, key));
const release = (id: string, key: string) =>
  ctx.unitOfWork.run((tx) => ctx.holds.release(tx, id, key));
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
}
describe('available balance', () => {
  it('is posted minus held, with pending informational', async () => {
    const merchant = await fundedMerchant(10_000n);
    let balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance).toMatchObject({
      postedMinor: 10_000n,
      heldMinor: 0n,
      availableMinor: 10_000n,
      reservedMinor: 0n,
      pendingMinor: 0n,
    });
    await place(holdInput(merchant, { amountMinor: 3_000n }));
    balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance).toMatchObject({
      postedMinor: 10_000n,
      heldMinor: 3_000n,
      availableMinor: 7_000n,
    });
    expect(
      (await ctx.balances.merchantBalances(merchant.id, 'test')).map((b) => b.currency)
    ).toEqual(['UGX']);
  });
  it('reports zero for a merchant with no postings and no currencies in use', async () => {
    const merchant = await createMerchant(ctx);
    expect(await ctx.balances.merchantBalances(merchant.id, 'test')).toEqual([]);
    const balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance.availableMinor).toBe(0n);
  });
  it('lists a currency that only has an active hold... never, because a hold needs balance', async () => {
    const merchant = await createMerchant(ctx);
    expect(await codeOf(place(holdInput(merchant)))).toBe('INSUFFICIENT_BALANCE');
  });
});
describe('placing holds', () => {
  it('places a hold and replays the same key without a second hold', async () => {
    const merchant = await fundedMerchant();
    const input = holdInput(merchant, { amountMinor: 4_000n });
    const first = await place(input);
    const second = await place(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.hold.id).toBe(first.hold.id);
    expect(first.hold.ref).toMatch(/^hold_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.hold).toMatchObject({ state: 'active', amountMinor: 4_000n, expiresAt: null });
    const balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance.heldMinor).toBe(4_000n);
  });
  it('refuses the same key with different parameters', async () => {
    const merchant = await fundedMerchant();
    const input = holdInput(merchant, { amountMinor: 1_000n });
    await place(input);
    expect(await codeOf(place({ ...input, amountMinor: 2_000n }))).toBe('HOLD_CONFLICT');
    expect(await codeOf(place({ ...input, reason: 'another reason' }))).toBe('HOLD_CONFLICT');
  });
  it('refuses a hold above the available balance and says by how much', async () => {
    const merchant = await fundedMerchant(5_000n);
    await place(holdInput(merchant, { amountMinor: 4_000n }));
    const error = await place(holdInput(merchant, { amountMinor: 1_001n })).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INSUFFICIENT_BALANCE');
    expect((error as AppError).details).toEqual({
      available: '1000',
      requested: '1001',
      currency: 'UGX',
    });
    // Exactly the available amount is allowed.
    await place(holdInput(merchant, { amountMinor: 1_000n }));
  });
  it('rejects malformed input before touching the database', async () => {
    const merchant = await fundedMerchant();
    const cases: Partial<PlaceHoldInput>[] = [
      { amountMinor: 0n },
      { amountMinor: -5n },
      { currency: 'XXX' },
      { reason: '' },
      { idempotencyKey: '' },
      { createdBy: 'nobody' },
      { expiresAt: new Date(Date.now() - 1_000) },
    ];
    for (const overrides of cases) {
      expect(await codeOf(place(holdInput(merchant, overrides)))).toBe('LEDGER_POSTING_INVALID');
    }
  });
  it('refuses a merchant without ledger accounts', async () => {
    const merchant = await fundedMerchant();
    expect(await codeOf(place(holdInput({ ...merchant, id: randomUUID() })))).toBe(
      'LEDGER_ACCOUNT_NOT_FOUND'
    );
  });
  it('keeps test and live holds apart', async () => {
    const merchant = await fundedMerchant();
    // The merchant has funds only in test; a live hold has nothing to draw on.
    expect(await codeOf(place(holdInput(merchant, { environment: 'live' })))).toBe(
      'INSUFFICIENT_BALANCE'
    );
  });
  it('lets 25 parallel holds reserve only what is available', async () => {
    const merchant = await fundedMerchant(10_000n);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => place(holdInput(merchant, { amountMinor: 1_000n })))
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(15);
    const balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance).toMatchObject({ heldMinor: 10_000n, availableMinor: 0n });
  });
  it('places one hold for 25 parallel identical requests', async () => {
    const merchant = await fundedMerchant(10_000n);
    const input = holdInput(merchant, { amountMinor: 1_000n });
    const results = await Promise.all(Array.from({ length: 25 }, () => place(input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.hold.id)).size).toBe(1);
    expect((await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX')).heldMinor).toBe(1_000n);
  });
});
describe('capture and release', () => {
  it('captures once, replays the same key, refuses another key', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const key = `cap-${randomUUID()}`;
    const first = await capture(hold.id, key);
    expect(first.hold).toMatchObject({ state: 'captured', captureKey: key });
    expect(first.hold.capturedAt).toBeInstanceOf(Date);
    expect((await capture(hold.id, key)).replayed).toBe(true);
    expect(await codeOf(capture(hold.id, `cap-${randomUUID()}`))).toBe('HOLD_NOT_ACTIVE');
    // A captured hold no longer reserves: the posting took its place.
    expect((await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX')).heldMinor).toBe(0n);
  });
  it('releases once, replays the same key, and cannot capture a released hold', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const key = `rel-${randomUUID()}`;
    expect((await release(hold.id, key)).hold.state).toBe('released');
    expect((await release(hold.id, key)).replayed).toBe(true);
    expect(await codeOf(release(hold.id, `rel-${randomUUID()}`))).toBe('HOLD_NOT_ACTIVE');
    const error = await capture(hold.id, `cap-${randomUUID()}`).catch(
      (e: unknown) => e as AppError
    );
    expect((error as AppError).code).toBe('HOLD_NOT_ACTIVE');
    expect((error as AppError).details).toEqual({ reason: 'not_active', state: 'released' });
    expect((await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX')).availableMinor).toBe(
      10_000n
    );
  });
  it('cannot release a captured hold', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    await capture(hold.id, `cap-${randomUUID()}`);
    expect(await codeOf(release(hold.id, `rel-${randomUUID()}`))).toBe('HOLD_NOT_ACTIVE');
  });
  it('refuses a capture or release key that already ended another hold', async () => {
    const merchant = await fundedMerchant();
    const a = await place(holdInput(merchant));
    const b = await place(holdInput(merchant));
    const key = `shared-${randomUUID()}`;
    await capture(a.hold.id, key);
    expect(await codeOf(capture(b.hold.id, key))).toBe('HOLD_CONFLICT');
    const c = await place(holdInput(merchant));
    const d = await place(holdInput(merchant));
    await release(c.hold.id, key);
    expect(await codeOf(release(d.hold.id, key))).toBe('HOLD_CONFLICT');
    // The refused attempts left both holds active.
    expect((await ctx.holds.listActive(merchant.id, 'test')).map((h) => h.id).sort()).toEqual(
      [b.hold.id, d.hold.id].sort()
    );
  });
  it('captures exactly once among 20 parallel captures with different keys', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => capture(hold.id, `cap-${randomUUID()}-${i}`))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => (r.reason as AppError).code === 'HOLD_NOT_ACTIVE')
    ).toBe(true);
  });
  it('captures once among parallel captures that share a key', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const key = `same-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => capture(hold.id, key)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
  it('lets a capture and a release race and only one wins', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const results = await Promise.allSettled([
      capture(hold.id, `c-${randomUUID()}`),
      release(hold.id, `r-${randomUUID()}`),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('rolls a capture back with its transaction', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const key = `cap-${randomUUID()}`;
    await ctx.unitOfWork
      .run(async (tx) => {
        await ctx.holds.capture(tx, hold.id, key);
        throw new Error('later step failed');
      })
      .catch(() => undefined);
    const retried = await capture(hold.id, key);
    expect(retried.replayed).toBe(false);
    expect(retried.hold.captureKey).toBe(key);
  });
  it('answers NOT_FOUND for an unknown hold', async () => {
    expect(await codeOf(capture(randomUUID(), 'k'))).toBe('NOT_FOUND');
    expect(await codeOf(release(randomUUID(), 'k'))).toBe('NOT_FOUND');
  });
});
describe('negative available balance', () => {
  it('reports zero available when postings outran holds, and places nothing', async () => {
    const merchant = await fundedMerchant(1_000n);
    await place(holdInput(merchant, { amountMinor: 800n }));
    const bank = await createBankAccount(ctx);
    // An adjustment allowed to take the payable below what is held.
    await post(
      ctx,
      postingInput([line(merchant.payable, 'debit', 500n), line(bank, 'credit', 500n)], {
        merchantId: merchant.id,
        allowNegativeMerchantBalance: true,
      })
    );
    const balance = await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX');
    expect(balance).toMatchObject({ postedMinor: 500n, heldMinor: 800n, availableMinor: -300n });
    const error = await place(holdInput(merchant, { amountMinor: 1n })).catch((e: unknown) => e);
    expect((error as AppError).code).toBe('INSUFFICIENT_BALANCE');
    expect((error as AppError).details).toMatchObject({ available: '0', requested: '1' });
  });
});
describe('lookup and expiry', () => {
  it('finds a hold by ref inside its merchant and environment only', async () => {
    const merchant = await fundedMerchant();
    const other = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    expect((await ctx.holds.findByRef(merchant.id, 'test', hold.ref))?.id).toBe(hold.id);
    expect(await ctx.holds.findByRef(other.id, 'test', hold.ref)).toBeUndefined();
    expect(await ctx.holds.findByRef(merchant.id, 'live', hold.ref)).toBeUndefined();
    const active = await ctx.holds.listActive(merchant.id, 'test');
    expect(active.map((h) => h.id)).toEqual([hold.id]);
  });
  it('expires only active holds past their expiry, and a hold without expiry never', async () => {
    const merchant = await fundedMerchant();
    const never = await place(holdInput(merchant, { amountMinor: 100n }));
    const soon = await place(
      holdInput(merchant, { amountMinor: 200n, expiresAt: new Date(Date.now() + 1_500) })
    );
    const captured = await place(
      holdInput(merchant, { amountMinor: 300n, expiresAt: new Date(Date.now() + 1_500) })
    );
    await capture(captured.hold.id, `cap-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const first = await ctx.holds.expireDue(500);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    const again = await ctx.holds.expireDue(500);
    expect(again.expired).toBe(0);
    const state = async (id: string) =>
      await ctx.holds.findByRef(merchant.id, 'test', await refOf(id));
    expect((await state(soon.hold.id))?.state).toBe('expired');
    expect((await state(never.hold.id))?.state).toBe('active');
    expect((await state(captured.hold.id))?.state).toBe('captured');
    expect(await codeOf(capture(soon.hold.id, `late-${randomUUID()}`))).toBe('HOLD_NOT_ACTIVE');
    expect(await codeOf(release(soon.hold.id, `late-${randomUUID()}`))).toBe('HOLD_NOT_ACTIVE');
    expect((await ctx.balances.merchantBalance(merchant.id, 'test', 'UGX')).heldMinor).toBe(100n);
  });
  it('skips a hold that ended between the scan and the lock, and counts failures', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(
      holdInput(merchant, { amountMinor: 100n, expiresAt: new Date(Date.now() + 1_200) })
    );
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    await release(hold.id, `rel-${randomUUID()}`);
    const result = await ctx.holds.expireDue(500);
    expect(result.expired).toBe(0);
    expect(result.failed).toBe(0);
  });
});
describe('failure handling', () => {
  it('counts a hold that ended between the scan and the lock as skipped', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant, { amountMinor: 100n }));
    const repository = ctx.app.get(HoldsRepository, { strict: false });
    const scan = vi.spyOn(repository, 'findDueForExpiry').mockResolvedValueOnce([hold.id]);
    try {
      const result = await ctx.holds.expireDue(10);
      expect(result).toEqual({ expired: 0, skipped: 1, failed: 0 });
    } finally {
      scan.mockRestore();
    }
    expect((await ctx.holds.findByRef(merchant.id, 'test', hold.ref))?.state).toBe('active');
  });
  it('isolates a failing hold: it is counted and the rest of the sweep still runs', async () => {
    const merchant = await fundedMerchant();
    const soon = () => new Date(Date.now() + 1_200);
    const a = await place(holdInput(merchant, { amountMinor: 100n, expiresAt: soon() }));
    const b = await place(holdInput(merchant, { amountMinor: 100n, expiresAt: soon() }));
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    const repository = ctx.app.get(HoldsRepository, { strict: false });
    const original = repository.markExpired.bind(repository);
    const failing = vi.spyOn(repository, 'markExpired').mockImplementation((tx, id, at) => {
      if (id === a.hold.id) throw new Error('boom');
      return original(tx, id, at);
    });
    try {
      const result = await ctx.holds.expireDue(500);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.expired).toBeGreaterThanOrEqual(1);
    } finally {
      failing.mockRestore();
    }
    expect((await ctx.holds.findByRef(merchant.id, 'test', b.hold.ref))?.state).toBe('expired');
    expect((await ctx.holds.findByRef(merchant.id, 'test', a.hold.ref))?.state).toBe('active');
  });
  it('passes through errors that are not a reused key', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant));
    const repository = ctx.app.get(HoldsRepository, { strict: false });
    const failing = vi.spyOn(repository, 'markCaptured').mockRejectedValueOnce(new Error('disk'));
    try {
      await expect(capture(hold.id, `cap-${randomUUID()}`)).rejects.toThrow('disk');
    } finally {
      failing.mockRestore();
    }
    const releasing = vi.spyOn(repository, 'markReleased').mockRejectedValueOnce(new Error('disk'));
    try {
      await expect(release(hold.id, `rel-${randomUUID()}`)).rejects.toThrow('disk');
    } finally {
      releasing.mockRestore();
    }
  });
});
async function refOf(id: string): Promise<string> {
  const pg = await connect('superuser');
  try {
    const { rows } = await pg.query<{ ref: string }>('select ref from core.holds where id = $1', [
      id,
    ]);
    return rows[0]?.ref ?? '';
  } finally {
    await pg.end();
  }
}
describe('database guards', () => {
  async function insertRaw(merchant: TestMerchant, overrides: Record<string, unknown> = {}) {
    const pg = await connect('rw');
    try {
      const { rows } = await pg.query<{ id: string }>(
        `select id from core.accounts where merchant_id = $1 and environment = 'test' and purpose = 'merchant_payable'`,
        [merchant.id]
      );
      const values = {
        id: randomUUID(),
        ref: `hold_${'0'.repeat(26)}`.slice(0, 31),
        merchant_id: merchant.id,
        environment: 'test',
        account_id: rows[0]?.id,
        currency: 'UGX',
        amount_minor: 10,
        state: 'active',
        reason: 'raw',
        idempotency_key: randomUUID(),
        created_by: 'system:raw',
        ...overrides,
      };
      return await pg.query(
        `insert into core.holds (id, ref, merchant_id, environment, account_id, currency, amount_minor, state, reason, idempotency_key, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          values.id,
          values.ref,
          values.merchant_id,
          values.environment,
          values.account_id,
          values.currency,
          values.amount_minor,
          values.state,
          values.reason,
          values.idempotency_key,
          values.created_by,
        ]
      );
    } finally {
      await pg.end();
    }
  }
  const validRef = () => `hold_${'A'.repeat(26)}`.replace(/A/g, () => '1');
  it('accepts a well-formed raw insert (control)', async () => {
    const merchant = await createMerchant(ctx);
    await insertRaw(merchant, { ref: validRef() + '' });
  });
  it('refuses holds that are not active, non-positive, or on the wrong account', async () => {
    const merchant = await createMerchant(ctx);
    const other = await createMerchant(ctx);
    const ref = () =>
      `hold_${randomUUID()
        .replace(/-/g, '')
        .slice(0, 26)
        .toUpperCase()
        .replace(/[ILOU]/g, '1')}`;
    await expect(insertRaw(merchant, { ref: ref(), state: 'captured' })).rejects.toThrow();
    await expect(insertRaw(merchant, { ref: ref(), amount_minor: 0 })).rejects.toThrow();
    const pg = await connect('rw');
    try {
      const { rows } = await pg.query<{ id: string }>(
        `select id from core.accounts where merchant_id = $1 and environment = 'test' and purpose = 'merchant_reserve'`,
        [merchant.id]
      );
      await expect(insertRaw(merchant, { ref: ref(), account_id: rows[0]?.id })).rejects.toThrow(
        /payable account/
      );
      const otherPayable = await pg.query<{ id: string }>(
        `select id from core.accounts where merchant_id = $1 and environment = 'test' and purpose = 'merchant_payable'`,
        [other.id]
      );
      await expect(
        insertRaw(merchant, { ref: ref(), account_id: otherPayable.rows[0]?.id })
      ).rejects.toThrow(/payable account/);
      await expect(insertRaw(merchant, { ref: ref(), environment: 'live' })).rejects.toThrow(
        /payable account/
      );
    } finally {
      await pg.end();
    }
  });
  it('never deletes, truncates or rewrites a hold', async () => {
    const merchant = await fundedMerchant();
    const { hold } = await place(holdInput(merchant, { amountMinor: 500n }));
    const pg = await connect('rw');
    try {
      await expect(pg.query('delete from core.holds where id = $1', [hold.id])).rejects.toThrow();
      await expect(pg.query('truncate core.holds')).rejects.toThrow();
      await expect(
        pg.query('update core.holds set amount_minor = 1 where id = $1', [hold.id])
      ).rejects.toThrow(/never change/);
      await expect(
        pg.query(`update core.holds set state = 'captured' where id = $1`, [hold.id])
      ).rejects.toThrow(/holds_end_state_check/);
      await pg.query(
        `update core.holds set state = 'captured', captured_at = now(), capture_key = 'k' where id = $1`,
        [hold.id]
      );
      await expect(
        pg.query(
          `update core.holds set state = 'released', released_at = now(), release_key = 'x', captured_at = null, capture_key = null where id = $1`,
          [hold.id]
        )
      ).rejects.toThrow(/cannot change/);
    } finally {
      await pg.end();
    }
  });
});
