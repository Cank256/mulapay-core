/**
 * The read side of the developer platform on `/v1` and the dashboard: the event feed,
 * balances, holds, balance movements and API request logs; and the outbox that the events
 * ride on (spec 6.11, 7.1, 7.2, 8.8).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../src/common/outbox/outbox-dispatcher';
import { OUTBOX_MAX_ATTEMPTS, OutboxRepository } from '../../src/common/outbox/outbox.repository';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { QueueRegistry } from '../../src/common/queue/queue.registry';
import { HoldsService } from '../../src/modules/holds/holds.service';
import { LedgerQueryService } from '../../src/modules/ledger/ledger-query.service';
import { MerchantsService } from '../../src/modules/merchants/merchants.service';
import { RequestLogRepository } from '../../src/modules/developer/request-logs/request-log.repository';
import { MerchantEventsService } from '../../src/modules/events/merchant-events.service';
import type { RequestLogEntry } from '../../src/modules/developer/request-logs/request-log.buffer';
import {
  createMerchant,
  emitEvent,
  issueKey,
  rawRequest,
  startDeveloperContext,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';
import { addTeamMember } from '../support/identity';
import pino from 'pino';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let key: IssuedKey;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'devapi' });
  key = await issueKey(ctx, merchant.owner, {
    environment: 'test',
    scopes: ['events:read', 'balances:read', 'payments:read', 'payments:write'],
  });
});
afterAll(async () => {
  await ctx.close();
});

/** A succeeded sandbox payment: credits the merchant's test balance. */
async function earn(owner: DeveloperMerchant, client: IssuedKey['client'], amountMinor: string) {
  const res = await client.post(
    '/v1/payments',
    {
      amountMinor,
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000009' },
      metadata: { simulate: 'succeed' },
    },
    { 'idempotency-key': `earn-${randomUUID()}` }
  );
  expect(res.statusCode).toBe(201);
  const rows = await ctx.sql('select id from core.payments where ref = $1', [res.json().data.id]);
  await ctx.sandbox.run(String(rows[0]?.id), 'start');
  void owner;
  return res.json().data.id as string;
}
/** A window end past the database clock, fixed for a test so cursors keep their filters. */
const untilNow = (() => {
  const to = `to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`;
  return () => to;
})();

