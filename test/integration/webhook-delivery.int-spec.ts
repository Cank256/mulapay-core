/**
 * Webhook delivery (spec 6.11, 8.8): fan-out through the outbox, HMAC signing, the retry
 * schedule with jitter, auto-disable after 50 consecutive failures, the delivery log,
 * replay, and the safety of the HTTP exchange. A real HTTP server plays the merchant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/modules/webhooks/domain/webhook-signature';
import { UndiciWebhookTransport } from '../../src/modules/webhooks/webhook-transport';
import {
  clearEndpoints,
  createMerchant,
  deliveriesOf,
  emitEvent,
  issueKey,
  makeDue,
  pumpOutbox,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
  type WebhookReceiver,
} from '../support/developer';
import { addTeamMember, type MerchantUser } from '../support/identity';
import { captureLogs } from '../support/log-capture';
import { testConfig } from '../support/test-env';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let key: IssuedKey;
let dev: MerchantUser;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'delivery' });
  key = await issueKey(ctx, merchant.owner, {
    environment: 'test',
    scopes: ['webhooks:read', 'webhooks:write', 'events:read'],
  });
  dev = await addTeamMember(ctx, merchant.owner, 'developer');
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  // Endpoints are limited to 20 per environment; each test starts with none.
  await clearEndpoints(ctx, merchant.id);
});

const seconds = () => Math.floor(ctx.clock.now().getTime() / 1000);

interface Hooked {
  readonly ref: string;
  readonly secret: string;
  readonly receiver: WebhookReceiver;
}

/** Registers an endpoint on a fresh local receiver. */
async function hook(events: string[] = ['*'], status = 200): Promise<Hooked> {
  const receiver = await startReceiver(status);
  const res = await key.client.post('/v1/webhook-endpoints', {
    url: receiver.url,
    enabledEvents: events,
  });
  expect(res.statusCode).toBe(201);
  return { ref: res.json().data.id, secret: res.json().data.secret, receiver };
}

/** One event, fanned out; returns the endpoint's delivery. */
async function publish(h: Hooked, type: 'payment.created' | 'payment.failed' = 'payment.created') {
  const event = await emitEvent(ctx, merchant, { type });
  await pumpOutbox(ctx, merchant.id);
  const deliveries = await deliveriesOf(ctx, merchant.id, h.ref);
  // The clock is frozen, so deliveries share a creation time: pick this event's by id.
  const delivery = deliveries.find((d) => d.event_id === event.id);
  return { event, delivery, deliveries };
}

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});
async function track(h: Hooked): Promise<Hooked> {
  closers.push(() => h.receiver.close());
  return h;
}

