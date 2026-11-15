/**
 * Payment links and checkout sessions (spec 6.1, 7.1): their routes, lazy payment creation on
 * first use, usage limits under concurrency, expiry, and the expiry sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { sessionRefOfSecret } from '../../src/modules/payments/checkout-sessions.service';
import {
  applyEvent,
  createTestMerchant,
  event,
  idempotencyKey,
  MSISDN,
  paymentId,
  sql,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let merchant: TestMerchant;
let rival: TestMerchant;

beforeAll(async () => {
  ctx = await startPaymentsContext({ DB_POOL_MAX: '30' });
  merchant = await createTestMerchant(ctx, { active: true, label: 'links' });
  rival = await createTestMerchant(ctx, { active: true, label: 'links-rival' });
});

afterAll(async () => {
  await ctx?.close();
});

const mobile = { channel: 'mobile_money' as const, msisdn: MSISDN };

function postLink(
  client = merchant.test,
  body: Record<string, unknown> = {},
  key = idempotencyKey()
) {
  return client.post(
    '/v1/payment-links',
    { title: 'Pay Ada', currency: 'UGX', ...body },
    {
      'idempotency-key': key,
    }
  );
}

async function createLink(body: Record<string, unknown> = {}, client = merchant.test) {
  const res = await postLink(client, body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().data as { id: string; slug: string; usedCount: number; active: boolean };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

async function createSession(body: Record<string, unknown> = {}, client = merchant.test) {
  const res = await client.post(
    '/v1/checkout-sessions',
    { amountMinor: '6000', currency: 'UGX', ...body },
    { 'idempotency-key': idempotencyKey() }
  );
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().data as {
    id: string;
    clientSecret: string;
    status: string;
    paymentId: string | null;
    expiresAt: string;
  };
}

describe('payment links', () => {
  it('creates a fixed-amount link and an open-amount link', async () => {
    const fixed = await postLink(merchant.test, {
      amountMinor: '15000',
      description: 'Consulting',
      maxUses: 5,
      successUrl: 'https://example.com/thanks',
      metadata: { sku: 'c1' },
    });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.json().data).toMatchObject({
      amountMinor: '15000',
      currency: 'UGX',
      title: 'Pay Ada',
      active: true,
      maxUses: 5,
      usedCount: 0,
      expiresAt: null,
      environment: 'test',
      metadata: { sku: 'c1' },
    });
    expect(fixed.json().data.id).toMatch(/^pl_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fixed.json().data.slug).toMatch(/^[a-z0-9]{12}$/);
    const open = await postLink(merchant.test, {});
    expect(open.json().data.amountMinor).toBeNull();
  });

  it('validates the request and writes nothing when it is refused', async () => {
    for (const body of [
      { title: '' },
      { currency: 'XXX' },
      { amountMinor: '0' },
      { maxUses: 0 },
      { successUrl: 'ftp://x' },
      { expiresAt: 'tomorrow' },
      { surprise: true },
    ]) {
      const res = await postLink(merchant.test, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const past = await postLink(merchant.test, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(422);
    expect(past.json().error.details.reason).toBe('expires_at_in_past');
    const tooBig = await postLink(merchant.test, { amountMinor: '100000000000' });
    expect(tooBig.statusCode).toBe(422);
  });

  it('replays a duplicate creation and makes one link', async () => {
    const key = idempotencyKey();
    const a = await postLink(merchant.test, { title: 'Once' }, key);
    const b = await postLink(merchant.test, { title: 'Once' }, key);
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect(b.json().data).toEqual(a.json().data);
    const rows = await sql(
      'select 1 from core.payment_links where merchant_id = $1 and title = $2',
      [merchant.id, 'Once']
    );
    expect(rows).toHaveLength(1);
    const clash = await postLink(merchant.test, { title: 'Twice' }, key);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('retrieves, lists and filters links, scoped to the merchant and environment', async () => {
    const mine = await createLink({ title: 'Mine' });
    const theirs = await createLink({ title: 'Theirs' }, rival.test);
    const live = await createLink({ title: 'Live' }, merchant.live);
    expect((await merchant.test.get(`/v1/payment-links/${mine.id}`)).json().data.title).toBe(
      'Mine'
    );
    for (const [client, ref] of [
      [merchant.test, theirs.id],
      [rival.test, mine.id],
      [merchant.test, live.id],
    ] as const) {
      expect((await client.get(`/v1/payment-links/${ref}`)).statusCode).toBe(404);
    }
    const listed = (await merchant.test.get('/v1/payment-links?limit=100')).json().data;
    const ids = listed.items.map((l: { id: string }) => l.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(live.id);
    await merchant.test.post(`/v1/payment-links/${mine.id}/deactivate`, {});
    const inactive = (await merchant.test.get('/v1/payment-links?active=false&limit=100')).json()
      .data;
    expect(inactive.items.map((l: { id: string }) => l.id)).toContain(mine.id);
    const active = (await merchant.test.get('/v1/payment-links?active=true&limit=100')).json().data;
    expect(active.items.map((l: { id: string }) => l.id)).not.toContain(mine.id);
  });

  it('pages without duplicates or gaps', async () => {
    const owner = await createTestMerchant(ctx, { label: 'link-pager' });
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push((await createLink({ title: `L${i}` }, owner.test)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const data = (
        await owner.test.get(`/v1/payment-links?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      ).json().data as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...data.items.map((l) => l.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it('updates descriptive fields and limits, never the amount or currency', async () => {
    const link = await createLink({ amountMinor: '1000', maxUses: 10 });
    const res = await merchant.test.patch(`/v1/payment-links/${link.id}`, {
      title: 'Renamed',
      maxUses: 3,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      description: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ title: 'Renamed', maxUses: 3, amountMinor: '1000' });
    for (const body of [
      { amountMinor: '2000' },
      { currency: 'KES' },
      { slug: 'abcdefghijkl' },
      {},
    ]) {
      expect((await merchant.test.patch(`/v1/payment-links/${link.id}`, body)).statusCode).toBe(
        400
      );
    }
    expect(
      (await rival.test.patch(`/v1/payment-links/${link.id}`, { title: 'Stolen' })).statusCode
    ).toBe(404);
    expect((await merchant.test.get(`/v1/payment-links/${link.id}`)).json().data.title).toBe(
      'Renamed'
    );
    const audit = await sql(
      `select 1 from core.audit_logs where resource_id = $1 and action = 'payment_link.updated' and outcome = 'success'`,
      [link.id]
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses a max_uses below the uses already taken', async () => {
    const link = await createLink({ amountMinor: '1000' });
    for (let i = 0; i < 3; i++) {
      await ctx.links.redeemBySlug(link.slug, mobile, idempotencyKey());
    }
    const res = await merchant.test.patch(`/v1/payment-links/${link.id}`, { maxUses: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reason).toBe('max_uses_below_used_count');
    expect(
      (await merchant.test.patch(`/v1/payment-links/${link.id}`, { maxUses: 3 })).statusCode
    ).toBe(200);
  });

  it('deactivates a link, once, and audits only the first time', async () => {
    const link = await createLink();
    const a = await merchant.test.post(`/v1/payment-links/${link.id}/deactivate`, {});
    const b = await merchant.test.post(`/v1/payment-links/${link.id}/deactivate`, {});
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.json().data.active).toBe(false);
    const audit = await sql(
      `select 1 from core.audit_logs where resource_id = $1 and action = 'payment_link.deactivated' and outcome = 'success'`,
      [link.id]
    );
    expect(audit).toHaveLength(1);
    expect((await rival.test.post(`/v1/payment-links/${link.id}/deactivate`, {})).statusCode).toBe(
      404
    );
  });

  it('needs the right scope', async () => {
    const ro = await createTestMerchant(ctx, { scopes: ['payments:read'], label: 'ro-links' });
    expect((await postLink(ro.test)).statusCode).toBe(403);
    expect((await ro.test.get('/v1/payment-links')).statusCode).toBe(200);
    const wo = await createTestMerchant(ctx, { scopes: ['payments:write'], label: 'wo-links' });
    expect((await wo.test.get('/v1/payment-links')).statusCode).toBe(403);
  });
});

describe('using a payment link', () => {
  it('creates the payment lazily on first use, and takes one use of the link', async () => {
    const link = await createLink({
      amountMinor: '12000',
      description: 'Pay Ada',
      metadata: { k: 'v' },
    });
    const res = await ctx.links.redeemBySlug(link.slug, mobile, idempotencyKey());
    expect(res.statusCode).toBe(201);
    expect(res.replayed).toBe(false);
    expect(res.body).toMatchObject({
      status: 'created',
      amountMinor: '12000',
      currency: 'UGX',
      paymentLinkId: link.id,
      checkoutSessionId: null,
      environment: 'test',
      description: 'Pay Ada',
    });
    expect((await merchant.test.get(`/v1/payment-links/${link.id}`)).json().data.usedCount).toBe(1);
    // The payment is the merchant's, in the link's environment, and starts a lifecycle.
    expect((await merchant.test.get(`/v1/payments/${res.body.id}`)).json().data.id).toBe(
      res.body.id
    );
    expect((await rival.test.get(`/v1/payments/${res.body.id}`)).statusCode).toBe(404);
  });

  it('takes the amount from the payer for an open-amount link, and refuses one for a fixed link', async () => {
    const open = await createLink();
    expect(
      (await failure(ctx.links.redeemBySlug(open.slug, mobile, idempotencyKey()))).details
    ).toMatchObject({
      reason: 'amount_required',
    });
    const res = await ctx.links.redeemBySlug(
      open.slug,
      { ...mobile, amountMinor: 777n },
      idempotencyKey()
    );
    expect(res.body.amountMinor).toBe('777');
    const fixed = await createLink({ amountMinor: '5000' });
    expect(
      (
        await failure(
          ctx.links.redeemBySlug(fixed.slug, { ...mobile, amountMinor: 1n }, idempotencyKey())
        )
      ).details
    ).toMatchObject({ reason: 'amount_is_fixed' });
  });

  it('answers a repeated use with the same key from the stored response and takes one use', async () => {
    const link = await createLink({ amountMinor: '3000', maxUses: 5 });
    const key = idempotencyKey();
    const first = await ctx.links.redeemBySlug(link.slug, mobile, key);
    const again = await ctx.links.redeemBySlug(link.slug, mobile, key);
    expect(again.replayed).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect((await merchant.test.get(`/v1/payment-links/${link.id}`)).json().data.usedCount).toBe(1);
    const other = await failure(
      ctx.links.redeemBySlug(link.slug, { ...mobile, msisdn: '+256700000002' }, key)
    );
    expect(other.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not take a use when the payment cannot be created', async () => {
    const link = await createLink({ amountMinor: '3000', maxUses: 1 });
    const bad = await failure(
      ctx.links.redeemBySlug(link.slug, { channel: 'mobile_money' }, idempotencyKey())
    );
    expect(bad.details).toMatchObject({ reason: 'msisdn_required' });
    expect((await merchant.test.get(`/v1/payment-links/${link.id}`)).json().data.usedCount).toBe(0);
    expect((await ctx.links.redeemBySlug(link.slug, mobile, idempotencyKey())).statusCode).toBe(
      201
    );
  });

  it('refuses an inactive, expired or exhausted link, and an unknown one', async () => {
    const reasonOf = async (slug: string) =>
      (await failure(ctx.links.redeemBySlug(slug, mobile, idempotencyKey()))).details?.reason;
    const inactive = await createLink({ amountMinor: '1000' });
    await merchant.test.post(`/v1/payment-links/${inactive.id}/deactivate`, {});
    expect(await reasonOf(inactive.slug)).toBe('inactive');

    const exhausted = await createLink({ amountMinor: '1000', maxUses: 1 });
    await ctx.links.redeemBySlug(exhausted.slug, mobile, idempotencyKey());
    expect(await reasonOf(exhausted.slug)).toBe('max_uses_reached');

    const expiring = await createLink({
      amountMinor: '1000',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await ctx.links.redeemBySlug(expiring.slug, mobile, idempotencyKey())).statusCode).toBe(
      201
    );
    ctx.clock.advanceBy(2 * 3600_000);
    expect(await reasonOf(expiring.slug)).toBe('expired');

    expect(
      (await failure(ctx.links.redeemBySlug('nosuchslug00', mobile, idempotencyKey()))).code
    ).toBe('NOT_FOUND');
  });

  it('gives exactly max_uses payments to 30 simultaneous payers', async () => {
    const link = await createLink({ amountMinor: '2000', maxUses: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => ctx.links.redeemBySlug(link.slug, mobile, idempotencyKey()))
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(AppError);
      expect((r.reason as AppError).code).toBe('PAYMENT_LINK_UNAVAILABLE');
      expect((r.reason as AppError).details).toMatchObject({ reason: 'max_uses_reached' });
    }
    expect((await merchant.test.get(`/v1/payment-links/${link.id}`)).json().data.usedCount).toBe(3);
    const payments = await sql(
      'select 1 from core.payments p join core.payment_links l on l.id = p.payment_link_id where l.ref = $1',
      [link.id]
    );
    expect(payments).toHaveLength(3);
  });

  it('does not let a suspended merchant take payments through a link', async () => {
    const owner = await createTestMerchant(ctx, { active: true, label: 'sus-link' });
    const link = await createLink({ amountMinor: '1000' }, owner.test);
    await sql("update core.merchants set status = 'suspended' where ref = $1", [owner.ref]);
    const err = await failure(ctx.links.redeemBySlug(link.slug, mobile, idempotencyKey()));
    expect(err.code).toBe('MERCHANT_NOT_ACTIVE');
    expect(
      (
        await sql<{ used: number }>(
          'select used_count as used from core.payment_links where ref = $1',
          [link.id]
        )
      )[0]?.used
    ).toBe(0);
  });

  it('uses the live environment for a live link, never the test one', async () => {
    const live = await createLink({ amountMinor: '1000' }, merchant.live);
    const res = await ctx.links.redeemBySlug(live.slug, mobile, idempotencyKey());
    expect(res.body.environment).toBe('live');
    expect((await merchant.live!.get(`/v1/payments/${res.body.id}`)).statusCode).toBe(200);
    expect((await merchant.test.get(`/v1/payments/${res.body.id}`)).statusCode).toBe(404);
  });
});

describe('checkout sessions', () => {
  it('creates a session with a client secret shown once', async () => {
    const created = await createSession({
      description: 'Order 9',
      successUrl: 'https://example.com/done',
      metadata: { order: '9' },
      expiresInMinutes: 30,
    });
    expect(created).toMatchObject({ status: 'open', paymentId: null });
    expect(created.id).toMatch(/^cs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sessionRefOfSecret(created.clientSecret)).toBe(created.id);
    const minutes = (Date.parse(created.expiresAt) - ctx.clock.now().getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThan(31);
    const got = (await merchant.test.get(`/v1/checkout-sessions/${created.id}`)).json().data;
    expect(got).toMatchObject({
      id: created.id,
      status: 'open',
      amountMinor: '6000',
      description: 'Order 9',
    });
    expect(JSON.stringify(got)).not.toContain('clientSecret');
    expect(JSON.stringify(got)).not.toContain(created.clientSecret.split('_secret_')[1]);
  });

  it('validates the request', async () => {
    for (const body of [
      { amountMinor: '0' },
      { currency: 'XXX' },
      { expiresInMinutes: 0 },
      { expiresInMinutes: 7 * 24 * 60 + 1 },
      { successUrl: 'nope' },
      { unknown: 1 },
    ]) {
      const res = await merchant.test.post(
        '/v1/checkout-sessions',
        { amountMinor: '6000', currency: 'UGX', ...body },
        { 'idempotency-key': idempotencyKey() }
      );
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('is scoped to its merchant and environment', async () => {
    const session = await createSession();
    expect((await rival.test.get(`/v1/checkout-sessions/${session.id}`)).statusCode).toBe(404);
    expect((await merchant.live!.get(`/v1/checkout-sessions/${session.id}`)).statusCode).toBe(404);
    expect(
      (await rival.test.post(`/v1/checkout-sessions/${session.id}/expire`, {})).statusCode
    ).toBe(404);
    expect(
      (await merchant.test.get(`/v1/checkout-sessions/${session.id}`)).json().data.status
    ).toBe('open');
  });

  it('creates the payment lazily on first use, once, whatever idempotency keys are used', async () => {
    const session = await createSession({ amountMinor: '9100' });
    const first = await ctx.sessions.startPayment(session.clientSecret, mobile, idempotencyKey());
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({
      status: 'created',
      amountMinor: '9100',
      checkoutSessionId: session.id,
      paymentLinkId: null,
    });
    // A second use under another key gets the same payment, not a second one.
    const second = await ctx.sessions.startPayment(session.clientSecret, mobile, idempotencyKey());
    expect(second.statusCode).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const sameKey = idempotencyKey();
    const a = await ctx.sessions.startPayment(session.clientSecret, mobile, sameKey);
    const b = await ctx.sessions.startPayment(session.clientSecret, mobile, sameKey);
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(
      (await merchant.test.get(`/v1/checkout-sessions/${session.id}`)).json().data.paymentId
    ).toBe(first.body.id);
    const rows = await sql(
      'select 1 from core.payments p join core.checkout_sessions s on s.id = p.checkout_session_id where s.ref = $1',
      [session.id]
    );
    expect(rows).toHaveLength(1);
  });

  it('gives 30 simultaneous first uses one payment', async () => {
    const session = await createSession();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        ctx.sessions.startPayment(session.clientSecret, mobile, idempotencyKey())
      )
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const rows = await sql(
      'select 1 from core.payments p join core.checkout_sessions s on s.id = p.checkout_session_id where s.ref = $1',
      [session.id]
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a wrong, malformed or foreign secret as not found', async () => {
    const session = await createSession();
    const other = await createSession();
    const tail = session.clientSecret.split('_secret_')[1]!;
    for (const secret of [
      `${session.id}_secret_${'x'.repeat(tail.length)}`,
      `${session.id}_secret_`,
      session.id,
      'garbage',
      '',
      `${other.id}_secret_${tail}`,
      `cs_00000000000000000000000000_secret_${tail}`,
    ]) {
      const err = await failure(ctx.sessions.startPayment(secret, mobile, idempotencyKey()));
      expect(err.code, secret).toBe('NOT_FOUND');
    }
    expect(
      (await merchant.test.get(`/v1/checkout-sessions/${session.id}`)).json().data.paymentId
    ).toBeNull();
  });

  it('refuses a session that has expired or been expired', async () => {
    const lapsing = await createSession({ expiresInMinutes: 5 });
    const merchantExpired = await createSession();
    await merchant.test.post(`/v1/checkout-sessions/${merchantExpired.id}/expire`, {});
    ctx.clock.advanceBy(10 * 60_000);
    for (const session of [lapsing, merchantExpired]) {
      const err = await failure(
        ctx.sessions.startPayment(session.clientSecret, mobile, idempotencyKey())
      );
      expect(err.code).toBe('CHECKOUT_SESSION_UNAVAILABLE');
      expect(err.details).toMatchObject({ reason: 'expired' });
    }
  });

  describe('expiring by the merchant', () => {
    it('expires an unused session, and again without error or a second audit row', async () => {
      const session = await createSession();
      const first = await merchant.test.post(`/v1/checkout-sessions/${session.id}/expire`, {});
      expect(first.statusCode).toBe(200);
      expect(first.json().data.status).toBe('expired');
      const again = await merchant.test.post(`/v1/checkout-sessions/${session.id}/expire`, {});
      expect(again.statusCode).toBe(200);
      const audit = await sql(
        `select 1 from core.audit_logs where resource_id = $1 and action = 'checkout_session.expired'`,
        [session.id]
      );
      expect(audit).toHaveLength(1);
    });

    it('cancels a payment that was never submitted', async () => {
      const session = await createSession();
      const started = await ctx.sessions.startPayment(
        session.clientSecret,
        mobile,
        idempotencyKey()
      );
      const res = await merchant.test.post(`/v1/checkout-sessions/${session.id}/expire`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'expired', paymentId: started.body.id });
      const payment = (await merchant.test.get(`/v1/payments/${started.body.id}`)).json().data;
      expect(payment).toMatchObject({ status: 'cancelled', failureCode: 'cancelled_by_merchant' });
    });

    it('refuses while the payment is running at a provider, and leaves both untouched', async () => {
      const session = await createSession();
      const started = await ctx.sessions.startPayment(
        session.clientSecret,
        mobile,
        idempotencyKey()
      );
      await toProcessing(ctx, await paymentId(ctx, merchant, started.body.id));
      const res = await merchant.test.post(`/v1/checkout-sessions/${session.id}/expire`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'CHECKOUT_SESSION_UNAVAILABLE',
        details: { reason: 'payment_in_progress' },
      });
      expect(
        (await merchant.test.get(`/v1/checkout-sessions/${session.id}`)).json().data.status
      ).toBe('open');
      expect((await merchant.test.get(`/v1/payments/${started.body.id}`)).json().data.status).toBe(
        'processing'
      );
    });

    it('refuses a completed session', async () => {
      const session = await createSession();
      const started = await ctx.sessions.startPayment(
        session.clientSecret,
        mobile,
        idempotencyKey()
      );
      const id = await paymentId(ctx, merchant, started.body.id);
      await toProcessing(ctx, id);
      await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } }));
      const res = await merchant.test.post(`/v1/checkout-sessions/${session.id}/expire`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('complete');
      // Starting a finished session again returns its one payment; it never makes another.
      const again = await ctx.sessions.startPayment(session.clientSecret, mobile, idempotencyKey());
      expect(again.statusCode).toBe(200);
      expect(again.body).toMatchObject({ id: started.body.id, status: 'succeeded' });
    });
  });
});

describe('the expiry sweep', () => {
  /** Runs `create` with the clock two hours in the past, so what it makes is already due. */
  async function backdated<T>(create: () => Promise<T>): Promise<T> {
    ctx.clock.set(new Date(Date.now() - 2 * 3600_000));
    try {
      return await create();
    } finally {
      ctx.clock.set(new Date());
    }
  }

  it('expires payments that were never submitted, once, and leaves the rest', async () => {
    const owner = await createTestMerchant(ctx, { label: 'sweep' });
    const due = await backdated(async () => {
      const refs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await owner.test.post(
          '/v1/payments',
          { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: MSISDN } },
          { 'idempotency-key': idempotencyKey() }
        );
        refs.push(res.json().data.id);
      }
      return refs;
    });
    const fresh = (
      await owner.test.post(
        '/v1/payments',
        { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: MSISDN } },
        { 'idempotency-key': idempotencyKey() }
      )
    ).json().data.id as string;
    const cancelled = await backdated(async () => {
      const res = await owner.test.post(
        '/v1/payments',
        { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: MSISDN } },
        { 'idempotency-key': idempotencyKey() }
      );
      await owner.test.post(`/v1/payments/${res.json().data.id}/cancel`, {});
      return res.json().data.id as string;
    });

    const result = await ctx.expiry.sweep(1000);
    expect(result.payments.expired).toBeGreaterThanOrEqual(3);
    expect(result.payments.failed).toBe(0);
    for (const ref of due) {
      const p = (await owner.test.get(`/v1/payments/${ref}`)).json().data;
      expect(p).toMatchObject({ status: 'expired', failureCode: 'payment_expired' });
      expect(p.completedAt).not.toBeNull();
    }
    expect((await owner.test.get(`/v1/payments/${fresh}`)).json().data.status).toBe('created');
    expect((await owner.test.get(`/v1/payments/${cancelled}`)).json().data.status).toBe(
      'cancelled'
    );

    // A second sweep finds nothing of ours to do: one effect, however often it runs.
    const events = await sql(
      `select e.event_key from core.transaction_events e join core.payments p on p.transaction_id = e.transaction_id
        where p.ref = any($1) and e.event_key = 'job:expiry'`,
      [due]
    );
    expect(events).toHaveLength(3);
    await ctx.expiry.sweep(1000);
    const after = await sql(
      `select e.event_key from core.transaction_events e join core.payments p on p.transaction_id = e.transaction_id
        where p.ref = any($1) and e.event_key = 'job:expiry'`,
      [due]
    );
    expect(after).toHaveLength(3);
    // The sweep posts nothing.
    const entries = await sql(
      `select 1 from core.journal_entries e join core.payments p on p.transaction_id = e.transaction_id where p.ref = any($1)`,
      [due]
    );
    expect(entries).toHaveLength(0);
  });

  it('is safe to run on two nodes at once', async () => {
    const owner = await createTestMerchant(ctx, { label: 'sweep2' });
    const refs = await backdated(async () => {
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await owner.test.post(
          '/v1/payments',
          { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: MSISDN } },
          { 'idempotency-key': idempotencyKey() }
        );
        out.push(res.json().data.id);
      }
      return out;
    });
    const results = await Promise.all(Array.from({ length: 4 }, () => ctx.expiry.sweep(1000)));
    expect(results.every((r) => r.payments.failed === 0)).toBe(true);
    for (const ref of refs) {
      expect((await owner.test.get(`/v1/payments/${ref}`)).json().data.status).toBe('expired');
    }
    const events = await sql(
      `select e.event_key from core.transaction_events e join core.payments p on p.transaction_id = e.transaction_id
        where p.ref = any($1) and e.event_key = 'job:expiry'`,
      [refs]
    );
    expect(events).toHaveLength(6);
  });

  it('expires lapsed checkout sessions and their unsubmitted payments, but not one with a running payment', async () => {
    const owner = await createTestMerchant(ctx, { label: 'sweep3' });
    const make = async (minutes = 1) => {
      const created = await owner.test.post(
        '/v1/checkout-sessions',
        { amountMinor: '4000', currency: 'UGX', expiresInMinutes: minutes },
        { 'idempotency-key': idempotencyKey() }
      );
      return created.json().data as { id: string; clientSecret: string };
    };
    const { unused, withPayment, running } = await backdated(async () => {
      const unused = await make();
      const withPayment = await make();
      const running = await make();
      const a = await ctx.sessions.startPayment(withPayment.clientSecret, mobile, idempotencyKey());
      const b = await ctx.sessions.startPayment(running.clientSecret, mobile, idempotencyKey());
      return {
        unused,
        withPayment: { ...withPayment, payment: a.body.id },
        running: { ...running, payment: b.body.id },
      };
    });
    await toProcessing(ctx, await paymentId(ctx, owner, running.payment));
    const live = await make(60);

    const result = await ctx.expiry.sweep(1000);
    expect(result.sessions.failed).toBe(0);
    expect(result.sessions.left).toBeGreaterThanOrEqual(1);
    const status = async (ref: string) =>
      (await owner.test.get(`/v1/checkout-sessions/${ref}`)).json().data.status;
    expect(await status(unused.id)).toBe('expired');
    expect(await status(withPayment.id)).toBe('expired');
    expect((await owner.test.get(`/v1/payments/${withPayment.payment}`)).json().data.status).toBe(
      'expired'
    );
    // The running payment keeps its session open for the gateway's outcome.
    expect(await status(running.id)).toBe('open');
    expect((await owner.test.get(`/v1/payments/${running.payment}`)).json().data.status).toBe(
      'processing'
    );
    expect(await status(live.id)).toBe('open');
  });
});
