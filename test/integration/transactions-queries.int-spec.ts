/**
 * Transaction queries (spec 6.5, 7.1, 7.2, 9.2): filters, cursor paging over ties, windows,
 * merchant and environment scoping, the merchant-visible timeline, the dashboard lists and the
 * query budget of a read.
 */
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addTeamMember, Client } from '../support/identity';
import {
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  paymentId,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let merchant: TestMerchant;
let rival: TestMerchant;

interface Created {
  id: string;
  transactionId: string;
}

const made: Record<string, Created> = {};

beforeAll(async () => {
  ctx = await startPaymentsContext();
  merchant = await createTestMerchant(ctx, { active: true, label: 'queries' });
  rival = await createTestMerchant(ctx, { active: true, label: 'queries-rival' });

  // A small, known set: one of each interesting status, two currencies, two amounts.
  const succeeded = await createPayment(merchant.test, { amountMinor: '10000' });
  const failed = await createPayment(merchant.test, { amountMinor: '20000' });
  const processing = await createPayment(merchant.test, { amountMinor: '30000' });
  const kes = await createPayment(merchant.test, { amountMinor: '4000', currency: 'KES' });
  const card = await createPayment(merchant.test, {
    amountMinor: '5000',
    currency: 'USD',
    channel: 'card',
    paymentMethod: undefined,
  });
  Object.assign(made, { succeeded, failed, processing, kes, card });
  const ids = {
    succeeded: await paymentId(ctx, merchant, succeeded.id),
    failed: await paymentId(ctx, merchant, failed.id),
    processing: await paymentId(ctx, merchant, processing.id),
  };
  await toProcessing(ctx, ids.succeeded, {
    identifiers: { provider: 'mtn', providerTransactionId: 'mtn-ptx-777' },
  });
  await applyEvent(ctx, ids.succeeded, event({ kind: 'succeeded' }));
  await toProcessing(ctx, ids.failed, { identifiers: { provider: 'airtel' } });
  await applyEvent(ctx, ids.failed, event({ kind: 'failed', failureCode: 'declined' }));
  await toProcessing(ctx, ids.processing, { identifiers: { provider: 'mtn' } });
  await createPayment(rival.test, { amountMinor: '10000' });
});

afterAll(async () => {
  await ctx?.close();
});

async function list(client: Client, query = '') {
  const res = await client.get(`/v1/transactions?limit=100${query ? `&${query}` : ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.items as Array<{
    id: string;
    status: string;
    amountMinor: string;
    currency: string;
  }>;
}

describe('GET /v1/transactions', () => {
  it('lists only the caller’s transactions in its own environment', async () => {
    const items = await list(merchant.test);
    expect(items.map((t) => t.id).sort()).toEqual(
      Object.values(made)
        .map((p) => p.transactionId)
        .sort()
    );
    expect(await list(merchant.live!)).toEqual([]);
    expect((await list(rival.test)).length).toBe(1);
  });

  it('shows the fields a merchant may see and none that it may not', async () => {
    const [tx] = await list(merchant.test, `reference=${made.succeeded!.transactionId}`);
    expect(tx).toMatchObject({
      id: made.succeeded!.transactionId,
      type: 'payment',
      status: 'succeeded',
      environment: 'test',
      amountMinor: '10000',
      feeMinor: '0',
      netMinor: '10000',
      currency: 'UGX',
      provider: 'mtn',
      channel: 'mobile_money',
      externalId: made.succeeded!.id,
      providerTransactionId: 'mtn-ptx-777',
      failureCode: null,
    });
    const raw = JSON.stringify(tx);
    expect(raw).not.toMatch(
      /merchantId|gatewayOperation|gatewayReference|failureReason|outcomeUnknown/
    );
  });

  it('filters by type, status, currency, provider and channel', async () => {
    const ids = async (query: string) => (await list(merchant.test, query)).map((t) => t.id);
    expect(await ids('type=payment')).toHaveLength(5);
    expect(await ids('type=payout')).toEqual([]);
    expect(await ids('status=succeeded')).toEqual([made.succeeded!.transactionId]);
    expect(await ids('status=failed')).toEqual([made.failed!.transactionId]);
    expect(await ids('status=created')).toHaveLength(2);
    expect(await ids('currency=KES')).toEqual([made.kes!.transactionId]);
    expect((await ids('provider=mtn')).sort()).toEqual(
      [made.succeeded!.transactionId, made.processing!.transactionId].sort()
    );
    expect(await ids('provider=airtel')).toEqual([made.failed!.transactionId]);
    expect(await ids('channel=card')).toEqual([made.card!.transactionId]);
    expect(await ids('status=succeeded&currency=KES')).toEqual([]);
  });

  it('filters by amount range, inclusive', async () => {
    const amounts = async (query: string) =>
      (await list(merchant.test, query))
        .map((t) => t.amountMinor)
        .sort((a, b) => Number(a) - Number(b));
    expect(await amounts('minAmountMinor=10000&maxAmountMinor=20000')).toEqual(['10000', '20000']);
    expect(await amounts('minAmountMinor=20001')).toEqual(['30000']);
    expect(await amounts('maxAmountMinor=4000')).toEqual(['4000']);
    const inverted = await merchant.test.get('/v1/transactions?minAmountMinor=5&maxAmountMinor=1');
    expect(inverted.statusCode).toBe(400);
    expect((await merchant.test.get('/v1/transactions?minAmountMinor=abc')).statusCode).toBe(400);
  });

  it('finds a transaction by its own ref, its external id or the provider transaction id', async () => {
    for (const reference of [made.succeeded!.transactionId, made.succeeded!.id, 'mtn-ptx-777']) {
      const found = await list(merchant.test, `reference=${encodeURIComponent(reference)}`);
      expect(
        found.map((t) => t.id),
        reference
      ).toEqual([made.succeeded!.transactionId]);
    }
    expect(await list(merchant.test, 'reference=nothing-matches')).toEqual([]);
    // A reference that belongs to another merchant finds nothing.
    expect(await list(rival.test, `reference=${made.succeeded!.id}`)).toEqual([]);
  });

  it('applies a date window, and refuses an inverted or oversized one', async () => {
    const now = Date.now();
    const hour = 3600_000;
    const inside = `from=${encodeURIComponent(new Date(now - hour).toISOString())}&to=${encodeURIComponent(new Date(now + hour).toISOString())}`;
    expect(await list(merchant.test, inside)).toHaveLength(5);
    const before = `from=${encodeURIComponent(new Date(now - 3 * hour).toISOString())}&to=${encodeURIComponent(new Date(now - 2 * hour).toISOString())}`;
    expect(await list(merchant.test, before)).toEqual([]);
    for (const query of [
      `from=${encodeURIComponent(new Date(now + hour).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}`,
      'from=2020-01-01T00:00:00Z&to=2025-01-01T00:00:00Z',
      'from=nonsense',
    ]) {
      expect((await merchant.test.get(`/v1/transactions?${query}`)).statusCode, query).toBe(400);
    }
  });

  it('pages with a cursor bound to its filters, over rows that share a millisecond', async () => {
    const owner = await createTestMerchant(ctx, { label: 'queries-pages' });
    const refs: string[] = [];
    for (let i = 0; i < 9; i++) refs.push((await createPayment(owner.test)).transactionId);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/transactions?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
      const data = (await owner.test.get(url)).json().data as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...data.items.map((t) => t.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual([...refs].sort());
    expect(new Set(seen).size).toBe(9);
    const page = (await owner.test.get('/v1/transactions?limit=4')).json().data;
    const changed = await owner.test.get(
      `/v1/transactions?limit=4&status=created&cursor=${page.nextCursor}`
    );
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.code).toBe('INVALID_CURSOR');
    // A cursor from another environment's listing is refused too.
    const live = await merchant.live!.get(`/v1/transactions?limit=4&cursor=${page.nextCursor}`);
    expect(live.statusCode).toBe(400);
  });

  it('bounds the page size', async () => {
    for (const limit of ['0', '101', 'x']) {
      expect((await merchant.test.get(`/v1/transactions?limit=${limit}`)).statusCode).toBe(400);
    }
    expect((await merchant.test.get('/v1/transactions?limit=1')).json().data.items).toHaveLength(1);
  });
});

describe('GET /v1/transactions/:ref', () => {
  it('returns the transaction with its merchant-visible timeline', async () => {
    const res = await merchant.test.get(`/v1/transactions/${made.failed!.transactionId}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ status: 'failed', failureCode: 'declined', provider: 'airtel' });
    expect(
      data.timeline.map((t: { status: string; previousStatus: string | null }) => [
        t.previousStatus,
        t.status,
      ])
    ).toEqual([
      [null, 'created'],
      ['created', 'processing'],
      ['processing', 'failed'],
    ]);
    expect(data.timeline.at(-1).failureCode).toBe('declined');
  });

  it('leaves refused, repeated and no-op events out of the timeline', async () => {
    const payment = await createPayment(merchant.test);
    const id = await paymentId(ctx, merchant, payment.id);
    await toProcessing(ctx, id);
    await toProcessing(ctx, id); // a repeat
    await applyEvent(ctx, id, event({ kind: 'failed', failureCode: 'declined' }));
    await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } })); // refused
    const data = (await merchant.test.get(`/v1/transactions/${payment.transactionId}`)).json().data;
    expect(data.timeline.map((t: { status: string }) => t.status)).toEqual([
      'created',
      'processing',
      'failed',
    ]);
    expect(JSON.stringify(data)).not.toMatch(/rejected|terminal_state|gateway_event/);
  });

  it('is 404 for another merchant, another environment, a payment ref or nonsense', async () => {
    const ref = made.succeeded!.transactionId;
    expect((await rival.test.get(`/v1/transactions/${ref}`)).statusCode).toBe(404);
    expect((await merchant.live!.get(`/v1/transactions/${ref}`)).statusCode).toBe(404);
    expect((await merchant.test.get(`/v1/transactions/${made.succeeded!.id}`)).statusCode).toBe(
      404
    );
    expect((await merchant.test.get('/v1/transactions/nonsense')).statusCode).toBe(404);
  });

  it('needs the transactions:read scope and an API key', async () => {
    const noScope = await createTestMerchant(ctx, { scopes: ['payments:read'], label: 'noscope' });
    expect((await noScope.test.get('/v1/transactions')).statusCode).toBe(403);
    expect((await new Client(ctx.app).get('/v1/transactions')).statusCode).toBe(401);
  });
});

