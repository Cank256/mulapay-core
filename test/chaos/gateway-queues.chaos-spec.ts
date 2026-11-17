/**
 * Chaos C, D and F: the gateway returns 504 for a minute, workers are killed during queue
 * processing, and webhook work is duplicated.
 *
 * Chaos A (killing the gateway event consumer during a batch) cannot be run: the consumer is Phase 3
 * and is not built (docs/PRODUCTION_READINESS.md). Its nearest equivalents are in postgres.chaos-spec.ts.
 *
 * Scenario C is the settlement payout, the one place Core calls the gateway to move money today.
 * The rule it proves is spec 17 rule 5: if the gateway has not said `successful`, no money moves in
 * the ledger, and a failure to get an answer is never read as "the provider did nothing".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OpsMonitorService } from '../../src/modules/operations/ops-monitor.service';
import { sleep } from '../support/chaos';
import { checkFinancialInvariants } from '../support/invariants';
import {
  clearEndpoints,
  createMerchant,
  deliveriesOf,
  emitEvent,
  issueKey,
  pumpOutbox,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
  type DeveloperMerchant,
} from '../support/developer';
import {
  accountBalance,
  CURRENCY,
  runDate,
  setUpMerchant,
  settlementEntries,
  startSettlementContext,
  succeedPayment,
  type SettlementContext,
} from '../support/settlement';
import { sql } from '../support/payments';
import { randomUUID } from 'node:crypto';

const urls = inject('databaseUrls');
/** The specified outage is one minute. `CHAOS_504_MS` shortens it for a quick local check. */
const OUTAGE_MS = Number(process.env.CHAOS_504_MS ?? 60_000);
const A = randomUUID();
const B = randomUUID();

