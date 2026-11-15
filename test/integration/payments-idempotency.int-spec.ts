/**
 * Idempotency of creating requests (spec 8.2, 12): duplicate requests, concurrent requests,
 * a reused key, a failed request that must stay retryable, key expiry, and Redis as a hint
 * and not the authority.
 */
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { IdempotencyMarker } from '../../src/common/idempotency/idempotency-marker';
import { REDIS } from '../../src/common/redis/redis.module';
import { idempotencyReplays } from '../../src/common/telemetry/metrics';
import { Client } from '../support/identity';
import {
  createTestMerchant,
  idempotencyKey,
  postPayment,
  sql,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';
import type { Redis } from 'ioredis';

let ctx: PaymentsContext;
let merchant: TestMerchant;

beforeAll(async () => {
  ctx = await startPaymentsContext({ DB_POOL_MAX: '30' });
  merchant = await createTestMerchant(ctx, { active: true, label: 'idem' });
});

afterAll(async () => {
  await ctx?.close();
});

async function paymentCount(key: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    'select count(*)::int as n from core.payments where merchant_id = $1 and idempotency_key = $2',
    [merchant.id, key]
  );
  return rows[0]?.n ?? 0;
}

async function replayCount(scope: string): Promise<number> {
  const metric = await idempotencyReplays.get();
  return metric.values.find((v) => v.labels.scope === scope)?.value ?? 0;
}

describe('the Idempotency-Key header', () => {
  it('is required on every creating route', async () => {
    for (const [url, body] of [
      [
        '/v1/payments',
        { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: '+256700000001' } },
      ],
      ['/v1/payment-links', { title: 't', currency: 'UGX' }],
      ['/v1/checkout-sessions', { amountMinor: '1000', currency: 'UGX' }],
    ] as const) {
      const res = await merchant.test.post(url, body);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });

  it('must be 1 to 255 printable characters', async () => {
    for (const key of ['', 'x'.repeat(256), 'has space', 'tab\there', 'caf\u00e9']) {
      const res = await merchant.test.post(
        '/v1/payments',
        { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: '+256700000001' } },
        { 'idempotency-key': key }
      );
      expect(res.statusCode, JSON.stringify(key)).toBe(400);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    expect((await postPayment(merchant.test, {}, 'x'.repeat(255))).statusCode).toBe(201);
    expect((await postPayment(merchant.test, {}, 'a')).statusCode).toBe(201);
  });

  it('is checked after authentication: an anonymous caller gets 401 not 400', async () => {
    expect((await new Client(ctx.app).post('/v1/payments', {})).statusCode).toBe(401);
  });
});

describe('duplicate requests', () => {
  it('return the first response with Idempotency-Replayed, and create one payment', async () => {
    const key = idempotencyKey();
    const before = await replayCount('payments.create');
    const first = await postPayment(merchant.test, { description: 'once' }, key);
    const second = await postPayment(merchant.test, { description: 'once' }, key);
    const third = await postPayment(merchant.test, { description: 'once' }, key);
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(third.headers['idempotency-replayed']).toBe('true');
    expect(second.json().data).toEqual(first.json().data);
    expect(third.json().data).toEqual(first.json().data);
    expect(await paymentCount(key)).toBe(1);
    expect(await replayCount('payments.create')).toBe(before + 2);
    // Each response has its own request id; the data is what repeats.
    expect(second.json().meta.requestId).not.toBe(first.json().meta.requestId);
  });

  it('write one audit row and one first event, however often the request is repeated', async () => {
    const key = idempotencyKey();
    const first = await postPayment(merchant.test, {}, key);
    await postPayment(merchant.test, {}, key);
    await postPayment(merchant.test, {}, key);
    const id = first.json().data.id as string;
    const audit = await sql(
      `select 1 from core.audit_logs where resource_id = $1 and action = 'payment.created'`,
      [id]
    );
    expect(audit).toHaveLength(1);
    const events = await sql(
      `select 1 from core.transaction_events e join core.transaction_keys k on k.id = e.transaction_id where k.ref = $1`,
      [first.json().data.transactionId]
    );
    expect(events).toHaveLength(1);
  });

  it('replay the stored response even after the payment has moved on', async () => {
    const key = idempotencyKey();
    const first = await postPayment(merchant.test, {}, key);
    const id = first.json().data.id as string;
    expect((await merchant.test.post(`/v1/payments/${id}/cancel`, {})).statusCode).toBe(200);
    const replay = await postPayment(merchant.test, {}, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data.status).toBe('created');
    expect((await merchant.test.get(`/v1/payments/${id}`)).json().data.status).toBe('cancelled');
  });

  it('treat a different key order or whitespace in the JSON as the same body', async () => {
    const key = idempotencyKey();
    const body =
      '{"currency":"UGX","amountMinor":"1234","paymentMethod":{"msisdn":"+256700000001"}}';
    const reordered =
      '{ "paymentMethod": { "msisdn": "+256700000001" }, "amountMinor": "1234", "currency": "UGX" }';
    const headers = { 'idempotency-key': key, 'content-type': 'application/json' };
    const a = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...headers, authorization: `Bearer ${merchant.testKey}` },
      payload: body,
    });
    const b = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...headers, authorization: `Bearer ${merchant.testKey}` },
      payload: reordered,
    });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect(await paymentCount(key)).toBe(1);
  });

  it('are independent per operation: one key may start a payment and a payment link', async () => {
    const key = idempotencyKey();
    expect((await postPayment(merchant.test, {}, key)).statusCode).toBe(201);
    const link = await merchant.test.post(
      '/v1/payment-links',
      { title: 'shared key', currency: 'UGX' },
      { 'idempotency-key': key }
    );
    expect(link.statusCode).toBe(201);
    expect(link.headers['idempotency-replayed']).toBeUndefined();
  });
});