describe('the query budget of a read (spec 9.2 rule 11)', () => {
  /** Counts the statements sent to Postgres while `work` runs. */
  async function queryCount(work: () => Promise<unknown>): Promise<number> {
    const proto = PgClient.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const original = proto.query;
    let count = 0;
    proto.query = function (this: unknown, ...args: unknown[]) {
      count += 1;
      return original.apply(this, args);
    };
    try {
      await work();
    } finally {
      proto.query = original;
    }
    return count;
  }

  it('issues at most 4 statements per read, however many rows it returns', async () => {
    const owner = await createTestMerchant(ctx, { label: 'queries-budget' });
    for (let i = 0; i < 12; i++) await createPayment(owner.test);
    const first = await createPayment(owner.test);
    const reads: Array<[string, string]> = [
      ['GET /v1/payments', '/v1/payments?limit=50'],
      ['GET /v1/transactions', '/v1/transactions?limit=50'],
      ['GET /v1/payments/:ref', `/v1/payments/${first.id}`],
      ['GET /v1/payments/:ref/timeline', `/v1/payments/${first.id}/timeline`],
      ['GET /v1/transactions/:ref', `/v1/transactions/${first.transactionId}`],
      ['GET /v1/payment-links', '/v1/payment-links?limit=50'],
    ];
    for (const [label, url] of reads) {
      let status = 0;
      const count = await queryCount(async () => {
        status = (await owner.test.get(url)).statusCode;
      });
      expect(status, label).toBe(200);
      // The API key is served from the Redis cache (spec 8.3), so the read itself is what is
      // counted. At least one statement proves the counter sees the queries.
      expect(count, label).toBeGreaterThanOrEqual(1);
      expect(count, label).toBeLessThanOrEqual(4);
    }
  });
});