describe('C: the gateway answers 504 to everything for a minute', () => {
  let ctx: SettlementContext;
  beforeAll(async () => {
    ctx = await startSettlementContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it(
    'keeps the payout unknown, posts nothing, never re-sends under a new key, and settles correctly once the gateway recovers',
    async () => {
      const m = await setUpMerchant(ctx);
      await ctx.reserve.set(
        m.merchant.ref,
        { currency: CURRENCY, percentBps: 1000, holdDays: 30, active: true },
        A
      );
      await succeedPayment(ctx, m, 400_000n, 4_000n);
      await succeedPayment(ctx, m, 600_000n);
      const run = await ctx.runs.runCycle(m.cycleRef, {
        asOf: runDate(ctx),
        triggeredBy: `user:${A}`,
      });
      expect(run.outcome).toBe('completed');
      const [draft] = (await ctx.batches.list({ merchantId: m.merchant.id, limit: 50 })).items;
      if (!draft) throw new Error('no batch');
      await ctx.batches.submit(draft.ref, A);
      await ctx.batches.approve(draft.ref, B);
      const { batch } = await ctx.release.release(draft.ref, B);
      const availableBefore = (await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY))
        .availableMinor;

      // The outage begins: the disbursement answers 504 after recording it, and so does every lookup.
      ctx.gateway.disbursement = { kind: 'gateway_timeout' };
      ctx.gateway.lookupStatus = 504;
      expect(await ctx.release.submitPayout(batch.id)).toBe('unknown_outcome');

      const results: string[] = [];
      const started = Date.now();
      while (Date.now() - started < OUTAGE_MS) {
        await ctx.release.sweep(100);
        results.push(await ctx.release.verifyPayout(batch.id));
        // Simulated time moves with real time so the sweeps and the stuck-transaction threshold see it.
        ctx.clock.advanceBy(5_000);
        await sleep(5_000);
      }

      // During the whole outage: still releasing, payout processing and flagged unknown, hold kept.
      expect(results.length).toBeGreaterThan(0);
      expect(new Set(results)).toEqual(new Set(['unavailable']));
      const [payout] = await sql<{ status: string; outcome_unknown: boolean }>(
        `select status, outcome_unknown from core.transactions where id = $1`,
        [batch.payoutTransactionId]
      );
      expect(payout).toEqual({ status: 'processing', outcome_unknown: true });
      expect((await ctx.batches.get(batch.ref)).status).toBe('releasing');
      const [hold] = await sql<{ state: string }>(`select state from core.holds where id = $1`, [
        batch.holdId,
      ]);
      expect(hold?.state).toBe('active');
      expect(await settlementEntries(batch.ref)).toEqual([]);
      expect(
        (await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY)).availableMinor
      ).toBe(availableBefore);
      // Exactly one operation exists at the gateway, and every request carried its key.
      const calls = ctx.gateway.disbursementCalls.filter((c) => c.externalId === batch.payoutRef);
      expect(calls).toHaveLength(1);
      expect(
        ctx.gateway.disbursementCalls.every(
          (c) => c.externalId.startsWith('po_') || c.externalId === batch.payoutRef
        )
      ).toBe(true);

      // The incident monitor sees a transaction stuck in processing and opens an incident.
      ctx.clock.advanceBy(30 * 60_000);
      const monitor = ctx.app.get(OpsMonitorService, { strict: false });
      expect(await monitor.evaluate()).toContain('ops:stuck_transactions');
      const incidents = await sql<{ status: string; severity: string }>(
        `select status, severity from core.incidents where dedupe_key = 'ops:stuck_transactions' order by created_at desc limit 1`
      );
      expect(incidents).toHaveLength(1);

      // Recovery: the gateway comes back and reports that the payout succeeded.
      ctx.gateway.lookupStatus = undefined;
      ctx.gateway.disbursement = { kind: 'accept' };
      ctx.gateway.setStatus(batch.payoutRef as string, 'disbursement', 'successful');
      expect(await ctx.release.verifyPayout(batch.id)).toBe('applied');
      expect((await ctx.batches.get(batch.ref)).status).toBe('paid');
      expect(await settlementEntries(batch.ref)).toHaveLength(2);
      const [captured] = await sql<{ state: string }>(
        `select state from core.holds where id = $1`,
        [batch.holdId]
      );
      expect(captured?.state).toBe('captured');
      // Still one request at the gateway: the recovery verified, it did not resend.
      expect(
        ctx.gateway.disbursementCalls.filter((c) => c.externalId === batch.payoutRef)
      ).toHaveLength(1);
      // Applying it again, or sweeping, changes nothing.
      expect(await ctx.release.verifyPayout(batch.id)).toBe('skipped');
      await ctx.release.sweep(100);
      expect(await settlementEntries(batch.ref)).toHaveLength(2);
      expect(await accountBalance(`1200:settlement_in_transit`)).toBeGreaterThanOrEqual(0n);
      expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
    },
    10 * 60_000
  );

  it('a gateway that answers 504 and then says "failed" releases the hold and posts nothing', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 500_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: `user:${A}` });
    const [draft] = (await ctx.batches.list({ merchantId: m.merchant.id, limit: 50 })).items;
    if (!draft) throw new Error('no batch');
    await ctx.batches.submit(draft.ref, A);
    await ctx.batches.approve(draft.ref, B);
    const { batch } = await ctx.release.release(draft.ref, B);
    ctx.gateway.disbursement = { kind: 'gateway_timeout' };
    expect(await ctx.release.submitPayout(batch.id)).toBe('unknown_outcome');
    ctx.gateway.setStatus(batch.payoutRef as string, 'disbursement', 'failed');
    expect(await ctx.release.verifyPayout(batch.id)).toBe('applied');
    expect((await ctx.batches.get(batch.ref)).status).toBe('failed');
    expect(await settlementEntries(batch.ref)).toEqual([]);
    const [hold] = await sql<{ state: string }>(`select state from core.holds where id = $1`, [
      batch.holdId,
    ]);
    expect(hold?.state).toBe('released');
    ctx.gateway.disbursement = { kind: 'accept' };
    expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
  });
});

/** A BullMQ worker in its own OS process, so it can be killed the way a crash or an OOM kill ends it. */
function startWorkerProcess(env: Record<string, string>): {
  child: ChildProcess;
  started: () => number;
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(__dirname, 'fixtures/queue-worker.ts')],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  let started = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    started += (chunk.toString().match(/^started /gm) ?? []).length;
  });
  return { child, started: () => started };
}

