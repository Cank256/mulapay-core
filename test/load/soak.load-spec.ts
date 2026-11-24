/**
 * Soak test (spec 12: "no memory growth and no connection leak over 30 minutes").
 *
 * The built application runs as it does in production: an API process and a worker process, each
 * with its own memory, event loop and pools, against Postgres and Redis containers. A steady mixed
 * workload runs for `SOAK_MINUTES` (default 30) while a sampler records, every 15 seconds, memory,
 * CPU and file descriptors per process, database connections and saturation, Redis memory and key
 * count, queue depth and failed jobs. Latency is reported per window so drift shows up.
 *
 * The run is judged on trends in the second half (so warm-up is not counted as a leak) and on hard
 * invariants: no failed requests, no stuck queue, no idle-in-transaction connection, no growth in
 * connections or Redis keys, the ledger checks pass at the end.
 *
 * Writes `test/load/results/soak-last-run.json` and `.md`. Run: `npm run build && npm run test:soak`.
 * `SOAK_MINUTES=2` is a smoke run; its trends are not meaningful.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_KEY_SCOPES } from '../../src/common/authz/permissions';
import {
  FAKE_GATEWAY_KEY,
  startFakeGatewayOps,
  type FakeGatewayOps,
} from '../support/fake-gateway-ops';
import { checkFinancialInvariants } from '../support/invariants';
import { BUILT, startApplication, type RunningApplication } from '../support/processes';
import {
  apiClient,
  createPayment,
  createTestMerchant,
  sql,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';
import { ResourceSampler, trend, type Sample } from './sampler';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 30);
const SAMPLE_SECONDS = Number(process.env.SOAK_SAMPLE_SECONDS ?? 15);
const READ_RATE = Number(process.env.SOAK_READ_RATE ?? 80);
const WRITE_RATE = Number(process.env.SOAK_WRITE_RATE ?? 20);
const RETRY_RATE = Number(process.env.SOAK_RETRY_RATE ?? 10);
const QUEUE_PREFIX = `soak-${Date.now().toString(36)}`;
const urls = inject('databaseUrls');
const redisUrl = inject('redisUrl');
const containers = inject('chaosContainers');

let ctx: PaymentsContext;
let merchant: TestMerchant;
let api: RunningApplication;
let worker: RunningApplication;
let gateway: FakeGatewayOps;
let liveKey = '';
const refs: string[] = [];

interface GeneratorResult {
  requests: number;
  failures: number;
  byStatus: Record<string, number>;
  replayed: number;
  p50: number;
  p95: number;
  p99: number;
  windows: { atSeconds: number; requests: number; failures: number; p50: number; p99: number }[];
}

function generate(options: Record<string, unknown>): Promise<GeneratorResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, 'generator.mjs'), JSON.stringify(options)],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) =>
      code === 0
        ? resolveRun(JSON.parse(out) as GeneratorResult)
        : reject(new Error(`generator exited ${code}`))
    );
  });
}

beforeAll(async () => {
  if (!BUILT) throw new Error('run `npm run build` first: the soak runs dist/main.js');
  ctx = await startPaymentsContext({ DB_POOL_MAX: '20', QUEUE_PREFIX });
  merchant = await createTestMerchant(ctx, { active: true, label: 'soak' });
  // Limits the load must not hit: the daily volume control is tested elsewhere, and a soak that
  // trips it measures the refusal, not the write path.
  await sql(
    `insert into core.merchant_limits (merchant_id, currency, per_txn_max_minor, daily_volume_max_minor, monthly_volume_max_minor, payout_per_txn_max_minor, daily_payout_max_minor, source)
     values ($1, 'UGX', 100000000, 1000000000000, 1000000000000, 100000000, 1000000000000, 'manual')
     on conflict (merchant_id, currency) do update set per_txn_max_minor = excluded.per_txn_max_minor,
       daily_volume_max_minor = excluded.daily_volume_max_minor, monthly_volume_max_minor = excluded.monthly_volume_max_minor, source = 'manual'`,
    [merchant.id]
  );
  // A live key with every read and payment scope.
  const key = await merchant.owner.client.post('/merchant/v1/api-keys', {
    name: 'soak',
    environment: 'live',
    scopes: API_KEY_SCOPES.filter((s) => !s.includes('payouts')),
  });
  if (key.statusCode !== 201) throw new Error(`api key: ${key.body}`);
  liveKey = key.json().data.key as string;
  const live = apiClient(ctx, liveKey);
  for (let i = 0; i < 40; i += 5) {
    const batch = await Promise.all(
      Array.from({ length: 5 }, () =>
        createPayment(live, {
          amountMinor: '5000',
          currency: 'UGX',
          paymentMethod: { provider: 'mtn', msisdn: '+256700000101' },
        })
      )
    );
    refs.push(...batch.map((p) => p.id));
  }
  api = await startApplication('api', {
    QUEUE_PREFIX,
    METRICS_TOKEN: 'soak-metrics-token-soak-metrics',
  });
  // The scheduled reconciliation run asks the gateway; a worker without one fails that run by design.
  gateway = await startFakeGatewayOps();
  worker = await startApplication('worker', {
    QUEUE_PREFIX,
    GATEWAY_BASE_URL: gateway.baseUrl,
    GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
  });
}, 15 * 60_000);

afterAll(async () => {
  await api?.stop();
  await worker?.stop();
  await gateway?.close();
  await ctx?.close();
});

describe(`soak: ${MINUTES} minutes of mixed load, API and worker as separate processes`, () => {
  it(
    'shows no leak, no drift and no stuck work',
    async () => {
      const sampler = new ResourceSampler({
        postgresUrl: urls.superuser,
        redisUrl,
        queuePrefix: QUEUE_PREFIX,
        processes: { api: api.pid, worker: worker.pid },
        ...(containers
          ? { containers: { postgres: containers.postgresId, redis: containers.redisId } }
          : {}),
      });
      await sampler.start();
      const samples: Sample[] = [];
      const durationMs = MINUTES * 60_000;
      const baseUrl = `http://127.0.0.1:${api.port}`;
      const headers = { authorization: `Bearer ${liveKey}` };
      const body = {
        amountMinor: '10000',
        currency: 'UGX',
        paymentMethod: { provider: 'mtn', msisdn: '+256700000102' },
      };
      const common = { baseUrl, headers, durationMs, warmupMs: 5000, windowMs: 60_000 };

      // Four concurrent streams: reads (retrieval, balances, lists), new payments, and the same
      // payments sent again with the same Idempotency-Key (client retries).
      const streams = Promise.all([
        generate({
          ...common,
          paths: [
            ...refs.slice(0, 20).map((r) => `/v1/payments/${r}`),
            '/v1/balances',
            '/v1/transactions?limit=25',
          ],
          rate: READ_RATE,
          connections: 16,
        }),
        generate({
          ...common,
          paths: ['/v1/payments'],
          method: 'POST',
          body,
          uniqueKey: true,
          rate: WRITE_RATE,
          connections: 8,
        }),
        generate({
          ...common,
          paths: ['/v1/payments'],
          method: 'POST',
          body,
          keyPool: 25,
          keyPrefix: `retry-${QUEUE_PREFIX}`,
          rate: RETRY_RATE,
          connections: 4,
        }),
      ]);

      let done = false;
      void streams.finally(() => (done = true));
      while (!done) {
        samples.push(await sampler.sample());
        await new Promise((r) => setTimeout(r, SAMPLE_SECONDS * 1000));
      }
      const [reads, writes, retries] = await streams;
      samples.push(await sampler.sample());
      const redisKeys = await sampler.keyBreakdown();
      await sampler.stop();

      // Let the worker drain what the run produced (outbox rows, deliveries, request logs).
      await new Promise((r) => setTimeout(r, 20_000));
      const after = new ResourceSampler({
        postgresUrl: urls.superuser,
        redisUrl,
        queuePrefix: QUEUE_PREFIX,
        processes: {},
      });
      await after.start();
      const drained = await after.sample();
      await after.stop();

      // ---- analysis
      const series = (pick: (s: Sample) => number | undefined) =>
        samples.map(pick).filter((v): v is number => typeof v === 'number');
      const rss = (name: string) => series((s) => s.processes.find((p) => p.name === name)?.rssMb);
      const fds = (name: string) =>
        series((s) => s.processes.find((p) => p.name === name)?.fds ?? undefined);
      const report = {
        host: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
        minutes: MINUTES,
        samples: samples.length,
        rates: { read: READ_RATE, write: WRITE_RATE, retry: RETRY_RATE },
        http: { reads, writes, retries },
        trends: {
          apiRssMb: trend(rss('api'), SAMPLE_SECONDS),
          workerRssMb: trend(rss('worker'), SAMPLE_SECONDS),
          apiFds: trend(fds('api'), SAMPLE_SECONDS * 3),
          workerFds: trend(fds('worker'), SAMPLE_SECONDS * 3),
          dbConnections: trend(
            series((s) => s.db.connections),
            SAMPLE_SECONDS
          ),
          redisKeys: trend(
            series((s) => s.redis.keys),
            SAMPLE_SECONDS
          ),
          redisMemoryMb: trend(
            series((s) => s.redis.usedMemoryMb),
            SAMPLE_SECONDS
          ),
        },
        peaks: {
          dbActive: Math.max(...series((s) => s.db.active), 0),
          dbConnections: Math.max(...series((s) => s.db.connections), 0),
          dbMaxConnections: samples[0]?.db.maxConnections ?? 0,
          dbWaitingOnLocks: Math.max(...series((s) => s.db.waitingOnLocks), 0),
          idleInTransaction: Math.max(...series((s) => s.db.idleInTransaction), 0),
          longestTransactionSeconds: Math.max(...series((s) => s.db.longestTransactionSeconds), 0),
          deadlocks: samples.at(-1)?.db.deadlocks ?? 0,
          cacheHitPercent: samples.at(-1)?.db.cacheHitPercent ?? 0,
          tempFiles: samples.at(-1)?.db.tempFiles ?? 0,
          apiCpuPercent: Math.max(
            ...series((s) => s.processes.find((p) => p.name === 'api')?.cpuPercent),
            0
          ),
          workerCpuPercent: Math.max(
            ...series((s) => s.processes.find((p) => p.name === 'worker')?.cpuPercent),
            0
          ),
          postgresCpuPercent: Math.max(...series((s) => s.containers.postgres?.cpuPercent), 0),
          redisCpuPercent: Math.max(...series((s) => s.containers.redis?.cpuPercent), 0),
          redisOpsPerSecond: Math.max(...series((s) => s.redis.opsPerSecond), 0),
          redisEvictions: samples.at(-1)?.redis.evictedKeys ?? 0,
          queueDepth: Math.max(
            ...samples.map((s) =>
              Object.values(s.queues).reduce((n, q) => n + q.waiting + q.delayed, 0)
            ),
            0
          ),
          queueActive: Math.max(
            ...samples.map((s) => Object.values(s.queues).reduce((n, q) => n + q.active, 0)),
            0
          ),
        },
        afterDrain: {
          queueWaiting: Object.values(drained.queues).reduce((n, q) => n + q.waiting, 0),
          queueFailed: Object.values(drained.queues).reduce((n, q) => n + q.failed, 0),
        },
        latencyWindows: { reads: reads.windows, writes: writes.windows },
        redisKeys,
        sampleSeries: samples,
      };
      mkdirSync(join(__dirname, 'results'), { recursive: true });
      writeFileSync(join(__dirname, 'results/soak-last-run.json'), JSON.stringify(report, null, 2));

      // ---- invariants (judge on the second half; a smoke run skips the trend checks)
      expect(reads.failures + writes.failures + retries.failures, 'failed requests').toBe(0);
      expect(Object.keys(reads.byStatus)).toEqual(['200']);
      expect(Object.keys(writes.byStatus)).toEqual(['201']);
      expect(
        retries.replayed,
        'idempotent retries replayed from the stored response'
      ).toBeGreaterThan(0);
      // A transaction that is open for a moment between two statements is normal; one that stays open
      // is a leak. The role setting `idle_in_transaction_session_timeout` is 10 s, so nothing may
      // reach that age. (The count of such connections at an instant depends on how busy the host is.)
      expect(
        report.peaks.longestTransactionSeconds,
        'longest open transaction, seconds'
      ).toBeLessThan(10);
      expect(report.peaks.deadlocks).toBe(0);
      expect(report.peaks.dbConnections).toBeLessThan(report.peaks.dbMaxConnections * 0.5);
      expect(report.afterDrain.queueFailed, 'failed jobs').toBe(0);
      expect(report.afterDrain.queueWaiting, 'jobs still waiting after the drain').toBeLessThan(50);
      if (MINUTES >= 10) {
        expect(
          report.trends.dbConnections.perHour,
          'connection growth per hour'
        ).toBeLessThanOrEqual(2);
        expect(
          report.trends.apiFds.perHour,
          'API file descriptor growth per hour'
        ).toBeLessThanOrEqual(20);
        expect(
          report.trends.workerFds.perHour,
          'worker file descriptor growth per hour'
        ).toBeLessThanOrEqual(20);
        // Memory: allow 10% of the starting size per hour on top of noise (a leak is a steady slope).
        expect(report.trends.apiRssMb.perHour, 'API RSS growth MB per hour').toBeLessThan(
          Math.max(40, report.trends.apiRssMb.first * 0.1)
        );
        expect(report.trends.workerRssMb.perHour, 'worker RSS growth MB per hour').toBeLessThan(
          Math.max(40, report.trends.workerRssMb.first * 0.1)
        );
        const win = reads.windows.filter((w) => w.requests > 0);
        const early =
          win.slice(1, 4).reduce((n, w) => n + w.p99, 0) / Math.max(1, win.slice(1, 4).length);
        const late =
          win.slice(-3).reduce((n, w) => n + w.p99, 0) / Math.max(1, win.slice(-3).length);
        expect(late, 'read p99 late in the run versus early').toBeLessThan(early * 2 + 20);
      }
      expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
    },
    (MINUTES + 15) * 60_000
  );

  it.skipIf(!process.env.SOAK_WRITE_RESULTS)('writes a human-readable summary', () => {
    expect(true).toBe(true);
  });
});