describe('a reused key with a different request', () => {
  it('is a 409 IDEMPOTENCY_KEY_REUSED and creates nothing', async () => {
    const key = idempotencyKey();
    const first = await postPayment(merchant.test, { amountMinor: '1000' }, key);
    expect(first.statusCode).toBe(201);
    for (const body of [{ amountMinor: '2000' }, { currency: 'KES' }, { description: 'x' }]) {
      const res = await postPayment(merchant.test, body, key);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await paymentCount(key)).toBe(1);
    // The original still replays.
    expect((await postPayment(merchant.test, { amountMinor: '1000' }, key)).statusCode).toBe(201);
  });

  it('is decided by Postgres even if Redis lost the marker', async () => {
    const redis = ctx.app.get<Redis>(REDIS, { strict: false });
    const key = idempotencyKey();
    expect((await postPayment(merchant.test, { amountMinor: '1000' }, key)).statusCode).toBe(201);
    await redis.del(
      IdempotencyMarker.redisKey(merchant.scope(), {
        operation: 'payments.create',
        key,
        fingerprint: '',
      })
    );
    const res = await postPayment(merchant.test, { amountMinor: '3000' }, key);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await paymentCount(key)).toBe(1);
  });

  it('still replays when Redis lost the marker', async () => {
    const redis = ctx.app.get<Redis>(REDIS, { strict: false });
    const key = idempotencyKey();
    const first = await postPayment(merchant.test, {}, key);
    await redis.del(
      IdempotencyMarker.redisKey(merchant.scope(), {
        operation: 'payments.create',
        key,
        fingerprint: '',
      })
    );
    const again = await postPayment(merchant.test, {}, key);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json().data.id).toBe(first.json().data.id);
  });
});

describe('a request that fails', () => {
  it('leaves no key behind, so the corrected request can use the same key', async () => {
    const key = idempotencyKey();
    const invalid = await postPayment(merchant.test, { amountMinor: '0' }, key);
    expect(invalid.statusCode).toBe(400);
    const tooLarge = await postPayment(merchant.test, { amountMinor: '100000000000' }, key);
    expect(tooLarge.statusCode).toBe(422);
    const rows = await sql(
      'select 1 from core.idempotency_keys where merchant_id = $1 and key = $2',
      [merchant.id, key]
    );
    expect(rows).toHaveLength(0);
    const fixed = await postPayment(merchant.test, { amountMinor: '1000' }, key);
    expect(fixed.statusCode).toBe(201);
    expect(fixed.headers['idempotency-replayed']).toBeUndefined();
    expect(await paymentCount(key)).toBe(1);
  });

  it('rolls back everything the work did, including the transaction row', async () => {
    const key = idempotencyKey();
    const before = await sql<{ n: number }>(
      'select count(*)::int as n from core.transaction_keys where merchant_id = $1',
      [merchant.id]
    );
    // A rejected msisdn is found after the ids exist but before any row is written.
    const res = await postPayment(merchant.test, { channel: 'card' }, key);
    expect(res.statusCode).toBe(422);
    const after = await sql<{ n: number }>(
      'select count(*)::int as n from core.transaction_keys where merchant_id = $1',
      [merchant.id]
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('concurrent requests', () => {
  it('50 identical requests create one payment and answer with the same payment', async () => {
    const key = idempotencyKey();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => postPayment(merchant.test, { amountMinor: '7777' }, key))
    );
    const codes = responses.map((r) => r.statusCode);
    // Duplicates wait on the first request and replay it. A duplicate that waited past the
    // lock timeout would get 409 REQUEST_IN_PROGRESS; nothing else is acceptable.
    for (const res of responses) {
      expect([201, 409]).toContain(res.statusCode);
      if (res.statusCode === 409) expect(res.json().error.code).toBe('REQUEST_IN_PROGRESS');
    }
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    const created = responses.filter(
      (r) => r.statusCode === 201 && r.headers['idempotency-replayed'] === undefined
    );
    expect(created).toHaveLength(1);
    const ids = new Set(responses.filter((r) => r.statusCode === 201).map((r) => r.json().data.id));
    expect(ids).toEqual(new Set([created[0]?.json().data.id]));
    expect(await paymentCount(key)).toBe(1);
    const audit = await sql(
      `select 1 from core.audit_logs where resource_id = $1 and action = 'payment.created'`,
      [created[0]?.json().data.id]
    );
    expect(audit).toHaveLength(1);
    // And now that it has finished, a retry always replays.
    const retry = await postPayment(merchant.test, { amountMinor: '7777' }, key);
    expect(retry.headers['idempotency-replayed']).toBe('true');
  });

  it('50 requests with one key and different bodies create exactly one payment', async () => {
    const key = idempotencyKey();
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        postPayment(merchant.test, { amountMinor: String(1000 + i) }, key)
      )
    );
    const winners = responses.filter((r) => r.statusCode === 201);
    expect(winners).toHaveLength(1);
    for (const res of responses.filter((r) => r.statusCode !== 201)) {
      expect(res.statusCode).toBe(409);
      expect(['IDEMPOTENCY_KEY_REUSED', 'REQUEST_IN_PROGRESS']).toContain(res.json().error.code);
    }
    expect(await paymentCount(key)).toBe(1);
  });

  it('50 requests with different keys create 50 payments', async () => {
    const merchantB = await createTestMerchant(ctx, { label: 'many' });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => postPayment(merchantB.test))
    );
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(50);
    const rows = await sql<{ n: number }>(
      'select count(*)::int as n from core.payments where merchant_id = $1',
      [merchantB.id]
    );
    expect(rows[0]?.n).toBe(50);
  });
});

