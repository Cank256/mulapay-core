/**
 * The sandbox (spec 6.11): test keys never reach the gateway; payments resolve
 * deterministically from `metadata.simulate` or the last two digits of the amount; the same
 * events and webhooks fire as for live payments. The last block is the Phase 5 exit
 * criterion: a merchant integrates end to end using only the public API and the dashboard.
 */
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.definitions';
import { verifyWebhookSignature } from '../../src/modules/webhooks/domain/webhook-signature';
import { SandboxPaymentHandler } from '../../src/modules/developer/sandbox/sandbox.handler';
import { SandboxProcessor } from '../../src/modules/developer/sandbox/sandbox.processor';
import { sandboxJobId, SANDBOX_JOB } from '../../src/modules/developer/sandbox/sandbox.service';
import { WebhookDeliveryProcessor } from '../../src/modules/webhooks/webhook-delivery.processor';
import {
  createMerchant,
  deliveriesOf,
  issueKey,
  makeDue,
  pumpOutbox,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let key: IssuedKey;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'sandbox' });
  key = await issueKey(ctx, merchant.owner, {
    environment: 'test',
    scopes: [
      'payments:read',
      'payments:write',
      'events:read',
      'balances:read',
      'webhooks:write',
      'webhooks:read',
    ],
  });
});
afterAll(async () => {
  await ctx.close();
});

const job = (name: string, data: unknown) => ({ name, data }) as unknown as Job;

