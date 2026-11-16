/**
 * The worker's jobs (spec 8.1, 8.8, 8.9): the repeating schedules, the tick processor, and
 * the recovery sweep that re-queues webhook attempts whose queue job was lost.
 */
import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.definitions';
import { QueueRegistry } from '../../src/common/queue/queue.registry';
import { JobSchedulers } from '../../src/jobs/job-schedulers';
import { OutboxDispatchProcessor, TICK_JOBS } from '../../src/jobs/outbox-dispatch.processor';
import { WebhookDeliveryRecovery } from '../../src/modules/webhooks/webhook-delivery.processor';
import { deliveryJobId } from '../../src/modules/webhooks/webhook-delivery.service';
import {
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
import { testConfig } from '../support/test-env';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let key: IssuedKey;
let receiver: WebhookReceiver;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'jobs' });
  key = await issueKey(ctx, merchant.owner, { environment: 'test', scopes: ['webhooks:write'] });
  receiver = await startReceiver(500);
});
afterAll(async () => {
  await receiver.close();
  await ctx.close();
});

const job = (name: string) => ({ name, data: {} }) as unknown as Job;

describe('job schedules', () => {
  it('registers the outbox tick, the log flush and the last-used flush, once however often it runs', async () => {
    const config = testConfig({ QUEUE_PREFIX: `sched-test-${randomUUID().slice(0, 8)}` });
    const registry = new QueueRegistry(config, pino({ level: 'silent' }));
    try {
      const schedulers = new JobSchedulers(registry, config);
      await schedulers.onApplicationBootstrap();
      await schedulers.onApplicationBootstrap();
      const queue = registry.get(QUEUES.outboxDispatch.name);
      const registered = await queue.getJobSchedulers();
      expect(
        registered
          .map((s) => ({ key: s.key, every: s.every, name: s.name }))
          .sort((a, b) => a.key.localeCompare(b.key))
      ).toEqual([
        { key: 'api-keys-flush-last-used', every: 10_000, name: TICK_JOBS.lastUsed },
        { key: 'outbox-tick', every: 1_000, name: TICK_JOBS.outbox },
        { key: 'request-logs-flush', every: 2_000, name: TICK_JOBS.requestLogs },
      ]);
      // Phase 6: settlement tick, and the three scheduled reconciliation runs (spec 6.8, 6.9).
      const settlement = await registry.get(QUEUES.settlementRun.name).getJobSchedulers();
      expect(settlement.map((x) => x.key)).toEqual(['settlement-tick']);
      const recon = await registry.get(QUEUES.reconciliationRun.name).getJobSchedulers();
      expect(recon.map((x) => x.key).sort()).toEqual([
        'reconciliation-gap',
        'reconciliation-integrity',
        'reconciliation-proof',
      ]);
      expect(recon.find((x) => x.key === 'reconciliation-gap')?.every).toBe(
        config.RECON_GAP_INTERVAL_SECONDS * 1000
      );
      await queue.obliterate({ force: true });
      await registry.get(QUEUES.settlementRun.name).obliterate({ force: true });
      await registry.get(QUEUES.reconciliationRun.name).obliterate({ force: true });
    } finally {
      await registry.onApplicationShutdown();
    }
  });
});