describe('GET /v1/events', () => {
  it('lists the merchant’s events newest first, with the event as webhooks carry it', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'events' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['events:read'] });
    const first = await emitEvent(ctx, m, {
      type: 'payment.created',
      object: { id: 'pay_a', status: 'created' },
    });
    const second = await emitEvent(ctx, m, {
      type: 'payment.failed',
      object: { id: 'pay_b', status: 'failed' },
    });
    const res = await k.client.get('/v1/events');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<Record<string, unknown>>;
    expect(items.map((e) => e.id).sort()).toEqual([first.ref, second.ref].sort());
    const one = items.find((e) => e.id === second.ref);
    expect(one).toEqual({
      id: second.ref,
      type: 'payment.failed',
      environment: 'test',
      resourceType: 'payment',
      resourceId: expect.stringMatching(/^res_/),
      createdAt: expect.any(String),
      data: { object: { id: 'pay_b', status: 'failed' } },
    });
    expect(res.json().data.nextCursor).toBeNull();
    expect(res.json().meta.requestId).toBeDefined();
  });

  it('filters by type and window, paginates by cursor, and ties a cursor to its filters', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'events-page' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['events:read'] });
    for (let i = 0; i < 5; i++) {
      ctx.clock.advanceBy(1000);
      await emitEvent(ctx, m, { type: i % 2 === 0 ? 'payment.created' : 'payment.failed' });
    }
    const page1 = (await k.client.get('/v1/events?limit=2')).json().data;
    expect(page1.items).toHaveLength(2);
    const page2 = (await k.client.get(`/v1/events?limit=2&cursor=${page1.nextCursor}`)).json().data;
    const page3 = (await k.client.get(`/v1/events?limit=2&cursor=${page2.nextCursor}`)).json().data;
    const ids = [...page1.items, ...page2.items, ...page3.items].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(page3.nextCursor).toBeNull();
    // Newest first.
    const times = [...page1.items, ...page2.items, ...page3.items].map(
      (e: { createdAt: string }) => e.createdAt
    );
    expect([...times].sort().reverse()).toEqual(times);
    const failed = (await k.client.get('/v1/events?type=payment.failed')).json().data.items;
    expect(failed).toHaveLength(2);
    const changed = await k.client.get(
      `/v1/events?type=payment.failed&limit=2&cursor=${page1.nextCursor}`
    );
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.code).toBe('INVALID_CURSOR');
    expect((await k.client.get('/v1/events?cursor=not-a-cursor')).json().error.code).toBe(
      'INVALID_CURSOR'
    );
    const future = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    expect(
      (await k.client.get(`/v1/events?from=${future}&to=${future}`)).json().data.items
    ).toEqual([]);
  });

  it('refuses bad queries with a field list: unknown type, limit, window, extra parameter', async () => {
    for (const query of [
      'type=payment.exploded',
      'limit=0',
      'limit=101',
      'limit=abc',
      'from=yesterday',
      'offset=5',
      'from=2020-01-01T00:00:00Z&to=2024-01-01T00:00:00Z',
    ]) {
      const res = await key.client.get(`/v1/events?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error.code, query).toBe('VALIDATION_FAILED');
    }
  });

  it('retrieves one event, and keeps merchants and environments apart', async () => {
    const other = await createMerchant(ctx, { active: true, label: 'events-other' });
    const mine = await emitEvent(ctx, merchant, { type: 'balance.updated' });
    const theirs = await emitEvent(ctx, other, { type: 'balance.updated' });
    const live = await emitEvent(ctx, merchant, { type: 'balance.updated', environment: 'live' });
    expect((await key.client.get(`/v1/events/${mine.ref}`)).json().data.id).toBe(mine.ref);
    for (const ref of [theirs.ref, live.ref, 'evt_01JBX7Q2M4N8R5T6V9W0XYZABC', 'garbage']) {
      const res = await key.client.get(`/v1/events/${ref}`);
      expect(res.statusCode, ref).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const list = (await key.client.get('/v1/events?limit=100')).json().data.items as Array<{
      id: string;
    }>;
    expect(list.map((e) => e.id)).not.toContain(theirs.ref);
    expect(list.map((e) => e.id)).not.toContain(live.ref);
  });

  it('is written in the same transaction as the change: a rolled-back change leaves no event and no outbox row', async () => {
    const events = ctx.app.get(MerchantEventsService, { strict: false });
    const before = await ctx.sql(
      'select count(*)::int as n from core.merchant_events where merchant_id = $1',
      [merchant.id]
    );
    await expect(
      ctx.units.run(async (tx) => {
        await events.emit(tx, {
          merchantId: merchant.id,
          environment: 'test',
          type: 'payment.created',
          resourceType: 'payment',
          resourceId: 'res_rollback',
          object: {},
        });
        throw new Error('the change failed');
      })
    ).rejects.toThrow('the change failed');
    const after = await ctx.sql(
      'select count(*)::int as n from core.merchant_events where merchant_id = $1',
      [merchant.id]
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(
      await ctx.sql("select 1 from core.merchant_events where resource_id = 'res_rollback'")
    ).toHaveLength(0);
  });

  it('is append-only in the database', async () => {
    const { ref } = await emitEvent(ctx, merchant);
    await expect(
      ctx.sql("update core.merchant_events set type = 'payment.failed' where ref = $1", [ref])
    ).rejects.toThrow(/append-only/);
    await expect(ctx.sql('delete from core.merchant_events where ref = $1', [ref])).rejects.toThrow(
      /append-only/
    );
  });

  it('needs events:read', async () => {
    const none = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    expect((await none.client.get('/v1/events')).statusCode).toBe(403);
    expect((await none.client.get('/v1/events/evt_01JBX7Q2M4N8R5T6V9W0XYZABC')).statusCode).toBe(
      403
    );
  });
});

describe('payment and merchant events are created with the state change', () => {
  it('payment.created is written with the payment, with the payment as the API shows it', async () => {
    const res = await key.client.post(
      '/v1/payments',
      { amountMinor: '4321', currency: 'UGX', paymentMethod: { msisdn: '+256700000010' } },
      { 'idempotency-key': `evt-${randomUUID()}` }
    );
    const ref = res.json().data.id as string;
    const events = (await key.client.get('/v1/events?type=payment.created&limit=100')).json().data
      .items as Array<{ resourceId: string; data: { object: Record<string, unknown> } }>;
    const event = events.find((e) => e.resourceId === ref);
    expect(event?.data.object).toMatchObject({
      id: ref,
      status: 'created',
      amountMinor: '4321',
      paymentMethod: { msisdnLast4: '0010' },
    });
    expect(JSON.stringify(event)).not.toContain('+256700000010');
  });

  it('payment.cancelled follows a cancellation, and a replayed creation adds no second event', async () => {
    const body = {
      amountMinor: '4322',
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000011' },
    };
    const headers = { 'idempotency-key': `evt-${randomUUID()}` };
    const first = await key.client.post('/v1/payments', body, headers);
    await key.client.post('/v1/payments', body, headers);
    const ref = first.json().data.id as string;
    await key.client.post(`/v1/payments/${ref}/cancel`);
    await key.client.post(`/v1/payments/${ref}/cancel`);
    const rows = await ctx.sql(
      'select type from core.merchant_events where resource_id = $1 order by created_at, type',
      [ref]
    );
    expect(rows.map((r) => r.type).sort()).toEqual(['payment.cancelled', 'payment.created']);
  });

  it('hold.created and hold.released follow the hold, and balance.updated follows a success', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'holdevents' });
    const k = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['events:read', 'payments:write', 'payments:read', 'balances:read'],
    });
    await earn(m, k.client, '50000');
    const holds = ctx.app.get(HoldsService, { strict: false });
    const placed = await ctx.units.run((tx) =>
      holds.place(tx, {
        merchantId: m.id,
        environment: 'test',
        currency: 'UGX',
        amountMinor: 20_000n,
        reason: 'test',
        idempotencyKey: `h-${randomUUID()}`,
        createdBy: 'system:test',
      })
    );
    await ctx.units.run((tx) => holds.release(tx, placed.hold.id, `r-${randomUUID()}`));
    const types = (
      (await k.client.get('/v1/events?limit=100')).json().data.items as Array<{ type: string }>
    ).map((e) => e.type);
    for (const expected of [
      'payment.created',
      'payment.succeeded',
      'balance.updated',
      'hold.created',
      'hold.released',
    ]) {
      expect(types, expected).toContain(expected);
    }
    const balance = (await k.client.get('/v1/events?type=balance.updated')).json().data.items[0]
      .data.object;
    expect(balance).toMatchObject({
      environment: 'test',
      currency: 'UGX',
      postedMinor: '50000',
      availableMinor: '50000',
    });
  });

  it('merchant.suspended and merchant.activated reach the live event feed', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'lifecycle' });
    const k = await issueKey(ctx, m.owner, { environment: 'live', scopes: ['events:read'] });
    const service = ctx.app.get(MerchantsService, { strict: false });
    await service.transition(m.ref, 'suspend', 'test');
    await service.transition(m.ref, 'activate', 'test');
    const types = ((await k.client.get('/v1/events')).json().data.items as Array<{ type: string }>)
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(['merchant.activated', 'merchant.suspended']);
  });
});

describe('GET /v1/balances, /v1/holds and /v1/balance-transactions', () => {
  it('shows balances per currency, with holds taken out of what is available', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'balances' });
    const k = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['balances:read', 'payments:write', 'payments:read'],
    });
    expect((await k.client.get('/v1/balances')).json().data).toEqual([]);
    await earn(m, k.client, '30000');
    const holds = ctx.app.get(HoldsService, { strict: false });
    await ctx.units.run((tx) =>
      holds.place(tx, {
        merchantId: m.id,
        environment: 'test',
        currency: 'UGX',
        amountMinor: 12_000n,
        reason: 'x',
        idempotencyKey: `h-${randomUUID()}`,
        createdBy: 'system:test',
      })
    );
    expect((await k.client.get('/v1/balances')).json().data).toEqual([
      {
        environment: 'test',
        currency: 'UGX',
        postedMinor: '30000',
        heldMinor: '12000',
        availableMinor: '18000',
        pendingMinor: '0',
        reservedMinor: '0',
      },
    ]);
    // A live key sees nothing of the test balance.
    const live = await issueKey(ctx, m.owner, { environment: 'live', scopes: ['balances:read'] });
    expect((await live.client.get('/v1/balances')).json().data).toEqual([]);
  });

  it('lists holds newest first, by state, with a cursor', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'holds' });
    const k = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['balances:read', 'payments:write'],
    });
    await earn(m, k.client, '90000');
    const holds = ctx.app.get(HoldsService, { strict: false });
    const placed: Array<Awaited<ReturnType<HoldsService['place']>>> = [];
    for (let i = 0; i < 4; i++) {
      ctx.clock.advanceBy(10);
      placed.push(
        await ctx.units.run((tx) =>
          holds.place(tx, {
            merchantId: m.id,
            environment: 'test',
            currency: 'UGX',
            amountMinor: 1000n * BigInt(i + 1),
            reason: 'x',
            idempotencyKey: `h-${randomUUID()}`,
            createdBy: 'system:test',
          })
        )
      );
    }
    await ctx.units.run((tx) =>
      holds.release(tx, placed[0]?.hold.id as string, `r-${randomUUID()}`)
    );
    const all = (await k.client.get('/v1/holds?limit=3')).json().data;
    expect(all.items).toHaveLength(3);
    const rest = (await k.client.get(`/v1/holds?limit=3&cursor=${all.nextCursor}`)).json().data;
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const seen = [...all.items, ...rest.items] as Array<{
      id: string;
      state: string;
      amountMinor: string;
    }>;
    expect(new Set(seen.map((h) => h.id)).size).toBe(4);
    expect(seen[0]).toEqual({
      id: expect.stringMatching(/^hold_/),
      environment: 'test',
      currency: 'UGX',
      amountMinor: expect.any(String),
      state: expect.any(String),
      expiresAt: null,
      createdAt: expect.any(String),
    });
    expect(
      ((await k.client.get('/v1/holds?state=released')).json().data.items as unknown[]).length
    ).toBe(1);
    expect(
      ((await k.client.get('/v1/holds?state=active')).json().data.items as unknown[]).length
    ).toBe(3);
    expect((await k.client.get('/v1/holds?state=captured')).json().data.items).toEqual([]);
    expect(
      (await k.client.get(`/v1/holds?state=active&limit=3&cursor=${all.nextCursor}`)).json().error
        .code
    ).toBe('INVALID_CURSOR');
    expect((await k.client.get('/v1/holds?state=bogus')).statusCode).toBe(400);
    // Another merchant sees none of them.
    const other = await createMerchant(ctx, { active: true, label: 'holds-other' });
    const otherKey = await issueKey(ctx, other.owner, {
      environment: 'test',
      scopes: ['balances:read'],
    });
    expect((await otherKey.client.get('/v1/holds')).json().data.items).toEqual([]);
  });

  it('lists balance movements newest first, by currency, with a cursor, for this merchant and environment only', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'movements' });
    const k = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['balances:read', 'payments:write'],
    });
    const refs = [];
    for (const amount of ['1000', '2000', '3000']) refs.push(await earn(m, k.client, amount));
    const page1 = (await k.client.get(`/v1/balance-transactions?limit=2&${untilNow()}`)).json()
      .data;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await k.client.get(
        `/v1/balance-transactions?limit=2&cursor=${page1.nextCursor}&${untilNow()}`
      )
    ).json().data;
    expect(page2.items).toHaveLength(1);
    const all = [...page1.items, ...page2.items] as Array<Record<string, string>>;
    expect(all.map((e) => String(e.reference)).sort()).toEqual([...refs].sort());
    expect(all[0]).toEqual({
      id: expect.stringMatching(/^je_[0-9A-Z]{26}:\d{3}$/),
      entryId: expect.stringMatching(/^je_/),
      kind: 'collection.succeeded',
      reference: expect.stringMatching(/^pay_/),
      direction: 'credit',
      amountMinor: expect.any(String),
      currency: 'UGX',
      createdAt: expect.any(String),
    });
    expect(all.some((e) => String(e.reference).includes(':'))).toBe(false);
    expect(
      (await k.client.get(`/v1/balance-transactions?currency=KES&${untilNow()}`)).json().data
        .items as unknown[]
    ).toEqual([]);
    expect(
      (
        (await k.client.get(`/v1/balance-transactions?currency=UGX&${untilNow()}`)).json().data
          .items as unknown[]
      ).length
    ).toBe(3);
    expect(
      (
        await k.client.get(
          `/v1/balance-transactions?currency=UGX&limit=2&cursor=${page1.nextCursor}&${untilNow()}`
        )
      ).json().error.code
    ).toBe('INVALID_CURSOR');
    const live = await issueKey(ctx, m.owner, { environment: 'live', scopes: ['balances:read'] });
    expect(
      (await live.client.get(`/v1/balance-transactions?${untilNow()}`)).json().data.items
    ).toEqual([]);
    const other = await createMerchant(ctx, { active: true, label: 'movements-other' });
    const otherKey = await issueKey(ctx, other.owner, {
      environment: 'test',
      scopes: ['balances:read'],
    });
    expect(
      (await otherKey.client.get(`/v1/balance-transactions?${untilNow()}`)).json().data.items
    ).toEqual([]);
    // A merchant without accounts has no movements.
    const ledger = ctx.app.get(LedgerQueryService, { strict: false });
    expect(
      await ledger.merchantMovements(
        { merchantId: randomUUID(), environment: 'test' },
        { limit: 10 }
      )
    ).toEqual({ items: [], nextCursor: null });
  });

  it('needs balances:read, and refuses bad queries', async () => {
    const none = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    for (const url of ['/v1/balances', '/v1/holds', '/v1/balance-transactions']) {
      expect((await none.client.get(url)).statusCode, url).toBe(403);
    }
    expect((await key.client.get('/v1/balance-transactions?currency=XXX')).statusCode).toBe(400);
    expect((await key.client.get('/v1/balance-transactions?limit=500')).statusCode).toBe(400);
  });
});

describe('API request logs', () => {
  it('records each authenticated call without any body, and flushes in the background', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'logs' });
    const k = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['payments:write', 'payments:read'],
    });
    const marker = `BODY-MARKER-${randomUUID()}`;
    const created = await rawRequest(ctx, {
      method: 'POST',
      url: '/v1/payments?secret=QUERY-MARKER',
      key: k.key,
      payload: JSON.stringify({
        amountMinor: '5000',
        currency: 'UGX',
        paymentMethod: { msisdn: '+256700000012' },
        description: marker,
      }),
      headers: {
        'idempotency-key': 'log-key-1',
        'x-request-id': 'client-request-0001',
        'user-agent': 'merchant-sdk/1.2',
      },
      remoteAddress: '198.51.100.20',
    });
    expect(created.statusCode).toBe(201);
    await k.client.get('/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC');
    await k.client.post(
      '/v1/payments',
      { amountMinor: '0', currency: 'UGX' },
      { 'idempotency-key': 'log-key-2' }
    );
    // The response hook only buffers; the flush below is what writes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await ctx.requestLogs.flush()).toBeGreaterThanOrEqual(3);

    const rows = await ctx.sql(
      `select method, path, route, status_code, error_code, idempotency_key, request_id, ip, user_agent, latency_ms, environment
         from core.api_request_logs where merchant_id = $1 order by created_at, ref`,
      [m.id]
    );
    const post = rows.find((r) => r.idempotency_key === 'log-key-1');
    expect(post).toMatchObject({
      method: 'POST',
      path: '/v1/payments',
      route: '/v1/payments',
      status_code: 201,
      error_code: null,
      request_id: 'client-request-0001',
      ip: '198.51.100.20',
      user_agent: 'merchant-sdk/1.2',
      environment: 'test',
    });
    expect(post?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows.find((r) => r.status_code === 404)).toMatchObject({
      route: '/v1/payments/:ref',
      error_code: 'NOT_FOUND',
      method: 'GET',
    });
    expect(rows.find((r) => r.idempotency_key === 'log-key-2')).toMatchObject({
      status_code: 400,
      error_code: 'VALIDATION_FAILED',
    });

    // No body, no query string, no phone number anywhere in the row.
    const dump = await ctx.sql(
      'select row_to_json(l)::text as j from core.api_request_logs l where merchant_id = $1',
      [m.id]
    );
    const text = dump.map((r) => r.j).join('\n');
    for (const forbidden of [
      marker,
      'QUERY-MARKER',
      '+256700000012',
      k.key.split('_')[3] as string,
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    const columns = await ctx.sql(
      "select column_name from information_schema.columns where table_schema = 'core' and table_name = 'api_request_logs'"
    );
    expect(columns.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['body']));
    expect(
      columns.map((c) => String(c.column_name)).some((c) => /body|payload|query/.test(c))
    ).toBe(false);
  });

  it('does not log requests that failed to authenticate', async () => {
    const before = await ctx.sql('select count(*)::int as n from core.api_request_logs');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments',
      remoteAddress: '10.9.9.9',
      headers: { authorization: `Bearer sk_test_${'a'.repeat(16)}_${'b'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ctx.requestLogs.flush();
    const after = await ctx.sql('select count(*)::int as n from core.api_request_logs');
    // Other suites may log in parallel, but nothing was logged for an unknown key.
    expect(after[0]?.n).toBeGreaterThanOrEqual(before[0]?.n as number);
    expect(
      await ctx.sql(
        "select 1 from core.api_request_logs where route = '/v1/payments' and status_code = 401"
      )
    ).toHaveLength(0);
  });

  it('flushes in batches of 500, stores every entry once, and recovers a batch a worker abandoned', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'logs-batch' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['payments:read'] });
    const keyId = String(
      (await ctx.sql('select id from core.api_keys where ref = $1', [k.ref]))[0]?.id
    );
    const entries: RequestLogEntry[] = Array.from({ length: 1230 }, (_, i) => ({
      id: randomUUID(),
      ref: `rl_${'0'.repeat(10)}${randomUUID()
        .replace(/-/g, '')
        .slice(0, 16)
        .toUpperCase()
        .replace(/[ILOU]/g, '1')}`,
      merchantId: m.id,
      environment: 'test',
      apiKeyId: keyId,
      method: 'GET',
      path: '/v1/payments',
      route: '/v1/payments',
      statusCode: 200,
      latencyMs: 3,
      requestId: `req-${i}-padding`,
      idempotencyKey: null,
      ip: '203.0.113.9',
      userAgent: null,
      errorCode: null,
      createdAt: new Date(Date.now() - i).toISOString(),
    }));
    for (const entry of entries) ctx.requestLogBuffer.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await ctx.requestLogBuffer.length()).toBeGreaterThanOrEqual(1230);
    // Flush as the worker does (the buffer is shared with other suites) until ours have landed.
    let stored = 0;
    for (let i = 0; i < 20 && stored < 1230; i++) {
      await ctx.requestLogs.flush();
      stored = Number(
        (
          await ctx.sql(
            'select count(*)::int as n from core.api_request_logs where merchant_id = $1',
            [m.id]
          )
        )[0]?.n
      );
    }
    expect(stored).toBe(1230);
    // Inserting the same entries again (a crashed worker's batch, claimed twice) stores nothing new.
    expect(
      await ctx.app.get(RequestLogRepository, { strict: false }).insertBatch(entries.slice(0, 600))
    ).toBe(0);
    expect(
      Number(
        (
          await ctx.sql(
            'select count(*)::int as n from core.api_request_logs where merchant_id = $1',
            [m.id]
          )
        )[0]?.n
      )
    ).toBe(1230);
  }, 60_000);

  it('lists the merchant’s logs on the dashboard: filters, cursor, one entry, and isolation', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'logs-dash' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['payments:read'] });
    for (let i = 0; i < 4; i++)
      await rawRequest(ctx, {
        method: 'GET',
        url: '/v1/payments',
        key: k.key,
        headers: { 'x-request-id': `dash-request-${i}-xx` },
      });
    await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC',
      key: k.key,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await ctx.requestLogs.flush();
    const base = '/dashboard/v1/request-logs?environment=test';
    const page1 = (await m.owner.client.get(`${base}&limit=2&${untilNow()}`)).json().data;
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await m.owner.client.get(`${base}&limit=2&cursor=${page1.nextCursor}&${untilNow()}`)
    ).json().data;
    const page3 = (
      await m.owner.client.get(`${base}&limit=2&cursor=${page2.nextCursor}&${untilNow()}`)
    ).json().data;
    expect(
      new Set([...page1.items, ...page2.items, ...page3.items].map((l: { id: string }) => l.id))
        .size
    ).toBe(5);
    expect(
      (await m.owner.client.get(`${base}&statusCode=404&${untilNow()}`)).json().data.items
    ).toHaveLength(1);
    expect(
      (await m.owner.client.get(`${base}&requestId=dash-request-2-xx&${untilNow()}`)).json().data
        .items
    ).toHaveLength(1);
    expect(
      (await m.owner.client.get(`${base}&method=POST&${untilNow()}`)).json().data.items
    ).toEqual([]);
    expect(
      (await m.owner.client.get(`${base}&statusCode=404&limit=2&cursor=${page1.nextCursor}`)).json()
        .error.code
    ).toBe('INVALID_CURSOR');
    const one = page1.items[0] as { id: string; apiKeyId: string };
    const detail = await m.owner.client.get(
      `/dashboard/v1/request-logs/${one.id}?environment=test`
    );
    expect(detail.json().data).toMatchObject({
      id: one.id,
      apiKeyId: k.ref,
      method: 'GET',
      environment: 'test',
    });
    expect(Object.keys(detail.json().data).sort()).toEqual(
      [
        'apiKeyId',
        'createdAt',
        'environment',
        'errorCode',
        'id',
        'idempotencyKey',
        'ip',
        'latencyMs',
        'method',
        'path',
        'requestId',
        'route',
        'statusCode',
        'userAgent',
      ].sort()
    );
    const other = await createMerchant(ctx, { label: 'logs-dash-other' });
    expect(
      (await other.owner.client.get(`/dashboard/v1/request-logs/${one.id}?environment=test`))
        .statusCode
    ).toBe(404);
    expect((await other.owner.client.get(`${base}&${untilNow()}`)).json().data.items).toEqual([]);
    expect(
      (await m.owner.client.get(`/dashboard/v1/request-logs/${one.id}?environment=live`)).statusCode
    ).toBe(404);
    expect(
      (await m.owner.client.get('/dashboard/v1/request-logs/not-a-ref?environment=test')).statusCode
    ).toBe(404);
    const viewer = await addTeamMember(ctx, m.owner, 'viewer');
    expect((await viewer.client.get(`${base}`)).statusCode).toBe(403);
    const support = await addTeamMember(ctx, m.owner, 'support');
    expect((await support.client.get(`${base}&${untilNow()}`)).statusCode).toBe(200);
  });

  it('the database refuses to change or delete a log', async () => {
    const m = await createMerchant(ctx, { active: true, label: 'logs-immutable' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['payments:read'] });
    await k.client.get('/v1/payments');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ctx.requestLogs.flush();
    await expect(
      ctx.sql('update core.api_request_logs set status_code = 200 where merchant_id = $1', [m.id])
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.sql('delete from core.api_request_logs where merchant_id = $1', [m.id])
    ).rejects.toThrow(/append-only/);
  });
});