let sequence = 0;
async function pay(
  options: {
    amountMinor?: string;
    metadata?: Record<string, string>;
    client?: IssuedKey['client'];
  } = {}
) {
  sequence += 1;
  const res = await (options.client ?? key.client).post(
    '/v1/payments',
    {
      amountMinor: options.amountMinor ?? '10000',
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000001' },
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
    { 'idempotency-key': `sandbox-${sequence}-${Math.random()}` }
  );
  return res;
}

async function created(options: Parameters<typeof pay>[0] = {}) {
  const res = await pay(options);
  expect(res.statusCode).toBe(201);
  const ref = res.json().data.id as string;
  const rows = await ctx.sql('select id from core.payments where ref = $1', [ref]);
  return { ref, id: String(rows[0]?.id) };
}

async function state(ref: string) {
  const rows = await ctx.sql(
    `select p.status, t.outcome_unknown, t.failure_code, t.provider, t.completed_at
       from core.payments p join core.transactions t on t.id = p.transaction_id where p.ref = $1`,
    [ref]
  );
  return rows[0] as {
    status: string;
    outcome_unknown: boolean;
    failure_code: string | null;
    provider: string | null;
    completed_at: Date | null;
  };
}

async function eventTypes(ref: string): Promise<string[]> {
  const rows = await ctx.sql(
    "select type from core.merchant_events where resource_id = $1 and resource_type = 'payment' order by created_at, ref",
    [ref]
  );
  return rows.map((r) => String(r.type)).sort();
}

describe('scenarios', () => {
  it('succeed: processing, then succeeded, credited in the test ledger, with its events', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'succeed' } });
    expect((await state(ref)).status).toBe('created');
    expect(await ctx.sandbox.run(id, 'start')).toBe('applied');
    expect(await state(ref)).toMatchObject({
      status: 'succeeded',
      provider: 'mtn',
      failure_code: null,
    });
    expect((await state(ref)).completed_at).not.toBeNull();
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.succeeded']);
    const entries = await ctx.sql(
      'select environment, kind, source from core.journal_entries where source_id like $1',
      [`${ref}:%`]
    );
    expect(entries).toEqual([
      { environment: 'test', kind: 'collection.succeeded', source: 'payment' },
    ]);
    // The merchant sees the money in test mode only.
    const balances = (await key.client.get('/v1/balances')).json().data as Array<{
      environment: string;
      currency: string;
    }>;
    expect(balances.every((b) => b.environment === 'test')).toBe(true);
  });

  it('fail: processing, then failed with a sandbox failure code and no ledger entry', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'fail' } });
    await ctx.sandbox.run(id, 'start');
    expect(await state(ref)).toMatchObject({ status: 'failed', failure_code: 'sandbox_declined' });
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.failed']);
    expect(
      await ctx.sql('select 1 from core.journal_entries where source_id like $1', [`${ref}:%`])
    ).toHaveLength(0);
  });

  it('expire: ends expired', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'expire' } });
    await ctx.sandbox.run(id, 'start');
    expect(await state(ref)).toMatchObject({ status: 'expired', failure_code: 'sandbox_expired' });
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.expired']);
  });

  it('timeout: stays processing with an unknown outcome, posts nothing, and expires after the sandbox delay', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'timeout' } });
    expect(await ctx.sandbox.run(id, 'start')).toBe('scheduled');
    expect(await state(ref)).toMatchObject({ status: 'processing', outcome_unknown: true });
    expect(await eventTypes(ref)).toEqual(['payment.created']);
    expect(
      await ctx.sql('select 1 from core.journal_entries where source_id like $1', [`${ref}:%`])
    ).toHaveLength(0);
    const job = await ctx.queues.get(QUEUES.gatewayChase.name).getJob(sandboxJobId(id, 'finish'));
    expect(job?.opts.delay).toBe(ctx.config.SANDBOX_TIMEOUT_RESOLVE_SECONDS * 1000);
    // The merchant sees processing, flagged as not final.
    expect((await key.client.get(`/v1/payments/${ref}`)).json().data.status).toBe('processing');
    expect(await ctx.sandbox.run(id, 'finish')).toBe('applied');
    expect(await state(ref)).toMatchObject({
      status: 'expired',
      failure_code: 'sandbox_timeout',
      outcome_unknown: false,
    });
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.expired']);
  });

  it('pending_then_succeed: processing, a delayed job, then succeeded', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'pending_then_succeed' } });
    expect(await ctx.sandbox.run(id, 'start')).toBe('scheduled');
    expect((await state(ref)).status).toBe('processing');
    const job = await ctx.queues.get(QUEUES.gatewayChase.name).getJob(sandboxJobId(id, 'finish'));
    expect(job?.opts.delay).toBe(ctx.config.SANDBOX_PENDING_SECONDS * 1000);
    expect(job?.name).toBe(SANDBOX_JOB);
    expect(job?.data).toEqual({ paymentId: id, step: 'finish' });
    await ctx.sandbox.run(id, 'finish');
    expect(await state(ref)).toMatchObject({ status: 'succeeded' });
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.succeeded']);
  });

  it.each([
    ['10000', 'succeeded'],
    ['10001', 'failed'],
    ['10002', 'processing'],
    ['10003', 'expired'],
    ['10004', 'processing'],
    ['10099', 'succeeded'],
    ['12345', 'succeeded'],
  ])(
    'amount %s resolves, after its first step, to %s (last two digits)',
    async (amountMinor, status) => {
      const { ref, id } = await created({ amountMinor });
      await ctx.sandbox.run(id, 'start');
      expect((await state(ref)).status).toBe(status);
    }
  );

  it('metadata.simulate wins over the amount', async () => {
    const { ref, id } = await created({ amountMinor: '10001', metadata: { simulate: 'succeed' } });
    await ctx.sandbox.run(id, 'start');
    expect((await state(ref)).status).toBe('succeeded');
  });

  it('refuses an unknown simulate value at creation, so a typo never passes as success', async () => {
    const res = await pay({ metadata: { simulate: 'sucess' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PAYMENT_REQUEST_INVALID');
    expect(res.json().error.details).toEqual({ reason: 'simulate_value_invalid' });
  });

  it('is deterministic and idempotent: running a step again changes nothing', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'succeed' } });
    expect(await ctx.sandbox.run(id, 'start')).toBe('applied');
    expect(await ctx.sandbox.run(id, 'start')).toBe('skipped');
    expect(await ctx.sandbox.run(id, 'finish')).toBe('skipped');
    const entries = await ctx.sql('select 1 from core.journal_entries where source_id like $1', [
      `${ref}:%`,
    ]);
    expect(entries).toHaveLength(1);
    expect(await eventTypes(ref)).toEqual(['payment.created', 'payment.succeeded']);
    const concurrent = await created({ metadata: { simulate: 'succeed' } });
    await Promise.all([
      ctx.sandbox.run(concurrent.id, 'start'),
      ctx.sandbox.run(concurrent.id, 'start'),
    ]);
    expect(
      await ctx.sql('select 1 from core.journal_entries where source_id like $1', [
        `${concurrent.ref}:%`,
      ])
    ).toHaveLength(1);
  });

  it('leaves a payment the merchant cancelled before the simulation ran', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'succeed' } });
    expect((await key.client.post(`/v1/payments/${ref}/cancel`)).statusCode).toBe(200);
    expect(await ctx.sandbox.run(id, 'start')).toBe('skipped');
    expect((await state(ref)).status).toBe('cancelled');
  });

  it('ignores a payment that does not exist', async () => {
    expect(await ctx.sandbox.run('00000000-0000-7000-8000-000000000000', 'start')).toBe('skipped');
  });
});