describe('a delivery', () => {
  it('is fanned out through the outbox, signed, and sent once', async () => {
    const h = await track(await hook(['payment.created']));
    const { event, delivery, deliveries } = await publish(h);
    expect(deliveries).toHaveLength(1);
    expect(delivery).toMatchObject({
      status: 'pending',
      attempt: 0,
      event_type: 'payment.created',
    });
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('succeeded');

    expect(h.receiver.received).toHaveLength(1);
    const { headers, body } = h.receiver.received[0] as (typeof h.receiver.received)[number];
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('MulaPay-Webhooks/1');
    expect(headers['mulapay-event-id']).toBe(event.ref);
    expect(headers['mulapay-event-type']).toBe('payment.created');
    expect(headers['mulapay-delivery-id']).toBe(delivery?.ref);
    expect(headers['mulapay-delivery-attempt']).toBe('1');
    const signature = String(headers['mulapay-signature']);
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(signature, body, h.secret, seconds())).toEqual({ valid: true });
    expect(JSON.parse(body)).toEqual({
      id: event.ref,
      type: 'payment.created',
      environment: 'test',
      resourceType: 'payment',
      resourceId: expect.stringMatching(/^res_/),
      createdAt: expect.any(String),
      data: { object: { id: 'pay_example', status: 'created' } },
    });

    const [after] = await deliveriesOf(ctx, merchant.id, h.ref);
    expect(after).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      http_status: 200,
      next_attempt_at: null,
    });
    const endpoint = await key.client.get(`/v1/webhook-endpoints/${h.ref}`);
    expect(endpoint.json().data).toMatchObject({ failureCount: 0 });
    expect(endpoint.json().data.lastSuccessAt).not.toBeNull();
  });

  it('goes only to endpoints subscribed to the type, in the same environment and merchant', async () => {
    const failedOnly = await track(await hook(['payment.failed']));
    const everything = await track(await hook(['*']));
    const liveKey = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['webhooks:write'],
    });
    const receiver = await startReceiver();
    closers.push(() => receiver.close());
    const liveEndpoint = await liveKey.client.post('/v1/webhook-endpoints', {
      url: receiver.url,
      enabledEvents: ['*'],
    });
    const other = await createMerchant(ctx, { active: true, label: 'delivery-other' });
    const otherKey = await issueKey(ctx, other.owner, {
      environment: 'test',
      scopes: ['webhooks:write'],
    });
    const otherReceiver = await startReceiver();
    closers.push(() => otherReceiver.close());
    const otherEndpoint = await otherKey.client.post('/v1/webhook-endpoints', {
      url: otherReceiver.url,
      enabledEvents: ['*'],
    });

    await emitEvent(ctx, merchant, { type: 'payment.created' });
    await pumpOutbox(ctx, merchant.id);
    expect(await deliveriesOf(ctx, merchant.id, failedOnly.ref)).toHaveLength(0);
    expect((await deliveriesOf(ctx, merchant.id, everything.ref)).length).toBeGreaterThanOrEqual(1);
    expect(await deliveriesOf(ctx, merchant.id, liveEndpoint.json().data.id)).toHaveLength(0);
    expect(await deliveriesOf(ctx, other.id, otherEndpoint.json().data.id)).toHaveLength(0);
  });

  it('is created once however many times the outbox row is handled', async () => {
    const h = await track(await hook());
    const { event } = await publish(h);
    await ctx.sql(
      `update core.outbox set published_at = null, locked_at = null, attempts = 0
        where event_type = 'merchant_event.created' and aggregate_id = (select id::text from core.merchant_events where ref = $1)`,
      [event.ref]
    );
    await pumpOutbox(ctx, merchant.id);
    await ctx.sql(
      `update core.outbox set published_at = null, locked_at = null, attempts = 0
        where event_type = 'merchant_event.created' and aggregate_id = (select id::text from core.merchant_events where ref = $1)`,
      [event.ref]
    );
    await pumpOutbox(ctx, merchant.id);
    expect(await deliveriesOf(ctx, merchant.id, h.ref)).toHaveLength(1);
  });

  it('is sent by one worker even when two take the job', async () => {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    const results = await Promise.all([
      ctx.deliveryService.attempt(delivery?.ref as string),
      ctx.deliveryService.attempt(delivery?.ref as string),
      ctx.deliveryService.attempt(delivery?.ref as string),
    ]);
    expect(results.filter((r) => r === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(2);
    expect(h.receiver.received).toHaveLength(1);
    // A delivery that is done is not sent again by a late job.
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('skipped');
    expect(h.receiver.received).toHaveLength(1);
  });

  it('is never sent before it is due', async () => {
    const h = await track(await hook(['*'], 500));
    const { delivery } = await publish(h);
    await ctx.deliveryService.attempt(delivery?.ref as string);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('skipped');
    expect(h.receiver.received).toHaveLength(1);
  });
});