describe('a request that arrives while the first is still running', () => {
  it('waits, then answers 409 REQUEST_IN_PROGRESS with Retry-After, and succeeds once it is gone', async () => {
    const key = idempotencyKey();
    // Hold an uncommitted claim for the key, as a slow first request would.
    const holder = new PgClient({ connectionString: inject('databaseUrls').superuser });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(
        `insert into core.idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, locked_at, expires_at)
         values (gen_random_uuid(), $1, 'test', 'payments.create', $2, repeat('a', 64), 'in_flight', now(), now() + interval '1 day')`,
        [merchant.id, key]
      );
      const started = Date.now();
      const res = await postPayment(merchant.test, {}, key);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('REQUEST_IN_PROGRESS');
      expect(res.headers['retry-after']).toBe('2');
      expect(await paymentCount(key)).toBe(0);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    // The holder rolled back, as a crashed first request would. Nothing is stuck.
    const retry = await postPayment(merchant.test, {}, key);
    expect(retry.statusCode).toBe(201);
    expect(await paymentCount(key)).toBe(1);
  });
});

describe('key expiry', () => {
  it('does not let a key older than 24 hours create a second payment', async () => {
    const key = idempotencyKey();
    const first = await postPayment(merchant.test, {}, key);
    expect(first.statusCode).toBe(201);
    ctx.clock.advanceBy(25 * 3600 * 1000);
    // The record has expired, but the payment it made still holds the key: a retry must
    // not turn into a second payment.
    const again = await postPayment(merchant.test, {}, key);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await paymentCount(key)).toBe(1);
    // A fresh key still works after the clock moved.
    expect((await postPayment(merchant.test)).statusCode).toBe(201);
  });

  it('recycles an expired record for a new request on another operation key', async () => {
    const key = idempotencyKey();
    const link = { title: 'recycle', currency: 'UGX' };
    const first = await merchant.test.post('/v1/payment-links', link, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    ctx.clock.advanceBy(25 * 3600 * 1000);
    // The same key and body after expiry runs again: links carry no unique key of their own.
    const second = await merchant.test.post('/v1/payment-links', link, { 'idempotency-key': key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
    expect(second.json().data.id).not.toBe(first.json().data.id);
    const rows = await sql(
      `select status from core.idempotency_keys where merchant_id = $1 and key = $2`,
      [merchant.id, key]
    );
    expect(rows).toEqual([{ status: 'completed' }]);
  });
});

describe('what is stored', () => {
  it('keeps the response of a completed request and never a client secret', async () => {
    const key = idempotencyKey();
    const first = await merchant.test.post(
      '/v1/checkout-sessions',
      { amountMinor: '5000', currency: 'UGX' },
      { 'idempotency-key': key }
    );
    expect(first.statusCode).toBe(201);
    const secret = first.json().data.clientSecret as string;
    expect(secret).toMatch(/^cs_[0-9A-HJKMNP-TV-Z]{26}_secret_/);
    const replay = await merchant.test.post(
      '/v1/checkout-sessions',
      { amountMinor: '5000', currency: 'UGX' },
      { 'idempotency-key': key }
    );
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data.clientSecret).toBeNull();
    expect(replay.json().data.id).toBe(first.json().data.id);
    const [row] = await sql<{ status: string; response_status: number; body: string }>(
      `select status, response_status, response_body::text as body from core.idempotency_keys
        where merchant_id = $1 and key = $2`,
      [merchant.id, key]
    );
    expect(row?.status).toBe('completed');
    expect(row?.response_status).toBe(201);
    expect(row?.body).not.toContain(secret.split('_secret_')[1]);
    const [session] = await sql<{ hash: string }>(
      'select client_secret_hash as hash from core.checkout_sessions where ref = $1',
      [first.json().data.id]
    );
    expect(session?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.hash).not.toContain(secret);
  });
});