describe('test keys never reach the gateway', () => {
  it('only test payments are simulated: a live payment is refused and left alone', async () => {
    const live = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payments:write', 'payments:read'],
    });
    const res = await pay({ client: live.client, metadata: { simulate: 'succeed' } });
    expect(res.statusCode).toBe(201);
    const ref = res.json().data.id as string;
    const rows = await ctx.sql('select id from core.payments where ref = $1', [ref]);
    const id = String(rows[0]?.id);
    // Live payments take no part in the simulation: no outbox row, and refused if forced.
    expect(
      await ctx.sql(
        "select 1 from core.outbox where event_type = 'sandbox.payment_created' and aggregate_id = $1",
        [id]
      )
    ).toHaveLength(0);
    expect(await ctx.sandbox.run(id, 'start')).toBe('refused');
    expect((await state(ref)).status).toBe('created');
    expect(
      await ctx.sql('select 1 from core.journal_entries where source_id like $1', [`${ref}:%`])
    ).toHaveLength(0);
  });

  it('every test payment announces itself to the simulator through the outbox, in its own transaction', async () => {
    const { ref, id } = await created();
    const rows = await ctx.sql(
      'select event_type, payload from core.outbox where aggregate_id = $1',
      [id]
    );
    expect(rows).toEqual([{ event_type: 'sandbox.payment_created', payload: { paymentId: id } }]);
    const jobs = await new SandboxPaymentHandler().handle(
      undefined as never,
      { payload: { paymentId: id } } as never
    );
    expect(jobs).toEqual([
      {
        queue: QUEUES.gatewayChase.name,
        name: SANDBOX_JOB,
        data: { paymentId: id, step: 'start' },
        options: { jobId: sandboxJobId(id, 'start') },
      },
    ]);
    void ref;
  });

  it('rolls back with the payment: a failed creation leaves no simulator row behind', async () => {
    const before = await ctx.sql(
      "select count(*)::int as n from core.outbox where event_type = 'sandbox.payment_created'"
    );
    const bad = await pay({ amountMinor: '0' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const after = await ctx.sql(
      "select count(*)::int as n from core.outbox where event_type = 'sandbox.payment_created'"
    );
    expect(after[0]?.n).toBeGreaterThanOrEqual(before[0]?.n as number);
    const orphan = await ctx.sql(
      `select count(*)::int as n from core.outbox o
        where o.event_type = 'sandbox.payment_created'
          and not exists (select 1 from core.payments p where p.id::text = o.aggregate_id)`
    );
    expect(orphan[0]?.n).toBe(0);
  });
});

