/**
 * Integration fixtures for the developer platform: an app with the sandbox and a probe
 * route that needs `payouts:write`, keys with signing and limits, signed requests, a local
 * HTTP server that plays a merchant's webhook receiver, and helpers that run the outbox and
 * the delivery attempts without a worker process.
 *
 * Isolation: every context uses its own BullMQ prefix, and nothing here starts a worker, so
 * the jobs a test publishes sit in a queue nobody reads. Delivery attempts and sandbox steps
 * are called directly, which also makes them deterministic.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Controller, Module, Post } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { inject } from 'vitest';
import { z } from 'zod';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { Audited } from '../../src/common/audit/audited.decorator';
import { computeSignature } from '../../src/common/auth/request-signing';
import { RequirePermission } from '../../src/common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../src/common/http/response-schema.decorator';
import { OutboxDispatcher } from '../../src/common/outbox/outbox-dispatcher';
import { OutboxRepository } from '../../src/common/outbox/outbox.repository';
import { QueueRegistry } from '../../src/common/queue/queue.registry';
import type { MerchantEventType } from '../../src/modules/events/domain/event-types';
import { MerchantEventsRepository } from '../../src/modules/events/merchant-events.repository';
import { MerchantEventsService } from '../../src/modules/events/merchant-events.service';
import { RequestLogBuffer } from '../../src/modules/developer/request-logs/request-log.buffer';
import { RequestLogService } from '../../src/modules/developer/request-logs/request-log.service';
import { SandboxPaymentHandler } from '../../src/modules/developer/sandbox/sandbox.handler';
import { SandboxModule } from '../../src/modules/developer/sandbox/sandbox.module';
import { SandboxService } from '../../src/modules/developer/sandbox/sandbox.service';
import { WebhookDeliveriesRepository } from '../../src/modules/webhooks/webhook-deliveries.repository';
import { WebhookDeliveriesService } from '../../src/modules/webhooks/webhook-deliveries.service';
import { WebhookDeliveryService } from '../../src/modules/webhooks/webhook-delivery.service';
import { WebhookEndpointsRepository } from '../../src/modules/webhooks/webhook-endpoints.repository';
import { WebhookEndpointsService } from '../../src/modules/webhooks/webhook-endpoints.service';
import {
  DeliveryCreatedHandler,
  MerchantEventFanoutHandler,
} from '../../src/modules/webhooks/webhook-fanout.handlers';
import { FixedClock } from './fixed-clock';
import {
  Client,
  activateMerchantDirectly,
  registerMerchantUser,
  type MerchantUser,
  type TestContext,
} from './identity';
import { createTestApp } from './test-app';
import { testConfig } from './test-env';
import { Client as PgClient } from 'pg';
import pino, { type Logger } from 'pino';

/** Routes for the scope and signing rules of money routes that Phase 4 has not built yet. */
@Controller('__probe')
class ProbeController {
  @Post('payouts')
  @RequirePermission('payouts:write')
  @Audited('probe.payout', 'probe')
  @ApiEnvelopedResponses({ 201: z.object({ ok: z.boolean(), bytes: z.number() }) })
  payout() {
    return { ok: true, bytes: 0 };
  }