describe('the outbox', () => {
  const quiet = pino({ level: 'silent' });

  async function seed(count: number, type: string): Promise<string[]> {
    const outbox = ctx.app.get(OutboxService, { strict: false });
    const ids = Array.from({ length: count }, () => randomUUID());
    await ctx.units.run(async (tx) => {
      for (const id of ids) {
        await outbox.enqueue(tx, {
          eventType: type,
          aggregateType: 'test',
          aggregateId: id,
          payload: { id },
          dedupeKey: `${type}:${id}`,
        });
      }
    });
    return ids;
  }

  function dispatcher(
    type: string,
    handle: (id: string) => Promise<void> | void,
    queues = ctx.queues
  ): OutboxDispatcher {
    return new OutboxDispatcher(
      ctx.app.get(OutboxRepository, { strict: false }),
      ctx.units,
      queues,
      [
        {
          eventType: type,
          handle: async (_tx, row) => {
            await handle(row.aggregateId);
            return [];
          },
        },
      ],
      ctx.clock,
      quiet
    );
  }

  it('claims each row once however many dispatchers run at the same time (SKIP LOCKED)', async () => {
    const type = `test.concurrent_${Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, 'x')}`;
    const ids = await seed(300, type);
    const handled = new Map<string, number>();
    const run = dispatcher(type, (id) => void handled.set(id, (handled.get(id) ?? 0) + 1));
    const counts = await Promise.all([
      run.dispatch(),
      dispatcher(type, (id) => void handled.set(id, (handled.get(id) ?? 0) + 1)).dispatch(),
      dispatcher(type, (id) => void handled.set(id, (handled.get(id) ?? 0) + 1)).dispatch(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(300);
    expect([...handled.keys()].sort()).toEqual([...ids].sort());
    expect([...handled.values()].every((n) => n === 1)).toBe(true);
    expect(
      await ctx.sql('select 1 from core.outbox where event_type = $1 and published_at is null', [
        type,
      ])
    ).toHaveLength(0);
  });

  it('is idempotent to enqueue: the same business fact is one row', async () => {
    const outbox = ctx.app.get(OutboxService, { strict: false });
    const type = 'test.dedupe_row';
    const id = randomUUID();
    const once = await ctx.units.run((tx) =>
      outbox.enqueue(tx, {
        eventType: type,
        aggregateType: 't',
        aggregateId: id,
        payload: {},
        dedupeKey: `${type}:${id}`,
      })
    );
    const twice = await ctx.units.run((tx) =>
      outbox.enqueue(tx, {
        eventType: type,
        aggregateType: 't',
        aggregateId: id,
        payload: {},
        dedupeKey: `${type}:${id}`,
      })
    );
    expect([once, twice]).toEqual([true, false]);
    expect(
      await ctx.sql('select 1 from core.outbox where dedupe_key = $1', [`${type}:${id}`])
    ).toHaveLength(1);
  });

  it('retries a failing row with backoff, then leaves it for an operator after the attempt limit', async () => {
    const type = `test.failing_${Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'y')}`;
    const [id] = await seed(1, type);
    let calls = 0;
    const run = dispatcher(type, () => {
      calls += 1;
      throw new Error('handler exploded');
    });
    expect(await run.dispatch()).toBe(0);
    const row = async () =>
      (
        await ctx.sql(
          'select attempts, last_error, available_at, published_at, locked_at from core.outbox where aggregate_id = $1',
          [id]
        )
      )[0];
    expect(await row()).toMatchObject({
      attempts: 1,
      last_error: 'handler exploded',
      published_at: null,
      locked_at: null,
    });
    // Not due again until the backoff has passed (2 seconds on the app clock).
    expect(await run.dispatch()).toBe(0);
    expect(calls).toBe(1);
    for (let attempt = 2; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      ctx.clock.advanceBy(10 * 60_000);
      await run.dispatch();
    }
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await row())?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Exhausted rows are no longer claimed.
    ctx.clock.advanceBy(10 * 60_000);
    await run.dispatch();
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await row())?.published_at).toBeNull();
    ctx.clock.advanceBy(-OUTBOX_MAX_ATTEMPTS * 10 * 60_000 - 10 * 60_000);
    const stats = await ctx.app.get(OutboxRepository, { strict: false }).pendingCount();
    expect(stats.exhausted).toBeGreaterThanOrEqual(1);
  });

  it('takes a row again when its worker died holding the claim for over 60 seconds', async () => {
    const type = `test.abandoned_${Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'z')}`;
    const [id] = await seed(1, type);
    await ctx.sql(
      "update core.outbox set locked_at = $2::timestamptz - interval '30 seconds', locked_by = 'dead', attempts = 1 where aggregate_id = $1",
      [id, ctx.clock.now().toISOString()]
    );
    let calls = 0;
    const run = dispatcher(type, () => void (calls += 1));
    expect(await run.dispatch()).toBe(0);
    expect(calls).toBe(0);
    await ctx.sql(
      "update core.outbox set locked_at = $2::timestamptz - interval '61 seconds' where aggregate_id = $1",
      [id, ctx.clock.now().toISOString()]
    );
    expect(await run.dispatch()).toBe(1);
    expect(calls).toBe(1);
  });

  it('does not mark a row published when its queue jobs cannot be published, and retries them', async () => {
    const type = `test.queuedown_${Math.random().toString(36).slice(2, 6).replace(/[0-9]/g, 'q')}`;
    const [id] = await seed(1, type);
    let failures = 1;
    const added: string[] = [];
    const fakeQueues = {
      get: () => ({
        add: (name: string) => {
          if (failures-- > 0) return Promise.reject(new Error('redis down'));
          added.push(name);
          return Promise.resolve({});
        },
      }),
    } as unknown as QueueRegistry;
    const run = new OutboxDispatcher(
      ctx.app.get(OutboxRepository, { strict: false }),
      ctx.units,
      fakeQueues,
      [
        {
          eventType: type,
          handle: () => Promise.resolve([{ queue: QUEUE_NAME, name: 'job', data: { id: 'x' } }]),
        },
      ],
      ctx.clock,
      quiet
    );
    expect(await run.dispatch()).toBe(0);
    expect(
      (await ctx.sql('select published_at from core.outbox where aggregate_id = $1', [id]))[0]
        ?.published_at
    ).toBeNull();
    ctx.clock.advanceBy(60_000);
    expect(await run.dispatch()).toBe(1);
    expect(added).toEqual(['job']);
    ctx.clock.advanceBy(-60_000);
  });

  it('leaves rows it has no handler for alone, so another deployment can take them', async () => {
    const type = `test.nohandler_${Math.random().toString(36).slice(2, 6).replace(/[0-9]/g, 'n')}`;
    const [id] = await seed(1, type);
    const run = dispatcher('test.other_type', () => undefined);
    await run.dispatch();
    expect(
      (
        await ctx.sql('select attempts, locked_at from core.outbox where aggregate_id = $1', [id])
      )[0]
    ).toMatchObject({ attempts: 0, locked_at: null });
  });
});

const QUEUE_NAME = 'webhook-delivery' as const;