describe('retries', () => {
  const BASE = [30, 120, 600, 3600, 21_600, 86_400];

  it('follows 0s, 30s, 2m, 10m, 1h, 6h, 24h with up to 20% jitter, then gives up', async () => {
    const h = await track(await hook(['*'], 500));
    const { event, delivery } = await publish(h);
    const ref = delivery?.ref as string;
    const bodies = new Set<string>();
    for (let attempt = 1; attempt <= 7; attempt++) {
      if (attempt > 1) await makeDue(ctx, ref);
      const outcome = await ctx.deliveryService.attempt(ref);
      const [row] = await deliveriesOf(ctx, merchant.id, h.ref);
      expect(row).toMatchObject({ attempt, http_status: 500, error: 'http_500' });
      if (attempt < 7) {
        expect(outcome).toBe('retry_scheduled');
        expect(row?.status).toBe('pending');
        const delay = ((row?.next_attempt_at as Date).getTime() - ctx.clock.now().getTime()) / 1000;
        const base = BASE[attempt - 1] as number;
        expect(delay, `attempt ${attempt}`).toBeGreaterThanOrEqual(base * 0.8 - 0.001);
        expect(delay, `attempt ${attempt}`).toBeLessThanOrEqual(base * 1.2 + 0.001);
      } else {
        expect(outcome).toBe('exhausted');
        expect(row).toMatchObject({ status: 'exhausted', next_attempt_at: null });
      }
      bodies.add(h.receiver.received.at(-1)?.body as string);
      expect(h.receiver.received.at(-1)?.headers['mulapay-delivery-attempt']).toBe(String(attempt));
      expect(h.receiver.received.at(-1)?.headers['mulapay-event-id']).toBe(event.ref);
    }
    expect(h.receiver.received).toHaveLength(7);
    // The payload never changes between attempts: only the signature timestamp does.
    expect(bodies.size).toBe(1);
    expect(await ctx.deliveryService.attempt(ref)).toBe('skipped');
    expect(h.receiver.received).toHaveLength(7);
  });

  it('spreads retries: delays of many deliveries are not all equal', async () => {
    const h = await track(await hook(['*'], 500));
    const delays = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const { delivery } = await publish(h);
      await ctx.deliveryService.attempt(delivery?.ref as string);
      const row = (await deliveriesOf(ctx, merchant.id, h.ref)).find(
        (d) => d.ref === delivery?.ref
      );
      delays.add((row?.next_attempt_at as Date).getTime() - ctx.clock.now().getTime());
    }
    expect(delays.size).toBeGreaterThan(1);
  });

  it('succeeds on a later attempt, with the same event id and body, and clears the failure count', async () => {
    const h = await track(await hook(['*'], 503));
    const { event, delivery } = await publish(h);
    const ref = delivery?.ref as string;
    await ctx.deliveryService.attempt(ref);
    expect((await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data.failureCount).toBe(
      1
    );
    h.receiver.status = 200;
    await makeDue(ctx, ref);
    expect(await ctx.deliveryService.attempt(ref)).toBe('succeeded');
    const [first, second] = h.receiver.received;
    expect(first?.body).toBe(second?.body);
    expect(first?.headers['mulapay-event-id']).toBe(event.ref);
    expect(second?.headers['mulapay-event-id']).toBe(event.ref);
    // Each attempt is signed afresh and verifies.
    for (const received of [first, second]) {
      expect(
        verifyWebhookSignature(
          String(received?.headers['mulapay-signature']),
          received?.body as string,
          h.secret,
          seconds()
        )
      ).toEqual({ valid: true });
    }
    expect((await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data.failureCount).toBe(
      0
    );
  });

  it.each([
    [200, true],
    [201, true],
    [204, true],
    [299, true],
    [300, false],
    [301, false],
    [302, false],
    [304, false],
    [400, false],
    [401, false],
    [404, false],
    [410, false],
    [429, false],
    [500, false],
    [502, false],
  ])('treats a %i answer as success: %s', async (status, ok) => {
    const h = await track(await hook(['*'], status));
    const { delivery } = await publish(h);
    const outcome = await ctx.deliveryService.attempt(delivery?.ref as string);
    expect(outcome).toBe(ok ? 'succeeded' : 'retry_scheduled');
  });

  it('does not follow a redirect, which could point at an internal host', async () => {
    const target = await startReceiver();
    closers.push(() => target.close());
    const h = await track(await hook(['*'], 302));
    h.receiver.location = target.url;
    const { delivery } = await publish(h);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('retry_scheduled');
    expect(target.received).toHaveLength(0);
    expect((await deliveriesOf(ctx, merchant.id, h.ref))[0]?.error).toBe('http_302');
  });

  it('keeps at most 1 KiB of the answer, without control characters', async () => {
    const h = await track(await hook(['*'], 500));
    h.receiver.body = `${'<error>'.repeat(400)}\u0000\u0007`;
    const { delivery } = await publish(h);
    await ctx.deliveryService.attempt(delivery?.ref as string);
    const rows = await ctx.sql(
      'select response_body_excerpt from core.webhook_deliveries where ref = $1',
      [delivery?.ref]
    );
    const excerpt = String(rows[0]?.response_body_excerpt);
    expect(excerpt.length).toBeLessThanOrEqual(1024);
    expect(excerpt.length).toBeGreaterThan(900);
    expect([...excerpt].some((c) => c.charCodeAt(0) < 9)).toBe(false);
  });

  it('gives up on an endpoint that does not answer within 10 seconds', async () => {
    const h = await track(await hook(['*'], 200));
    h.receiver.delayMs = 10_600;
    const { delivery } = await publish(h);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('retry_scheduled');
    const [row] = await deliveriesOf(ctx, merchant.id, h.ref);
    expect(row).toMatchObject({ status: 'pending', error: 'timeout', http_status: null });
  }, 30_000);

  it('reports a connection failure without the network error', async () => {
    const receiver = await startReceiver();
    const url = receiver.url;
    await receiver.close();
    const res = await key.client.post('/v1/webhook-endpoints', { url, enabledEvents: ['*'] });
    await emitEvent(ctx, merchant);
    await pumpOutbox(ctx, merchant.id);
    const [delivery] = await deliveriesOf(ctx, merchant.id, res.json().data.id);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('retry_scheduled');
    const [row] = await deliveriesOf(ctx, merchant.id, res.json().data.id);
    expect(row?.error).toBe('network_error');
  });
});

describe('endpoints that are not active', () => {
  it('are not contacted: the delivery ends failed and can be replayed after re-enabling', async () => {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    await key.client.patch(`/v1/webhook-endpoints/${h.ref}`, { status: 'disabled' });
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('endpoint_inactive');
    expect(h.receiver.received).toHaveLength(0);
    const [row] = await deliveriesOf(ctx, merchant.id, h.ref);
    expect(row).toMatchObject({
      status: 'failed',
      error: 'endpoint_disabled',
      next_attempt_at: null,
    });
    // Not replayable while disabled.
    const refused = await dev.client.post(
      `/dashboard/v1/webhook-deliveries/${row?.ref}/retry?environment=test`
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('WEBHOOK_ENDPOINT_NOT_ACTIVE');
    await key.client.patch(`/v1/webhook-endpoints/${h.ref}`, { status: 'active' });
    const replayed = await dev.client.post(
      `/dashboard/v1/webhook-deliveries/${row?.ref}/retry?environment=test`
    );
    expect(replayed.statusCode).toBe(200);
  });

  it('are not contacted once deleted', async () => {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    await key.client.delete(`/v1/webhook-endpoints/${h.ref}`);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('endpoint_inactive');
    expect(h.receiver.received).toHaveLength(0);
  });
});

describe('auto-disable after 50 consecutive failures', () => {
  it('disables the endpoint on the 50th failure, tells the merchant once, and stops sending', async () => {
    const h = await track(await hook(['payment.created', 'webhook_endpoint.auto_disabled'], 500));
    const refs: string[] = [];
    for (let i = 0; i < 8; i++) refs.push((await publish(h)).delivery?.ref as string);
    let sent = 0;
    outer: for (let round = 1; round <= 7; round++) {
      for (const ref of refs) {
        if (round > 1) await makeDue(ctx, ref);
        const endpoint = (await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data;
        if (endpoint.status !== 'active') break outer;
        const outcome = await ctx.deliveryService.attempt(ref);
        if (outcome === 'retry_scheduled' || outcome === 'exhausted') sent += 1;
      }
    }
    expect(sent).toBe(50);
    expect(h.receiver.received).toHaveLength(50);
    const endpoint = (await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data;
    expect(endpoint).toMatchObject({ status: 'auto_disabled', failureCount: 50 });
    expect(endpoint.disabledAt).not.toBeNull();

    // The merchant is told: an event, and an audit row written by the platform.
    const events = (await key.client.get('/v1/events?type=webhook_endpoint.auto_disabled')).json()
      .data.items as Array<{
      data: { object: { id: string; status: string; failureCount: number } };
    }>;
    const ours = events.filter((e) => e.data.object.id === h.ref);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.data.object).toMatchObject({ status: 'auto_disabled', failureCount: 50 });
    const audit = await ctx.sql(
      "select actor_type from core.audit_logs where action = 'webhook_endpoint.auto_disabled' and resource_id = $1",
      [h.ref]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_type).toBe('system');

    // Nothing more is sent: the remaining pending deliveries end failed.
    const before = h.receiver.received.length;
    for (const ref of refs) {
      await makeDue(ctx, ref);
      await ctx.deliveryService.attempt(ref);
    }
    expect(h.receiver.received).toHaveLength(before);
    const rows = await deliveriesOf(ctx, merchant.id, h.ref);
    expect(rows.every((r) => ['failed', 'exhausted'].includes(r.status))).toBe(true);

    // Re-enabling gives a fresh run, and a replay is delivered.
    await key.client.patch(`/v1/webhook-endpoints/${h.ref}`, { status: 'active' });
    expect((await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data).toMatchObject({
      status: 'active',
      failureCount: 0,
    });
  }, 60_000);

  it('counts only consecutive failures: a success resets the run', async () => {
    const h = await track(await hook());
    await ctx.sql('update core.webhook_endpoints set failure_count = 49 where ref = $1', [h.ref]);
    const { delivery } = await publish(h);
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('succeeded');
    expect((await key.client.get(`/v1/webhook-endpoints/${h.ref}`)).json().data).toMatchObject({
      status: 'active',
      failureCount: 0,
    });
  });

  it('does not announce twice when two failures race to the limit', async () => {
    const h = await track(await hook(['*'], 500));
    await ctx.sql('update core.webhook_endpoints set failure_count = 48 where ref = $1', [h.ref]);
    const a = (await publish(h)).delivery?.ref as string;
    const b = (await publish(h)).delivery?.ref as string;
    const c = (await publish(h)).delivery?.ref as string;
    await Promise.all([a, b, c].map((ref) => ctx.deliveryService.attempt(ref)));
    const rows = await ctx.sql(
      "select count(*)::int as n from core.audit_logs where action = 'webhook_endpoint.auto_disabled' and resource_id = $1",
      [h.ref]
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('replay', () => {
  it('sends the same event again as a new delivery, leaving the original untouched', async () => {
    const h = await track(await hook());
    const { event, delivery } = await publish(h);
    await ctx.deliveryService.attempt(delivery?.ref as string);
    const res = await dev.client.post(
      `/dashboard/v1/webhook-deliveries/${delivery?.ref}/retry?environment=test`
    );
    expect(res.statusCode).toBe(200);
    const replay = res.json().data;
    expect(replay).toMatchObject({
      status: 'pending',
      attempts: 0,
      replayOf: delivery?.ref,
      eventId: event.ref,
      endpointId: h.ref,
    });
    expect(replay.id).not.toBe(delivery?.ref);
    await pumpOutbox(ctx, merchant.id);
    expect(await ctx.deliveryService.attempt(replay.id)).toBe('succeeded');
    const [original, repeated] = h.receiver.received;
    expect(repeated?.headers['mulapay-event-id']).toBe(original?.headers['mulapay-event-id']);
    expect(repeated?.body).toBe(original?.body);
    expect(repeated?.headers['mulapay-delivery-id']).toBe(replay.id);
    const rows = await deliveriesOf(ctx, merchant.id, h.ref);
    expect(rows.find((r) => r.ref === delivery?.ref)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
    });
  });

  it('refuses to replay a delivery that is still pending, an unknown one, or another merchant’s', async () => {
    const h = await track(await hook(['*'], 500));
    const { delivery } = await publish(h);
    const pending = await dev.client.post(
      `/dashboard/v1/webhook-deliveries/${delivery?.ref}/retry?environment=test`
    );
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe('WEBHOOK_DELIVERY_NOT_REPLAYABLE');
    expect(
      (
        await dev.client.post(
          '/dashboard/v1/webhook-deliveries/whd_01JBX7Q2M4N8R5T6V9W0XYZABC/retry?environment=test'
        )
      ).statusCode
    ).toBe(404);
    expect(
      (await dev.client.post('/dashboard/v1/webhook-deliveries/not-an-id/retry?environment=test'))
        .statusCode
    ).toBe(404);
    const other = await createMerchant(ctx, { label: 'delivery-replay-other' });
    await ctx.sql(
      "update core.webhook_deliveries set status = 'exhausted', next_attempt_at = null where ref = $1",
      [delivery?.ref]
    );
    expect(
      (
        await other.owner.client.post(
          `/dashboard/v1/webhook-deliveries/${delivery?.ref}/retry?environment=test`
        )
      ).statusCode
    ).toBe(404);
  });

  it('replays in bulk by event type and date range, only the deliveries that did not succeed by default', async () => {
    const h = await track(await hook(['*']));
    const failed = (await publish(h, 'payment.failed')).delivery?.ref as string;
    const created = (await publish(h, 'payment.created')).delivery?.ref as string;
    const done = (await publish(h, 'payment.created')).delivery?.ref as string;
    await ctx.sql(
      "update core.webhook_deliveries set status = 'exhausted', next_attempt_at = null where ref = any($1)",
      [[failed, created]]
    );
    await ctx.sql(
      "update core.webhook_deliveries set status = 'succeeded', next_attempt_at = null, attempt = 1 where ref = $1",
      [done]
    );
    const window = { from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z' };
    // 366-day cap on the window: use a recent one.
    const recent = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect(
      (
        await dev.client.post('/dashboard/v1/webhook-deliveries/replay?environment=test', {
          ...window,
        })
      ).statusCode
    ).toBe(400);
    const byType = await dev.client.post(
      '/dashboard/v1/webhook-deliveries/replay?environment=test',
      { ...recent, eventType: 'payment.failed', endpoint: h.ref }
    );
    expect(byType.statusCode).toBe(200);
    expect(byType.json().data).toEqual({ replayed: 1, truncated: false });
    const rest = await dev.client.post('/dashboard/v1/webhook-deliveries/replay?environment=test', {
      ...recent,
      endpoint: h.ref,
    });
    // payment.failed was already replayed once above and is still exhausted; it is repeated again
    // (replays are not deduplicated), as is the exhausted payment.created. The succeeded one is not.
    expect(rest.json().data.replayed).toBe(2);
    const succeeded = await dev.client.post(
      '/dashboard/v1/webhook-deliveries/replay?environment=test',
      { ...recent, endpoint: h.ref, statuses: ['succeeded'] }
    );
    expect(succeeded.json().data.replayed).toBe(1);
    const foreign = await dev.client.post(
      '/dashboard/v1/webhook-deliveries/replay?environment=test',
      { ...recent, endpoint: 'wh_01JBX7Q2M4N8R5T6V9W0XYZABC' }
    );
    expect(foreign.json().data).toEqual({ replayed: 0, truncated: false });
    const wrongType = await dev.client.post(
      '/dashboard/v1/webhook-deliveries/replay?environment=test',
      { ...recent, eventType: 'refund.failed', endpoint: h.ref }
    );
    expect(wrongType.json().data.replayed).toBe(0);
  });

  it('skips deliveries of endpoints that are not active, and needs webhooks:manage', async () => {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    await ctx.sql(
      "update core.webhook_deliveries set status = 'exhausted', next_attempt_at = null where ref = $1",
      [delivery?.ref]
    );
    await key.client.patch(`/v1/webhook-endpoints/${h.ref}`, { status: 'disabled' });
    const recent = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const skipped = await dev.client.post(
      '/dashboard/v1/webhook-deliveries/replay?environment=test',
      { ...recent, endpoint: h.ref }
    );
    expect(skipped.json().data.replayed).toBe(0);
    const viewer = await addTeamMember(ctx, merchant.owner, 'viewer');
    expect(
      (
        await viewer.client.post('/dashboard/v1/webhook-deliveries/replay?environment=test', {
          ...recent,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await viewer.client.post(
          `/dashboard/v1/webhook-deliveries/${delivery?.ref}/retry?environment=test`
        )
      ).statusCode
    ).toBe(403);
  });

  it('is enforced by the database: a delivery that is final cannot be changed or reset', async () => {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    await ctx.deliveryService.attempt(delivery?.ref as string);
    await expect(
      ctx.sql(
        "update core.webhook_deliveries set status = 'pending', next_attempt_at = now() where ref = $1",
        [delivery?.ref]
      )
    ).rejects.toThrow(/final/);
    await expect(
      ctx.sql('update core.webhook_deliveries set attempt = 0 where ref = $1', [delivery?.ref])
    ).rejects.toThrow(/final/);
    await expect(
      ctx.sql('update core.webhook_deliveries set event_type = $2 where ref = $1', [
        delivery?.ref,
        'payment.failed',
      ])
    ).rejects.toThrow(/identity columns/);
  });
});

describe('the delivery log (/dashboard/v1/webhook-deliveries)', () => {
  it('lists newest first with a cursor, filters, and shows one delivery', async () => {
    const h = await track(await hook(['*'], 500));
    const refs: string[] = [];
    for (let i = 0; i < 5; i++)
      refs.push(
        (await publish(h, i % 2 === 0 ? 'payment.created' : 'payment.failed')).delivery
          ?.ref as string
      );
    await ctx.deliveryService.attempt(refs[0] as string);
    const page1 = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&limit=2`
    );
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data.items).toHaveLength(2);
    expect(page1.json().data.nextCursor).toEqual(expect.any(String));
    const page2 = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&limit=2&cursor=${page1.json().data.nextCursor}`
    );
    const page3 = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&limit=2&cursor=${page2.json().data.nextCursor}`
    );
    const seen = [
      ...page1.json().data.items,
      ...page2.json().data.items,
      ...page3.json().data.items,
    ].map((d: { id: string }) => d.id);
    expect(new Set(seen).size).toBe(5);
    expect(page3.json().data.nextCursor).toBeNull();
    // Changing a filter invalidates the cursor.
    const changed = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&limit=2&eventType=payment.failed&cursor=${page1.json().data.nextCursor}`
    );
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.code).toBe('INVALID_CURSOR');
    const failedOnly = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&eventType=payment.failed`
    );
    expect(failedOnly.json().data.items).toHaveLength(2);
    const pending = await dev.client.get(
      `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}&status=pending`
    );
    expect(pending.json().data.items).toHaveLength(5);
    const one = await dev.client.get(
      `/dashboard/v1/webhook-deliveries/${refs[0]}?environment=test`
    );
    expect(one.json().data).toMatchObject({
      id: refs[0],
      attempts: 1,
      httpStatus: 500,
      error: 'http_500',
      status: 'pending',
      endpointId: h.ref,
    });
    expect(one.json().data.nextAttemptAt).not.toBeNull();
    // Another merchant sees nothing of it.
    const other = await createMerchant(ctx, { label: 'delivery-log-other' });
    expect(
      (await other.owner.client.get(`/dashboard/v1/webhook-deliveries/${refs[0]}?environment=test`))
        .statusCode
    ).toBe(404);
    expect(
      (
        await other.owner.client.get(
          `/dashboard/v1/webhook-deliveries?environment=test&endpoint=${h.ref}`
        )
      ).json().data.items
    ).toEqual([]);
    expect(
      (await dev.client.get(`/dashboard/v1/webhook-deliveries/${refs[0]}?environment=live`))
        .statusCode
    ).toBe(404);
  });
});

describe('what the receiver must be able to check', () => {
  async function delivered(): Promise<{ h: Hooked; header: string; body: string }> {
    const h = await track(await hook());
    const { delivery } = await publish(h);
    await ctx.deliveryService.attempt(delivery?.ref as string);
    const received = h.receiver.received[0];
    return {
      h,
      header: String(received?.headers['mulapay-signature']),
      body: received?.body as string,
    };
  }

  it('rejects a tampered payload, another secret and a changed timestamp', async () => {
    const { h, header, body } = await delivered();
    expect(verifyWebhookSignature(header, body, h.secret, seconds())).toEqual({ valid: true });
    expect(
      verifyWebhookSignature(header, body.replace('created', 'succeeded'), h.secret, seconds())
    ).toMatchObject({ valid: false, reason: 'mismatch' });
    expect(verifyWebhookSignature(header, body, 'whsec_other', seconds())).toMatchObject({
      valid: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature(header.replace(/t=\d+/, 't=1'), body, h.secret, 1)).toMatchObject(
      { valid: false, reason: 'mismatch' }
    );
  });

  it('shows a captured delivery to be stale when replayed after the tolerance', async () => {
    const { h, header, body } = await delivered();
    expect(verifyWebhookSignature(header, body, h.secret, seconds() + 299)).toEqual({
      valid: true,
    });
    expect(verifyWebhookSignature(header, body, h.secret, seconds() + 3600)).toMatchObject({
      valid: false,
      reason: 'stale',
    });
  });

  it('signs with the new and the old secret during a rotation, and with only the new one after it', async () => {
    const h = await track(await hook());
    const rotated = (
      await key.client.post(`/v1/webhook-endpoints/${h.ref}/rotate-secret`, { graceHours: 24 })
    ).json().data;
    const first = (await publish(h)).delivery?.ref as string;
    await ctx.deliveryService.attempt(first);
    const during = h.receiver.received[0];
    const header = String(during?.headers['mulapay-signature']);
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(
      verifyWebhookSignature(header, during?.body as string, rotated.secret, seconds())
    ).toEqual({ valid: true });
    expect(verifyWebhookSignature(header, during?.body as string, h.secret, seconds())).toEqual({
      valid: true,
    });

    ctx.clock.advanceBy(25 * 3_600_000);
    const second = (await publish(h)).delivery?.ref as string;
    await ctx.deliveryService.attempt(second);
    const after = h.receiver.received[1];
    const later = String(after?.headers['mulapay-signature']);
    expect(later.match(/v1=/g)).toHaveLength(1);
    expect(verifyWebhookSignature(later, after?.body as string, rotated.secret, seconds())).toEqual(
      { valid: true }
    );
    expect(verifyWebhookSignature(later, after?.body as string, h.secret, seconds())).toMatchObject(
      { valid: false }
    );
    ctx.clock.advanceBy(-25 * 3_600_000);
  });
});

describe('safety of the exchange', () => {
  it('never sends to a private address when private networks are not allowed', async () => {
    const receiver = await startReceiver();
    closers.push(() => receiver.close());
    const strict = new UndiciWebhookTransport(false);
    const port = new URL(receiver.url).port;
    for (const url of [
      `http://127.0.0.1:${port}/hooks`,
      `http://localhost:${port}/hooks`,
      `http://[::1]:${port}/hooks`,
      `http://169.254.169.254/latest`,
    ]) {
      const result = await strict.post({ url, headers: {}, body: '{}' });
      expect(result, url).toMatchObject({ kind: 'error', outcome: 'blocked' });
    }
    expect(receiver.received).toHaveLength(0);
    const open = new UndiciWebhookTransport(true);
    expect(await open.post({ url: receiver.url, headers: {}, body: '{}' })).toMatchObject({
      kind: 'response',
      status: 200,
    });
    await Promise.all([strict.close(), open.close()]);
  });

  it('keeps the URL, the payload, the secret and the answer out of the logs', async () => {
    const logs = captureLogs(testConfig(), 'debug');
    const logged = await startDeveloperContext({}, logs.logger);
    try {
      const m = await createMerchant(logged, { active: true, label: 'delivery-logs' });
      const k = await issueKey(logged, m.owner, {
        environment: 'test',
        scopes: ['webhooks:write'],
      });
      const receiver = await startReceiver(500);
      receiver.body = 'SECRET-ANSWER-BODY';
      try {
        const res = await k.client.post('/v1/webhook-endpoints', {
          url: `${receiver.url}?token=URL-TOKEN-123`,
          enabledEvents: ['*'],
        });
        const secret = res.json().data.secret as string;
        await emitEvent(logged, m, { object: { note: 'PAYLOAD-MARKER-XYZ' } });
        await pumpOutbox(logged, m.id);
        const [delivery] = await deliveriesOf(logged, m.id);
        await logged.deliveryService.attempt(delivery?.ref as string);
        const text = logs.raw.join('\n');
        expect(text).toContain('webhook delivery attempt');
        for (const forbidden of [
          secret,
          'URL-TOKEN-123',
          'PAYLOAD-MARKER-XYZ',
          'SECRET-ANSWER-BODY',
          receiver.url,
        ]) {
          expect(text, forbidden).not.toContain(forbidden);
        }
      } finally {
        await receiver.close();
      }
    } finally {
      await logged.close();
    }
  });
});