  @Post('refunds')
  @RequirePermission('refunds:write')
  @Audited('probe.refund', 'probe')
  @ApiEnvelopedResponses({ 201: z.object({ ok: z.boolean() }) })
  refund() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

export interface DeveloperContext extends TestContext {
  readonly units: UnitOfWork;
  readonly dispatcher: OutboxDispatcher;
  readonly outbox: OutboxRepository;
  readonly endpoints: WebhookEndpointsService;
  readonly endpointsRepository: WebhookEndpointsRepository;
  readonly deliveries: WebhookDeliveriesService;
  readonly deliveriesRepository: WebhookDeliveriesRepository;
  readonly deliveryService: WebhookDeliveryService;
  readonly events: MerchantEventsRepository;
  readonly sandbox: SandboxService;
  readonly requestLogs: RequestLogService;
  readonly requestLogBuffer: RequestLogBuffer;
  readonly queues: QueueRegistry;
  readonly sql: (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  stop(): Promise<void>;
}

export async function startDeveloperContext(
  overrides: Record<string, string> = {},
  logger?: Logger
): Promise<DeveloperContext> {
  const clock = new FixedClock(new Date());
  const config = testConfig({
    // Each app opens up to three pools of this size; the suites run in parallel.
    DB_POOL_MAX: '8',
    QUEUE_PREFIX: `dev-test-${randomUUID().slice(0, 8)}`,
    ...overrides,
  });
  const app = await createTestApp(config, {
    clock,
    ...(logger ? { logger } : {}),
    extraImports: [
      SandboxModule,
      ProbeModule,
      RouterModule.register([{ path: 'v1', module: ProbeModule }]),
    ],
  });
  const get = <T>(token: new (...args: never[]) => T): T => app.get(token, { strict: false });
  const queues = get(QueueRegistry);
  const units = get(UnitOfWork);
  const dispatcher = new OutboxDispatcher(
    get(OutboxRepository),
    units,
    queues,
    [get(MerchantEventFanoutHandler), get(DeliveryCreatedHandler), get(SandboxPaymentHandler)],
    clock,
    pino({ level: 'silent' })
  );
  const pg = new PgClient({ connectionString: inject('databaseUrls').superuser });
  await pg.connect();
  return {
    app,
    clock,
    config,
    units,
    dispatcher,
    queues,
    outbox: get(OutboxRepository),
    endpoints: get(WebhookEndpointsService),
    endpointsRepository: get(WebhookEndpointsRepository),
    deliveries: get(WebhookDeliveriesService),
    deliveriesRepository: get(WebhookDeliveriesRepository),
    deliveryService: get(WebhookDeliveryService),
    events: get(MerchantEventsRepository),
    sandbox: get(SandboxService),
    requestLogs: get(RequestLogService),
    requestLogBuffer: get(RequestLogBuffer),
    sql: async (text, params = []) => (await pg.query(text, params)).rows as never,
    close: async () => {
      await app.close();
      await pg.end();
    },
    stop: async () => undefined,
  };
}

export interface IssuedKey {
  readonly key: string;
  readonly ref: string;
  readonly signingSecret: string | null;
  readonly client: Client;
}

export interface KeyOptions {
  readonly environment?: 'test' | 'live';
  readonly scopes?: string[];
  readonly ipAllowlist?: string[];
  readonly rateLimitRpm?: number;
  readonly signingRequired?: boolean;
  readonly name?: string;
}

/** Issues a key through the dashboard, as a merchant would. */
export async function issueKey(
  ctx: TestContext,
  owner: MerchantUser,
  options: KeyOptions = {}
): Promise<IssuedKey> {
  const res = await owner.client.post('/merchant/v1/api-keys', {
    name: options.name ?? 'integration key',
    environment: options.environment ?? 'test',
    scopes: options.scopes ?? ['payments:read', 'payments:write'],
    ...(options.ipAllowlist ? { ipAllowlist: options.ipAllowlist } : {}),
    ...(options.rateLimitRpm ? { rateLimitRpm: options.rateLimitRpm } : {}),
    ...(options.signingRequired ? { signingRequired: true } : {}),
  });
  if (res.statusCode !== 201) throw new Error(`key issue failed: ${res.body}`);
  const data = res.json().data as { key: string; id: string; signingSecret: string | null };
  const client = new Client(ctx.app);
  client.token = data.key;
  return { key: data.key, ref: data.id, signingSecret: data.signingSecret, client };
}

export interface DeveloperMerchant {
  readonly owner: MerchantUser;
  /** Public ref (`mch_...`). */
  readonly ref: string;
  /** Internal id, for SQL assertions. */
  readonly id: string;
}

/** A merchant, optionally activated, with its owner logged in on the dashboard. */
export async function createMerchant(
  ctx: DeveloperContext,
  options: { active?: boolean; label?: string } = {}
): Promise<DeveloperMerchant> {
  const owner = await registerMerchantUser(ctx, options.label ?? 'dev');
  if (options.active) {
    await activateMerchantDirectly(inject('databaseUrls').superuser, owner.merchantId);
  }
  const rows = await ctx.sql('select id from core.merchants where ref = $1', [owner.merchantId]);
  return { owner, ref: owner.merchantId, id: String(rows[0]?.id) };
}

/** Sends `payload` as the exact bytes of the body, which is what signing covers. */
export function rawRequest(
  ctx: TestContext,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    key: string;
    payload?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }
) {
  return ctx.app.inject({
    method: options.method,
    url: options.url,
    remoteAddress: options.remoteAddress ?? '10.9.8.7',
    headers: {
      authorization: `Bearer ${options.key}`,
      ...(options.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

/** Signing headers for a request, computed as a merchant's client would. */
export function signedHeaders(
  secret: string,
  options: { method: string; url: string; payload?: string; timestamp?: number }
): Record<string, string> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    'x-mulapay-timestamp': timestamp,
    'x-mulapay-signature': computeSignature(
      secret,
      timestamp,
      options.method,
      options.url,
      options.payload === undefined ? undefined : Buffer.from(options.payload)
    ),
  };
}

export interface ReceivedWebhook {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface WebhookReceiver {
  readonly url: string;
  readonly received: ReceivedWebhook[];
  /** The status the receiver answers with. */
  status: number;
  /** Milliseconds to wait before answering. */
  delayMs: number;
  /** The response body. */
  body: string;
  /** A `Location` header to send, for redirect tests. */
  location: string | null;
  close(): Promise<void>;
}

/** A merchant's webhook server on a free local port. */
export async function startReceiver(initialStatus = 200): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const receiver: WebhookReceiver = {
    url: '',
    received,
    status: initialStatus,
    delayMs: 0,
    body: 'received',
    location: null,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      setTimeout(() => {
        res.statusCode = receiver.status;
        if (receiver.location) res.setHeader('location', receiver.location);
        res.end(receiver.body);
      }, receiver.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  (receiver as { url: string }).url =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  return receiver;
}

/** Runs the outbox until every row announcing this merchant's events has been handled. */
export async function pumpOutbox(ctx: DeveloperContext, merchantId: string): Promise<void> {
  // Suites share one database, so another suite's dispatcher may hold a claim on these rows.
  // Wait for its claim to end instead of spinning.
  for (let i = 0; i < 60; i++) {
    await ctx.dispatcher.dispatch();
    const rows = await ctx.sql(
      `select count(*)::int as n from core.outbox o
        where o.published_at is null and o.attempts < 10
          and (o.aggregate_id in (select id::text from core.merchant_events where merchant_id = $1)
            or o.aggregate_id in (select ref from core.webhook_deliveries where merchant_id = $1))`,
      [merchantId]
    );
    if (rows[0]?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('outbox rows of the merchant were not handled');
}

export interface DeliveryRow {
  readonly ref: string;
  readonly status: string;
  readonly attempt: number;
  readonly next_attempt_at: Date | null;
  readonly event_type: string;
  readonly http_status: number | null;
  readonly error: string | null;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly replay_of_ref: string | null;
}

export async function deliveriesOf(
  ctx: DeveloperContext,
  merchantId: string,
  endpointRef?: string
): Promise<DeliveryRow[]> {
  return (await ctx.sql(
    `select d.ref, d.status, d.attempt, d.next_attempt_at, d.event_type, d.http_status, d.error,
            d.endpoint_id, d.event_id, d.replay_of_ref
       from core.webhook_deliveries d
       join core.webhook_endpoints e on e.id = d.endpoint_id
      where d.merchant_id = $1 and ($2::text is null or e.ref = $2)
      order by d.created_at, d.ref`,
    [merchantId, endpointRef ?? null]
  )) as unknown as DeliveryRow[];
}

/** Makes a pending delivery due now, on the app's clock, so the next attempt call sends it. */
export async function makeDue(ctx: DeveloperContext, deliveryRef: string): Promise<void> {
  await ctx.sql(
    `update core.webhook_deliveries set next_attempt_at = $2::timestamptz - interval '1 second', locked_until = null
      where ref = $1 and status = 'pending'`,
    [deliveryRef, ctx.clock.now().toISOString()]
  );
}

/** Soft-deletes the merchant's endpoints, so a test starts without the earlier ones. */
export async function clearEndpoints(ctx: DeveloperContext, merchantId: string): Promise<void> {
  await ctx.sql(
    `update core.webhook_endpoints
        set deleted_at = now(), status = 'disabled', disabled_at = coalesce(disabled_at, now())
      where merchant_id = $1 and deleted_at is null`,
    [merchantId]
  );
}

/** Writes one merchant event, with its outbox row, as a state change in the app would. */
export async function emitEvent(
  ctx: DeveloperContext,
  merchant: DeveloperMerchant,
  options: {
    environment?: 'test' | 'live';
    type?: MerchantEventType;
    object?: Record<string, unknown>;
  } = {}
): Promise<{ id: string; ref: string }> {
  const events = ctx.app.get(MerchantEventsService, { strict: false });
  const type = options.type ?? 'payment.created';
  return ctx.units.run((tx) =>
    events.emit(tx, {
      merchantId: merchant.id,
      environment: options.environment ?? 'test',
      type,
      resourceType: type.split('.')[0] ?? 'payment',
      resourceId: `res_${randomUUID().slice(0, 8)}`,
      object: options.object ?? { id: 'pay_example', status: 'created' },
    })
  );
}
