/**
 * Admin ledger, balance and hold reads (spec 7.3): happy paths, validation, authorisation,
 * cursors, and that the statement's running balance agrees with the account balance.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { HoldsService } from '../../src/modules/holds/holds.service';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { staffSession, type StaffSession } from '../support/identity';
import {
  createTestMerchant,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';
let ctx: PaymentsContext;
let admin: StaffSession;
let merchant: TestMerchant;
let bank: string;
let payable: string;
const entryRefs: string[] = [];
async function postLine(
  direction: 'credit' | 'debit',
  amount: bigint,
  sourceId: string
): Promise<string> {
  const lines =
    direction === 'credit'
      ? [
          { accountCode: bank, direction: 'debit' as const, amountMinor: amount },
          { accountCode: payable, direction: 'credit' as const, amountMinor: amount },
        ]
      : [
          { accountCode: payable, direction: 'debit' as const, amountMinor: amount },
          { accountCode: bank, direction: 'credit' as const, amountMinor: amount },
        ];
  const result = await ctx.unitOfWork.run((tx) =>
    ctx.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('payment', sourceId),
      environment: 'test',
      currency: 'UGX',
      source: 'payment',
      sourceId,
      merchantId: merchant.id,
      description: `admin ledger test ${sourceId}`,
      lines,
      createdBy: { type: 'system', id: 'admin-ledger-test' },
    })
  );
  return result.entry.ref;
}
const from = () => new Date(Date.now() - 3_600_000).toISOString();
const to = () => new Date(Date.now() + 3_600_000).toISOString();
beforeAll(async () => {
  ctx = await startPaymentsContext();
  admin = await staffSession(ctx);
  merchant = await createTestMerchant(ctx);
  const key = `t${randomBytes(6).toString('hex')}`;
  const accounts = ctx.app.get(AccountsService, { strict: false });
  const row = await ctx.unitOfWork.run((tx) =>
    accounts.openBankAccount(tx, {
      environment: 'test',
      bankKey: key,
      name: `bank ${key}`,
      currency: 'UGX',
    })
  );
  bank = row.code;
  payable = `2000:merchant_payable:${merchant.ref}`;
  entryRefs.push(await postLine('credit', 10_000n, `adm-1-${key}`));
  entryRefs.push(await postLine('credit', 5_000n, `adm-2-${key}`));
  entryRefs.push(await postLine('debit', 3_000n, `adm-3-${key}`));
  const holds = ctx.app.get(HoldsService, { strict: false });
  await ctx.unitOfWork.run((tx) =>
    holds.place(tx, {
      merchantId: merchant.id,
      environment: 'test',
      currency: 'UGX',
      amountMinor: 2_000n,
      reason: 'admin read test',
      idempotencyKey: `hold:${key}`,
      createdBy: 'system:admin-ledger-test',
    })
  );
});
afterAll(async () => {
  await ctx?.close();
});
describe('GET /admin/v1/accounts', () => {
  it('lists, filters and pages accounts', async () => {
    const res = await admin.client.get(
      `/admin/v1/accounts?environment=test&merchant=${merchant.ref}&limit=1`
    );
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.items).toHaveLength(1);
    expect(data.items[0].code).toBe(`2000:merchant_payable:${merchant.ref}`);
    expect(data.nextCursor).toEqual(expect.any(String));
    const next = await admin.client.get(
      `/admin/v1/accounts?environment=test&merchant=${merchant.ref}&limit=1&cursor=${data.nextCursor}`
    );
    expect(next.json().data.items[0].code).toBe(`2010:merchant_reserve:${merchant.ref}`);
    expect(next.json().data.nextCursor).toBeNull();
  });
  it('rejects a cursor used with other filters', async () => {
    const first = await admin.client.get(
      `/admin/v1/accounts?environment=test&merchant=${merchant.ref}&limit=1`
    );
    const res = await admin.client.get(
      `/admin/v1/accounts?environment=live&merchant=${merchant.ref}&limit=1&cursor=${first.json().data.nextCursor}`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });
  it('returns nothing for an unknown merchant and 400 for unknown query keys', async () => {
    const none = await admin.client.get('/admin/v1/accounts?environment=test&merchant=mch_nope');
    expect(none.json().data.items).toEqual([]);
    const bad = await admin.client.get('/admin/v1/accounts?bogus=1');
    expect(bad.statusCode).toBe(400);
  });
  it('shows one account with its posted balance, and 404 for an unknown code', async () => {
    const res = await admin.client.get(
      `/admin/v1/accounts/${encodeURIComponent(payable)}?environment=test`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data.balances).toEqual([
      { currency: 'UGX', debitsMinor: '3000', creditsMinor: '15000', postedMinor: '12000' },
    ]);
    const missing = await admin.client.get('/admin/v1/accounts/9999:nothing?environment=test');
    expect(missing.statusCode).toBe(404);
  });
});
describe('statement', () => {
  it('keeps a running balance that ends at the account balance, and pages with a cursor', async () => {
    const url = `/admin/v1/accounts/${encodeURIComponent(payable)}/statement?environment=test&currency=UGX&from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`;
    const full = await admin.client.get(`${url}&limit=50`);
    expect(full.statusCode).toBe(200);
    const items = full.json().data.items as Array<{
      balanceAfterMinor: string;
      amountMinor: string;
    }>;
    expect(items.map((i) => i.balanceAfterMinor)).toEqual(['10000', '15000', '12000']);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await admin.client.get(`${url}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      if (res.statusCode !== 200) throw new Error(res.body);
      paged.push(
        ...res.json().data.items.map((i: { balanceAfterMinor: string }) => i.balanceAfterMinor)
      );
      cursor = res.json().data.nextCursor;
    } while (cursor);
    expect(paged).toEqual(['10000', '15000', '12000']);
  });
  it('starts the running balance from the opening balance when the window starts later', async () => {
    const url = `/admin/v1/accounts/${encodeURIComponent(payable)}/statement?environment=test&currency=UGX&from=${encodeURIComponent(to())}&to=${encodeURIComponent(new Date(Date.now() + 7_200_000).toISOString())}`;
    const res = await admin.client.get(url);
    expect(res.json().data.items).toEqual([]);
  });
  it('rejects an inverted window and requires a currency', async () => {
    const base = `/admin/v1/accounts/${encodeURIComponent(payable)}/statement?environment=test&currency=UGX`;
    const inverted = await admin.client.get(
      `${base}&from=${encodeURIComponent(to())}&to=${encodeURIComponent(from())}`
    );
    expect(inverted.statusCode).toBe(400);
    const noCurrency = await admin.client.get(
      `/admin/v1/accounts/${encodeURIComponent(payable)}/statement?environment=test`
    );
    expect(noCurrency.statusCode).toBe(400);
  });
});
describe('statement of a debit-normal account', () => {
  it('runs the balance on the debit side and 404s an unknown account', async () => {
    const url = `/admin/v1/accounts/${encodeURIComponent(bank)}/statement?environment=test&currency=UGX&from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`;
    const res = await admin.client.get(`${url}&limit=10`);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().data.items.map((i: { balanceAfterMinor: string }) => i.balanceAfterMinor)
    ).toEqual(['10000', '15000', '12000']);
    const missing = await admin.client.get(
      '/admin/v1/accounts/9999:nothing/statement?environment=test&currency=UGX'
    );
    expect(missing.statusCode).toBe(404);
  });
});
describe('journal entries', () => {
  it('lists newest first with filters, and shows one entry with its lines', async () => {
    const res = await admin.client.get(
      `/admin/v1/journal-entries?environment=test&merchant=${merchant.ref}&source=payment&from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ ref: string; merchantRef: string }>;
    expect(items.map((i) => i.ref)).toEqual([...entryRefs].reverse());
    expect(items.every((i) => i.merchantRef === merchant.ref)).toBe(true);
    const detail = await admin.client.get(`/admin/v1/journal-entries/${entryRefs[0]}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.lines).toEqual([
      { lineNo: 1, accountCode: bank, direction: 'debit', amountMinor: '10000' },
      { lineNo: 2, accountCode: payable, direction: 'credit', amountMinor: '10000' },
    ]);
  });
  it('pages without repeating or skipping entries', async () => {
    const url = `/admin/v1/journal-entries?environment=test&merchant=${merchant.ref}&from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}&limit=1`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await admin.client.get(`${url}${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.json().data.items.map((i: { ref: string }) => i.ref));
      cursor = res.json().data.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...entryRefs].reverse());
  });
  it('404s an unknown entry and rejects a tampered cursor', async () => {
    expect((await admin.client.get('/admin/v1/journal-entries/je_unknown')).statusCode).toBe(404);
    const res = await admin.client.get('/admin/v1/journal-entries?cursor=garbage');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });
  it('lists across environments when no environment is given', async () => {
    const res = await admin.client.get(
      `/admin/v1/journal-entries?merchant=${merchant.ref}&from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`
    );
    expect(res.json().data.items).toHaveLength(entryRefs.length);
  });
  it('filters by environment and transaction', async () => {
    const win = `from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`;
    const live = await admin.client.get(
      `/admin/v1/journal-entries?environment=live&merchant=${merchant.ref}&${win}`
    );
    expect(live.json().data.items).toEqual([]);
    const none = await admin.client.get(
      `/admin/v1/journal-entries?environment=test&transactionId=00000000-0000-7000-8000-000000000000&${win}`
    );
    expect(none.json().data.items).toEqual([]);
  });
  it('finds nothing for a merchant that does not exist', async () => {
    const res = await admin.client.get('/admin/v1/journal-entries?merchant=mch_nope');
    expect(res.json().data.items).toEqual([]);
  });
});
describe('trial balance and integrity', () => {
  it('reports a balanced trial balance', async () => {
    const res = await admin.client.get('/admin/v1/trial-balance?environment=test&currency=UGX');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.balanced).toBe(true);
    expect(data.totalDebitsMinor).toBe(data.totalCreditsMinor);
    expect(data.accounts.some((a: { accountCode: string }) => a.accountCode === payable)).toBe(
      true
    );
  });
  it('reports integrity', async () => {
    const res = await admin.client.get('/admin/v1/ledger/integrity');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ invalidEntries: [], balanceMismatches: [] });
    expect(typeof res.json().data.ok).toBe('boolean');
  });
});
describe('balances and holds', () => {
  it('reports posted, held, pending, reserved and available', async () => {
    const res = await admin.client.get(
      `/admin/v1/balances?merchant=${merchant.ref}&environment=test`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        currency: 'UGX',
        postedMinor: '12000',
        heldMinor: '2000',
        pendingMinor: '0',
        reservedMinor: '0',
        availableMinor: '10000',
      },
    ]);
    const holds = await admin.client.get(
      `/admin/v1/holds?merchant=${merchant.ref}&environment=test`
    );
    expect(holds.statusCode).toBe(200);
    expect(holds.json().data).toHaveLength(1);
    expect(holds.json().data[0]).toMatchObject({
      state: 'active',
      amountMinor: '2000',
      expiresAt: null,
    });
  });
  it('404s an unknown merchant', async () => {
    expect((await admin.client.get('/admin/v1/balances?merchant=mch_nope')).statusCode).toBe(404);
    expect((await admin.client.get('/admin/v1/holds?merchant=mch_nope')).statusCode).toBe(404);
  });
});
describe('authorisation', () => {
  it('refuses unauthenticated callers, merchant users and staff without the permission', async () => {
    const paths = [
      '/admin/v1/accounts',
      '/admin/v1/journal-entries',
      '/admin/v1/trial-balance?currency=UGX',
      '/admin/v1/ledger/integrity',
      `/admin/v1/balances?merchant=${merchant.ref}`,
      `/admin/v1/holds?merchant=${merchant.ref}`,
    ];
    const anonymous = new (admin.client.constructor as new (app: unknown) => typeof admin.client)(
      ctx.app
    );
    for (const path of paths) {
      expect((await anonymous.get(path)).statusCode, path).toBe(401);
      expect([401, 403]).toContain((await merchant.owner.client.get(path)).statusCode);
    }
    const agent = await staffSession(ctx, 'support_agent');
    expect((await agent.client.get('/admin/v1/accounts')).statusCode).toBe(403);
    expect((await agent.client.get('/admin/v1/journal-entries')).statusCode).toBe(403);
    expect(
      (await agent.client.get(`/admin/v1/balances?merchant=${merchant.ref}&environment=test`))
        .statusCode
    ).toBe(200);
  });
});