describe('the tick processor', () => {
  it('runs the work its job name asks for, and refuses other jobs', async () => {
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(3) };
    const recovery = { recover: vi.fn().mockResolvedValue(0) };
    const requestLogs = { flush: vi.fn().mockResolvedValue(7) };
    const usage = { flush: vi.fn().mockResolvedValue(2) };
    const processor = new OutboxDispatchProcessor(
      dispatcher as never,
      recovery as never,
      requestLogs as never,
      usage as never
    );
    expect(processor.definition).toBe(QUEUES.outboxDispatch);
    expect(await processor.process(job(TICK_JOBS.outbox))).toBe(3);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(await processor.process(job(TICK_JOBS.requestLogs))).toBe(7);
    expect(await processor.process(job(TICK_JOBS.lastUsed))).toBe(2);
    await expect(processor.process(job('something.else'))).rejects.toBeInstanceOf(
      UnrecoverableError
    );
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('publishes a due outbox row and re-queues overdue deliveries in one tick', async () => {
    const created = await key.client.post('/v1/webhook-endpoints', {
      url: receiver.url,
      enabledEvents: ['*'],
    });
    await emitEvent(ctx, merchant);
    const processor = new OutboxDispatchProcessor(
      ctx.dispatcher,
      ctx.app.get(WebhookDeliveryRecovery, { strict: false }),
      ctx.requestLogs,
      { flush: () => Promise.resolve(0) } as never
    );
    expect(await processor.process(job(TICK_JOBS.outbox))).toBeGreaterThanOrEqual(1);
    const deliveries = await deliveriesOf(ctx, merchant.id, created.json().data.id);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('webhook retries and the recovery sweep', () => {
  it('queues the next attempt with its delay when an attempt fails', async () => {
    const endpoint = (
      await key.client.post('/v1/webhook-endpoints', { url: receiver.url, enabledEvents: ['*'] })
    ).json().data;
    const event = await emitEvent(ctx, merchant);
    await pumpOutbox(ctx, merchant.id);
    const delivery = (await deliveriesOf(ctx, merchant.id, endpoint.id)).find(
      (d) => d.event_id === event.id
    );
    expect(await ctx.deliveryService.attempt(delivery?.ref as string)).toBe('retry_scheduled');
    const queued = await ctx.queues
      .get(QUEUES.webhookDelivery.name)
      .getJob(deliveryJobId(delivery?.ref as string, 2));
    expect(queued?.data).toEqual({ deliveryRef: delivery?.ref });
    expect(queued?.opts.delay).toBeGreaterThanOrEqual(30_000 * 0.8 - 1);
    expect(queued?.opts.delay).toBeLessThanOrEqual(30_000 * 1.2 + 1);
    expect(queued?.opts.attempts).toBe(3);
  });

  it('re-queues a pending delivery whose job was lost, once per minute, and only when overdue', async () => {
    const endpoint = (
      await key.client.post('/v1/webhook-endpoints', { url: receiver.url, enabledEvents: ['*'] })
    ).json().data;
    const event = await emitEvent(ctx, merchant);
    await pumpOutbox(ctx, merchant.id);
    const delivery = (await deliveriesOf(ctx, merchant.id, endpoint.id)).find(
      (d) => d.event_id === event.id
    );
    const recovery = ctx.app.get(WebhookDeliveryRecovery, { strict: false });
    const queue = ctx.queues.get(QUEUES.webhookDelivery.name);
    const minute = (offsetMs = 0) => Math.floor((ctx.clock.now().getTime() + offsetMs) / 60_000);
    const jobId = (offsetMs = 0) =>
      `${deliveryJobId(delivery?.ref as string, 1)}_r${minute(offsetMs)}`;

    // Due but not yet overdue: left to its own job.
    await recovery.recover();
    expect(await queue.getJob(jobId())).toBeUndefined();

    // Overdue by more than a minute: re-queued, with a job id that cannot clash with the lost one.
    ctx.clock.advanceBy(2 * 60_000);
    expect(await recovery.recover()).toBeGreaterThanOrEqual(1);
    const queued = await queue.getJob(jobId());
    expect(queued?.data).toEqual({ deliveryRef: delivery?.ref });
    // Asking again in the same minute adds nothing new.
    const before = (await queue.getJobCounts('waiting', 'delayed')).waiting;
    await recovery.recover();
    expect((await queue.getJobCounts('waiting', 'delayed')).waiting).toBe(before);

    // Sent, it is no longer overdue.
    await ctx.deliveryService.attempt(delivery?.ref as string);
    await makeDue(ctx, delivery?.ref as string);
    ctx.clock.advanceBy(-2 * 60_000);
  });

  it('does not touch deliveries that are final', async () => {
    const ok = await startReceiver(200);
    try {
      const endpoint = (
        await key.client.post('/v1/webhook-endpoints', { url: ok.url, enabledEvents: ['*'] })
      ).json().data;
      const event = await emitEvent(ctx, merchant);
      await pumpOutbox(ctx, merchant.id);
      const delivery = (await deliveriesOf(ctx, merchant.id, endpoint.id)).find(
        (d) => d.event_id === event.id
      );
      await ctx.deliveryService.attempt(delivery?.ref as string);
      ctx.clock.advanceBy(10 * 60_000);
      await ctx.app.get(WebhookDeliveryRecovery, { strict: false }).recover();
      const stale = await ctx.queues
        .get(QUEUES.webhookDelivery.name)
        .getJob(
          `${deliveryJobId(delivery?.ref as string, 2)}_r${Math.floor(ctx.clock.now().getTime() / 60_000)}`
        );
      expect(stale).toBeUndefined();
      ctx.clock.advanceBy(-10 * 60_000);
    } finally {
      await ok.close();
    }
  });
});