describe('the dashboard lists', () => {
  it('shows a merchant user its own payments and transactions, in the environment it asks for', async () => {
    const owner = merchant.owner.client;
    const live = await createPayment(merchant.live!);
    const test = (await owner.get('/dashboard/v1/payments?environment=test&limit=100')).json().data;
    expect(test.items.map((p: { id: string }) => p.id)).toContain(made.succeeded!.id);
    expect(test.items.map((p: { id: string }) => p.id)).not.toContain(live.id);
    // The default is live.
    const byDefault = (await owner.get('/dashboard/v1/payments?limit=100')).json().data;
    expect(byDefault.items.map((p: { id: string }) => p.id)).toContain(live.id);
    expect(byDefault.items.every((p: { environment: string }) => p.environment === 'live')).toBe(
      true
    );
    const transactions = (
      await owner.get('/dashboard/v1/transactions?environment=test&status=succeeded&limit=100')
    ).json().data;
    expect(transactions.items.map((t: { id: string }) => t.id)).toEqual([
      made.succeeded!.transactionId,
    ]);
  });

  it('never shows another merchant’s data', async () => {
    const res = await rival.owner.client.get('/dashboard/v1/payments?environment=test&limit=100');
    const ids = res.json().data.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(made.succeeded!.id);
    const tx = await rival.owner.client.get(
      '/dashboard/v1/transactions?environment=test&limit=100'
    );
    expect(tx.json().data.items.map((t: { id: string }) => t.id)).not.toContain(
      made.succeeded!.transactionId
    );
  });

  it('is open to every team role that can read, and closed to anyone else', async () => {
    // `support`, not `viewer`: another suite edits the seeded viewer role while this one runs.
    const viewer = await addTeamMember(ctx, merchant.owner, 'support');
    const res = await viewer.client.get('/dashboard/v1/payments?environment=test&limit=100');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items.map((p: { id: string }) => p.id)).toContain(made.succeeded!.id);
    expect((await new Client(ctx.app).get('/dashboard/v1/payments')).statusCode).toBe(401);
    // An API key is not a dashboard credential.
    const asKey = await new Client(ctx.app).get('/dashboard/v1/payments', {
      authorization: `Bearer ${merchant.testKey}`,
    });
    expect(asKey.statusCode).toBe(401);
  });

  it('validates its query', async () => {
    for (const query of ['environment=staging', 'status=bogus', 'limit=0', 'extra=1']) {
      const res = await merchant.owner.client.get(`/dashboard/v1/payments?${query}`);
      expect(res.statusCode, query).toBe(400);
    }
  });
});