describe('D: workers are killed during queue processing', () => {
  const queueName = `chaos-d-${randomUUID().slice(0, 8)}`;
  const prefix = `chaos-${randomUUID().slice(0, 8)}`;
  const redisUrl = inject('redisUrl');
  let queue: Queue;
  let connection: Redis;
  let pg: Client;

  beforeAll(async () => {
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection, prefix });
    pg = new Client({ connectionString: urls.superuser });
    await pg.connect();
    await pg.query(
      'create table if not exists public.chaos_effects (key text primary key, runs int not null default 0, finished boolean not null default false)'
    );
  });
  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    connection?.disconnect();
    await pg?.end();
  });

  it(
    'a SIGKILLed worker loses no job: the stalled ones are picked up by the next worker and each effect happens once',
    async () => {
      const jobs = 12;
      for (let i = 0; i < jobs; i += 1) {
        // The job options of every core queue (queue.definitions.ts DEFAULT_JOB_OPTIONS).
        await queue.add(
          'work',
          { key: `job-${i}` },
          {
            jobId: `job-${i}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: false,
            removeOnFail: false,
          }
        );
      }
      const env = {
        REDIS_URL: redisUrl,
        PG_URL: urls.superuser,
        QUEUE: queueName,
        PREFIX: prefix,
        WORK_MS: '6000',
      };
      const first = startWorkerProcess(env);
      const waited = Date.now();
      while (first.started() < 4 && Date.now() - waited < 60_000) await sleep(100);
      expect(first.started()).toBeGreaterThanOrEqual(4);

      first.child.kill('SIGKILL');
      const killedAt = Date.now();
      const counts = await queue.getJobCounts('active', 'waiting', 'completed', 'failed');
      expect(counts.active).toBeGreaterThan(0); // jobs were in flight when the process died

      const second = startWorkerProcess(env);
      const deadline = Date.now() + 4 * 60_000;
      let done = 0;
      while (Date.now() < deadline) {
        done = await queue.getCompletedCount();
        if (done >= jobs) break;
        await sleep(1000);
      }
      const recoveredAfterMs = Date.now() - killedAt;
      second.child.kill('SIGTERM');

      expect(done).toBe(jobs);
      expect(await queue.getFailedCount()).toBe(0);
      const effects = (
        await pg.query('select key, runs, finished from public.chaos_effects order by key')
      ).rows;
      expect(effects).toHaveLength(jobs);
      expect(effects.every((e: { finished: boolean }) => e.finished)).toBe(true);
      // At least one job ran twice (it was in flight at the kill), and still has one effect row.
      expect(effects.some((e: { runs: number }) => e.runs >= 2)).toBe(true);
      // Recovery is bounded by BullMQ's lock and stall timers (30 s each by default): record it.
      expect(recoveredAfterMs).toBeLessThan(3 * 60_000);
      process.stdout.write(
        `queue recovery after SIGKILL: ${Math.round(recoveredAfterMs / 1000)} s for ${jobs} jobs\n`
      );
    },
    6 * 60_000
  );
});

describe('F: duplicate webhook jobs', () => {
  let ctx: DeveloperContext;
  let merchant: DeveloperMerchant;
  beforeAll(async () => {
    ctx = await startDeveloperContext();
    merchant = await createMerchant(ctx, { active: true, label: 'chaos-f' });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('the same delivery attempted by many workers at once sends one request and one outcome', async () => {
    await clearEndpoints(ctx, merchant.id);
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['webhooks:read', 'webhooks:write', 'events:read'],
    });
    const receiver = await startReceiver(200);
    try {
      const created = await key.client.post('/v1/webhook-endpoints', {
        url: receiver.url,
        enabledEvents: ['*'],
      });
      expect(created.statusCode).toBe(201);
      const event = await emitEvent(ctx, merchant, { type: 'payment.created' });
      // Four dispatchers race for the same outbox rows: one delivery per endpoint results.
      await Promise.all(Array.from({ length: 4 }, () => ctx.dispatcher.dispatch()));
      await pumpOutbox(ctx, merchant.id);
      const deliveries = (await deliveriesOf(ctx, merchant.id)).filter(
        (d) => d.event_id === event.id
      );
      expect(deliveries).toHaveLength(1);
      const [delivery] = deliveries;
      if (!delivery) throw new Error('no delivery');

      // Eight workers get the same job.
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => ctx.deliveryService.attempt(delivery.ref))
      );
      expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
      expect(receiver.received).toHaveLength(1);
      // And a late duplicate after success sends nothing.
      await ctx.deliveryService.attempt(delivery.ref);
      expect(receiver.received).toHaveLength(1);
      const [final] = (await deliveriesOf(ctx, merchant.id)).filter((d) => d.ref === delivery.ref);
      expect(final).toMatchObject({ status: 'succeeded', attempt: 1 });
    } finally {
      await receiver.close();
    }
  });

  it('a redelivered job after a failed attempt keeps the schedule: one more attempt, not a second sequence', async () => {
    await clearEndpoints(ctx, merchant.id);
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['webhooks:read', 'webhooks:write', 'events:read'],
    });
    const receiver = await startReceiver(500);
    try {
      await key.client.post('/v1/webhook-endpoints', { url: receiver.url, enabledEvents: ['*'] });
      const event = await emitEvent(ctx, merchant, { type: 'payment.failed' });
      await pumpOutbox(ctx, merchant.id);
      const [delivery] = (await deliveriesOf(ctx, merchant.id)).filter(
        (d) => d.event_id === event.id
      );
      if (!delivery) throw new Error('no delivery');
      await Promise.all(Array.from({ length: 5 }, () => ctx.deliveryService.attempt(delivery.ref)));
      const [after] = (await deliveriesOf(ctx, merchant.id)).filter((d) => d.ref === delivery.ref);
      expect(after?.status).toBe('pending');
      // Five simultaneous workers made one attempt: the lease admitted one.
      expect(after?.attempt).toBe(1);
      expect(receiver.received).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });
});