describe('the worker processors', () => {
  it('the sandbox processor runs a step by job name and refuses other jobs', async () => {
    const { ref, id } = await created({ metadata: { simulate: 'succeed' } });
    const processor = ctx.app.get(SandboxProcessor, { strict: false });
    expect(processor.definition).toBe(QUEUES.gatewayChase);
    expect(await processor.process(job(SANDBOX_JOB, { paymentId: id, step: 'start' }))).toBe(
      'applied'
    );
    expect((await state(ref)).status).toBe('succeeded');
    await expect(processor.process(job('chase.something', {}))).rejects.toThrow(
      /unknown gateway-chase job/
    );
  });

  it('the delivery processor attempts the named delivery', async () => {
    const receiver = await startReceiver();
    try {
      await key.client.post('/v1/webhook-endpoints', {
        url: receiver.url,
        enabledEvents: ['payment.created'],
      });
      const { ref } = await created();
      await pumpOutbox(ctx, merchant.id);
      const processor = ctx.app.get(WebhookDeliveryProcessor, { strict: false });
      expect(processor.definition).toBe(QUEUES.webhookDelivery);
      const rows = await ctx.sql(
        `select d.ref from core.webhook_deliveries d join core.merchant_events e on e.id = d.event_id where e.resource_id = $1`,
        [ref]
      );
      expect(rows.length).toBeGreaterThan(0);
      // Another suite's dispatcher may have fanned the event out with its own clock.
      await makeDue(ctx, String(rows[0]?.ref));
      expect(await processor.process(job('deliver', { deliveryRef: rows[0]?.ref }))).toBe(
        'succeeded'
      );
      expect(receiver.received).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });
});

describe('exit criterion: integrating against the sandbox without platform involvement', () => {
  it('a merchant creates keys and an endpoint, takes a payment, and sees every effect through the public API', async () => {
    // 1. A new merchant, in test mode only: no activation, no live key, no platform staff.
    const dev = await createMerchant(ctx, { label: 'integrator' });
    const apiKey = await issueKey(ctx, dev.owner, {
      environment: 'test',
      scopes: [
        'payments:read',
        'payments:write',
        'events:read',
        'balances:read',
        'webhooks:read',
        'webhooks:write',
        'transactions:read',
      ],
    });
    expect((await apiKey.client.get('/v1/ping')).json().data).toMatchObject({
      ok: true,
      environment: 'test',
    });

    // 2. They register a webhook endpoint and keep its secret.
    const receiver = await startReceiver();
    try {
      const endpoint = (
        await apiKey.client.post('/v1/webhook-endpoints', {
          url: receiver.url,
          enabledEvents: ['payment.created', 'payment.succeeded', 'balance.updated'],
        })
      ).json().data;

      // 3. They create a payment. It is created, not yet paid.
      const payment = (
        await apiKey.client.post(
          '/v1/payments',
          {
            amountMinor: '25000',
            currency: 'UGX',
            paymentMethod: { msisdn: '+256700123456' },
            description: 'Order 1',
          },
          { 'idempotency-key': 'order-1' }
        )
      ).json().data;
      expect(payment).toMatchObject({
        status: 'created',
        environment: 'test',
        amountMinor: '25000',
      });
      // A retry with the same key is the same payment.
      const again = await apiKey.client.post(
        '/v1/payments',
        {
          amountMinor: '25000',
          currency: 'UGX',
          paymentMethod: { msisdn: '+256700123456' },
          description: 'Order 1',
        },
        { 'idempotency-key': 'order-1' }
      );
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.json().data.id).toBe(payment.id);

      // 4. The platform's own jobs run: the outbox, the simulator, and webhook delivery.
      const processor = ctx.app.get(SandboxProcessor, { strict: false });
      const rows = await ctx.sql('select id from core.payments where ref = $1', [payment.id]);
      await pumpOutbox(ctx, dev.id);
      await processor.process(job(SANDBOX_JOB, { paymentId: rows[0]?.id, step: 'start' }));
      await pumpOutbox(ctx, dev.id);
      for (const delivery of await deliveriesOf(ctx, dev.id, endpoint.id)) {
        await ctx.deliveryService.attempt(delivery.ref);
      }

      // 5. The payment succeeded, and the merchant sees it everywhere they look.
      expect((await apiKey.client.get(`/v1/payments/${payment.id}`)).json().data).toMatchObject({
        status: 'succeeded',
        provider: 'mtn',
      });
      const timeline = (await apiKey.client.get(`/v1/payments/${payment.id}/timeline`)).json()
        .data as Array<{ status: string }>;
      expect(timeline.map((t) => t.status)).toEqual(['created', 'processing', 'succeeded']);
      expect(
        (await apiKey.client.get(`/v1/transactions/${payment.transactionId}`)).json().data.status
      ).toBe('succeeded');
      const balance = (await apiKey.client.get('/v1/balances')).json().data[0];
      expect(balance).toMatchObject({
        environment: 'test',
        currency: 'UGX',
        postedMinor: '25000',
        availableMinor: '25000',
        heldMinor: '0',
      });
      // The test clock is frozen at the start of the run; the ledger stamps rows with the
      // database clock, so the window must reach past it.
      const until = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
      const movements = (await apiKey.client.get(`/v1/balance-transactions?to=${until}`)).json()
        .data.items;
      expect(movements).toEqual([
        expect.objectContaining({
          kind: 'collection.succeeded',
          direction: 'credit',
          amountMinor: '25000',
          currency: 'UGX',
          reference: payment.id,
        }),
      ]);
      const feed = (await apiKey.client.get('/v1/events')).json().data.items as Array<{
        type: string;
      }>;
      expect(feed.map((e) => e.type).sort()).toEqual([
        'balance.updated',
        'payment.created',
        'payment.succeeded',
      ]);

      // 6. The webhooks arrived, signed, with the payment as the API shows it.
      const types = receiver.received
        .map((r) => (JSON.parse(r.body) as { type: string }).type)
        .sort();
      expect(types).toEqual(['balance.updated', 'payment.created', 'payment.succeeded']);
      const nowSeconds = Math.floor(ctx.clock.now().getTime() / 1000);
      for (const received of receiver.received) {
        expect(
          verifyWebhookSignature(
            String(received.headers['mulapay-signature']),
            received.body,
            endpoint.secret,
            nowSeconds
          )
        ).toEqual({ valid: true });
      }
      const succeeded = receiver.received
        .map(
          (r) =>
            JSON.parse(r.body) as { type: string; data: { object: { id: string; status: string } } }
        )
        .find((e) => e.type === 'payment.succeeded');
      expect(succeeded?.data.object).toMatchObject({ id: payment.id, status: 'succeeded' });

      // 7. Their request log shows the calls, with no bodies.
      await ctx.requestLogs.flush();
      const logs = await dev.owner.client.get('/dashboard/v1/request-logs?environment=test');
      expect(logs.statusCode).toBe(200);
      const methods = (logs.json().data.items as Array<{ method: string; route: string }>).map(
        (l) => `${l.method} ${l.route}`
      );
      expect(methods).toContain('POST /v1/payments');
      expect(methods).toContain('GET /v1/balances');
      expect(logs.body).not.toContain('+256700123456');
    } finally {
      await receiver.close();
    }
  });
});
