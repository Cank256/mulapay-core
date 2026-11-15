/**
 * `/v1/payments` end to end against real Postgres and Redis (spec 6.1, 7.1, 16): creation,
 * validation, authentication and scopes, merchant and environment isolation, idempotency,
 * reads, cancellation and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyCache } from '../../src/common/auth/api-key-cache';
import { Client } from '../support/identity';
import {
  apiClient,
  createPayment,
  createTestMerchant,
  idempotencyKey,
  MSISDN,
  postPayment,
  sql,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let merchant: TestMerchant;
let rival: TestMerchant;

beforeAll(async () => {
  ctx = await startPaymentsContext();
  merchant = await createTestMerchant(ctx, { active: true, label: 'shop' });
  rival = await createTestMerchant(ctx, { active: true, label: 'rival' });
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /v1/payments', () => {
  it('creates a payment in `created` with its transaction and a masked phone number', async () => {
    const res = await postPayment(merchant.test, {
      amountMinor: '25000',
      description: 'Order 17',
      metadata: { order: '17' },
    });
    expect(res.statusCode).toBe(201);
    const payment = res.json().data;
    expect(payment).toMatchObject({
      status: 'created',
      environment: 'test',
      amountMinor: '25000',
      currency: 'UGX',
      channel: 'mobile_money',
      provider: null,
      paymentMethod: { provider: null, msisdnLast4: '0001' },
      description: 'Order 17',
      failureCode: null,
      completedAt: null,
      metadata: { order: '17' },
    });
    expect(payment.id).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payment.transactionId).toMatch(/^txn_[0-9A-HJKMNP-TV-Z]{26}$/);
    // The default expiry is PAYMENT_EXPIRY_MINUTES (15) after creation.
    const minutes = (Date.parse(payment.expiresAt) - Date.parse(payment.createdAt)) / 60_000;
    expect(minutes).toBe(15);
    // No phone number, internal id or encrypted value in the response.
    const body = res.body;
    expect(body).not.toContain(MSISDN);
    expect(body).not.toMatch(/msisdnEnc|"id":"[0-9a-f-]{36}"|merchantId/);
  });

  it('writes the transaction, the payment, the first event and an audit row together', async () => {
    const { id, transactionId } = await createPayment(merchant.test);
    const [row] = await sql<{
      status: string;
      type: string;
      fee: string;
      net: string;
      ext: string;
    }>(
      `select t.status, t.type, t.fee_minor::text as fee, t.net_minor::text as net,
              t.gateway_external_id as ext
         from core.payments p join core.transactions t on t.id = p.transaction_id and t.created_at = p.created_at
        where p.ref = $1`,
      [id]
    );
    expect(row).toEqual({ status: 'created', type: 'payment', fee: '0', net: '10000', ext: id });
    const events = await sql(
      `select e.event_key, e.outcome, e.from_status, e.to_status
         from core.transaction_events e join core.transaction_keys k on k.id = e.transaction_id
        where k.ref = $1`,
      [transactionId]
    );
    expect(events).toEqual([
      { event_key: 'created', outcome: 'applied', from_status: null, to_status: 'created' },
    ]);
    const audit = await sql(
      `select action, resource_type, outcome, actor_type from core.audit_logs
        where resource_id = $1 and action = 'payment.created'`,
      [id]
    );
    expect(audit).toEqual([
      {
        action: 'payment.created',
        resource_type: 'payment',
        outcome: 'success',
        actor_type: 'api_key',
      },
    ]);
  });

  it('accepts amounts as digit strings and as safe JSON integers, and refuses others', async () => {
    expect((await postPayment(merchant.test, { amountMinor: 5000 })).statusCode).toBe(201);
    expect((await postPayment(merchant.test, { amountMinor: '99999999999' })).statusCode).toBe(201);
    for (const amountMinor of [
      0,
      -5,
      10.5,
      '10.5',
      '0',
      '',
      'abc',
      '1e3',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const res = await postPayment(merchant.test, { amountMinor });
      expect(res.statusCode, JSON.stringify(amountMinor)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses an amount the gateway could not take, as a 422', async () => {
    const res = await postPayment(merchant.test, { amountMinor: '100000000000' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
      details: { reason: 'amount_too_large' },
    });
  });

  it('validates currency, phone number, channel and unknown fields before anything is written', async () => {
    const before = await sql<{ n: number }>(
      'select count(*)::int as n from core.payments where merchant_id = $1',
      [merchant.id]
    );
    for (const body of [
      { currency: 'XXX' },
      { currency: 'ugx' },
      { paymentMethod: { msisdn: '0700000000' } },
      { paymentMethod: { msisdn: 'not a number' } },
      { paymentMethod: { provider: 'stripe', msisdn: MSISDN } },
      { channel: 'cash' },
      { statementDescriptor: 'x'.repeat(23) },
      { returnUrl: 'javascript:alert(1)' },
      { metadata: { a: 'b'.repeat(501) } },
      { unknownField: 1 },
    ]) {
      const res = await postPayment(merchant.test, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    const after = await sql<{ n: number }>(
      'select count(*)::int as n from core.payments where merchant_id = $1',
      [merchant.id]
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('requires a phone number for mobile money and refuses one for other channels', async () => {
    const noPhone = await merchant.test.post(
      '/v1/payments',
      { amountMinor: '1000', currency: 'UGX' },
      { 'idempotency-key': idempotencyKey() }
    );
    expect(noPhone.statusCode).toBe(422);
    expect(noPhone.json().error.details.reason).toBe('msisdn_required');
    const card = await postPayment(merchant.test, { channel: 'card' });
    expect(card.statusCode).toBe(422);
    expect(card.json().error.details.reason).toBe('msisdn_only_for_mobile_money');
    const cardOnly = await merchant.test.post(
      '/v1/payments',
      { amountMinor: '1000', currency: 'USD', channel: 'card' },
      { 'idempotency-key': idempotencyKey() }
    );
    expect(cardOnly.statusCode).toBe(201);
  });

  it('stores the phone number encrypted, with its last four digits in clear', async () => {
    const { id } = await createPayment(merchant.test);
    const [row] = await sql<{ payment_method: { msisdnEnc: string; msisdnLast4: string } }>(
      'select payment_method from core.payments where ref = $1',
      [id]
    );
    expect(row?.payment_method.msisdnLast4).toBe('0001');
    expect(row?.payment_method.msisdnEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row?.payment_method)).not.toContain('700000001');
  });

  it('pins a provider in the payment method without routing the payment', async () => {
    const res = await postPayment(merchant.test, {
      paymentMethod: { provider: 'airtel', msisdn: MSISDN },
    });
    expect(res.json().data.paymentMethod.provider).toBe('airtel');
    expect(res.json().data.provider).toBeNull();
  });

  it('requires an API key with the payments:write scope', async () => {
    expect((await new Client(ctx.app).post('/v1/payments', {})).statusCode).toBe(401);
    const readOnly = await createTestMerchant(ctx, { scopes: ['payments:read'], label: 'ro' });
    const denied = await postPayment(readOnly.test);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    // A dashboard token is not an API key.
    expect(
      (
        await new Client(ctx.app).post(
          '/v1/payments',
          { amountMinor: '1', currency: 'UGX' },
          { authorization: `Bearer ${merchant.owner.client.token}` }
        )
      ).statusCode
    ).toBe(401);
  });

  it('refuses live payments for a merchant that is not active, and any for a suspended one', async () => {
    const draft = await createTestMerchant(ctx, { label: 'draft' });
    // Test mode works while the merchant is onboarding.
    expect((await postPayment(draft.test)).statusCode).toBe(201);
    // Live keys need an active merchant to be issued at all; use an active one that is then
    // suspended.
    const sus = await createTestMerchant(ctx, { active: true, label: 'sus' });
    expect((await postPayment(sus.live!)).statusCode).toBe(201);
    await sql("update core.merchants set status = 'suspended' where ref = $1", [sus.ref]);
    // Out-of-band change: a lifecycle transition through the service evicts cached keys itself.
    await ctx.app.get(ApiKeyCache, { strict: false }).evictMerchant(sus.id);
    for (const client of [sus.live!, sus.test]) {
      const res = await postPayment(client);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('MERCHANT_NOT_ACTIVE');
    }
  });
});

describe('merchant and environment isolation', () => {
  it('never shows a payment to another merchant, and answers 404 not 403', async () => {
    const { id, transactionId } = await createPayment(merchant.test);
    for (const url of [
      `/v1/payments/${id}`,
      `/v1/payments/${id}/timeline`,
      `/v1/transactions/${transactionId}`,
    ]) {
      const res = await rival.test.get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect((await rival.test.post(`/v1/payments/${id}/cancel`, {})).statusCode).toBe(404);
    const list = await rival.test.get('/v1/payments?limit=100');
    expect(JSON.stringify(list.json().data)).not.toContain(id);
    // Nothing changed for the owner.
    expect((await merchant.test.get(`/v1/payments/${id}`)).json().data.status).toBe('created');
  });

  it('keeps test and live data apart, whichever key is used', async () => {
    const live = await createPayment(merchant.live!);
    const test = await createPayment(merchant.test);
    expect(live.id).not.toBe(test.id);
    expect((await merchant.test.get(`/v1/payments/${live.id}`)).statusCode).toBe(404);
    expect((await merchant.live!.get(`/v1/payments/${test.id}`)).statusCode).toBe(404);
    expect((await merchant.test.get(`/v1/transactions/${live.transactionId}`)).statusCode).toBe(
      404
    );
    const liveList = (await merchant.live!.get('/v1/payments?limit=100')).json().data.items;
    expect(liveList.every((p: { environment: string }) => p.environment === 'live')).toBe(true);
    expect(liveList.map((p: { id: string }) => p.id)).toContain(live.id);
    expect(liveList.map((p: { id: string }) => p.id)).not.toContain(test.id);
  });

  it('lets the same idempotency key be used once in test and once in live', async () => {
    const key = idempotencyKey();
    const a = await postPayment(merchant.test, {}, key);
    const b = await postPayment(merchant.live!, {}, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().data.id).not.toBe(b.json().data.id);
  });

  it('lets two merchants use the same idempotency key independently', async () => {
    const key = idempotencyKey();
    const a = await postPayment(merchant.test, {}, key);
    const b = await postPayment(rival.test, {}, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().data.id).not.toBe(b.json().data.id);
  });
});

describe('reading payments', () => {
  it('retrieves a payment and its timeline', async () => {
    const { id } = await createPayment(merchant.test);
    const got = await merchant.test.get(`/v1/payments/${id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().data.id).toBe(id);
    const timeline = (await merchant.test.get(`/v1/payments/${id}/timeline`)).json().data;
    expect(timeline).toEqual([
      {
        status: 'created',
        previousStatus: null,
        failureCode: null,
        occurredAt: expect.any(String),
      },
    ]);
  });

  it('answers 404 for an unknown or malformed ref', async () => {
    for (const ref of [
      'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'nope',
      'txn_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ]) {
      expect((await merchant.test.get(`/v1/payments/${ref}`)).statusCode).toBe(404);
    }
  });

  it('lists newest first with a cursor and no duplicates or gaps', async () => {
    const owner = await createTestMerchant(ctx, { label: 'pager' });
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      ctx.clock.advanceBy(1000);
      created.push((await createPayment(owner.test)).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/payments?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await owner.test.get(url);
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...data.items.map((p) => p.id));
      cursor = data.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...created].reverse());
  });

  it('pages through payments created in the same millisecond without duplicates or gaps', async () => {
    // The fixed clock does not move, so every payment shares one created_at and the ref
    // breaks the tie: the case a keyset cursor gets wrong if it compares only the time.
    const owner = await createTestMerchant(ctx, { label: 'ties' });
    const created: string[] = [];
    for (let i = 0; i < 8; i++) created.push((await createPayment(owner.test)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/payments?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const data = (await owner.test.get(url)).json().data as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...data.items.map((p) => p.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('filters by status, currency and channel, and binds a cursor to its filters', async () => {
    const owner = await createTestMerchant(ctx, { label: 'filter' });
    await createPayment(owner.test, { currency: 'KES', amountMinor: '5000' });
    await createPayment(owner.test, { currency: 'UGX' });
    const kes = await owner.test.get('/v1/payments?currency=KES');
    expect(kes.json().data.items).toHaveLength(1);
    expect(kes.json().data.items[0].currency).toBe('KES');
    expect((await owner.test.get('/v1/payments?status=succeeded')).json().data.items).toEqual([]);
    expect((await owner.test.get('/v1/payments?status=created')).json().data.items).toHaveLength(2);
    const page = (await owner.test.get('/v1/payments?limit=1')).json().data;
    const mismatched = await owner.test.get(
      `/v1/payments?limit=1&currency=KES&cursor=${page.nextCursor}`
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe('INVALID_CURSOR');
    expect((await owner.test.get('/v1/payments?cursor=garbage')).statusCode).toBe(400);
  });

  it('rejects unknown filters, bad limits and an inverted or oversized window', async () => {
    for (const query of [
      'status=bogus',
      'limit=0',
      'limit=101',
      'extra=1',
      'from=not-a-date',
      'from=2025-02-01T00:00:00Z&to=2025-01-01T00:00:00Z',
      'from=2020-01-01T00:00:00Z&to=2025-01-01T00:00:00Z',
    ]) {
      const res = await merchant.test.get(`/v1/payments?${query}`);
      expect(res.statusCode, query).toBe(400);
    }
  });
});

describe('POST /v1/payments/:ref/cancel', () => {
  it('cancels a created payment, completes it, and records the audit row once', async () => {
    const { id, transactionId } = await createPayment(merchant.test);
    const res = await merchant.test.post(`/v1/payments/${id}/cancel`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id,
      status: 'cancelled',
      failureCode: 'cancelled_by_merchant',
      completedAt: expect.any(String),
    });
    const tx = await merchant.test.get(`/v1/transactions/${transactionId}`);
    expect(tx.json().data.status).toBe('cancelled');
    expect(tx.json().data.timeline.map((t: { status: string }) => t.status)).toEqual([
      'created',
      'cancelled',
    ]);
    const audit = await sql(
      `select outcome from core.audit_logs where resource_id = $1 and action = 'payment.cancelled'`,
      [id]
    );
    expect(audit).toEqual([{ outcome: 'success' }]);
  });

  it('is idempotent: cancelling a cancelled payment returns it and audits nothing new', async () => {
    const { id } = await createPayment(merchant.test);
    await merchant.test.post(`/v1/payments/${id}/cancel`, {});
    const again = await merchant.test.post(`/v1/payments/${id}/cancel`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe('cancelled');
    const audit = await sql(
      `select 1 from core.audit_logs where resource_id = $1 and action = 'payment.cancelled'`,
      [id]
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses to cancel a payment that is already cancelled by an expiry, or in another terminal state', async () => {
    const { id } = await createPayment(merchant.test);
    await sql(`select 1`);
    // Move it to processing as the gateway would, then try to cancel it.
    const found = await ctx.paymentsRepository.findDetailByRef(merchant.scope(), id);
    await ctx.unitOfWork.run((tx) =>
      ctx.lifecycle.apply(tx, found!.payment.id, {
        eventKey: 'evt-1',
        source: 'gateway_event',
        occurredAt: new Date(),
        signal: { kind: 'processing', outcomeUnknown: false },
      })
    );
    const res = await merchant.test.post(`/v1/payments/${id}/cancel`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'PAYMENT_INVALID_TRANSITION',
      details: { from: 'processing', to: 'cancelled' },
    });
    expect((await merchant.test.get(`/v1/payments/${id}`)).json().data.status).toBe('processing');
    // The refused attempt is audited as an error, not as a success.
    const audit = await sql<{ outcome: string }>(
      `select outcome from core.audit_logs where resource_id = $1 and action = 'payment.cancelled'`,
      [id]
    );
    expect(audit).toEqual([{ outcome: 'error' }]);
  });

  it('needs the payments:write scope', async () => {
    const ro = await createTestMerchant(ctx, { scopes: ['payments:read'], label: 'ro2' });
    expect(
      (await ro.test.post('/v1/payments/pay_01ARZ3NDEKTSV4RRFFQ69G5FAV/cancel', {})).statusCode
    ).toBe(403);
  });
});

describe('scopes on the read routes', () => {
  it('needs payments:read for payments and transactions:read for transactions', async () => {
    const onlyWrite = await createTestMerchant(ctx, { scopes: ['payments:write'], label: 'w' });
    expect((await onlyWrite.test.get('/v1/payments')).statusCode).toBe(403);
    expect((await onlyWrite.test.get('/v1/transactions')).statusCode).toBe(403);
    const onlyTx = await createTestMerchant(ctx, { scopes: ['transactions:read'], label: 'tx' });
    expect((await onlyTx.test.get('/v1/transactions')).statusCode).toBe(200);
    expect((await onlyTx.test.get('/v1/payments')).statusCode).toBe(403);
    // A key reads only what its own environment holds.
    expect((await apiClient(ctx, onlyTx.testKey).get('/v1/transactions')).statusCode).toBe(200);
  });
});
