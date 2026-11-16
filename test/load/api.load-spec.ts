/**
 * Load against the spec 9.1 targets (`npm run test:load`).
 *
 * The application runs in this process and listens on a loopback port; the load comes from a
 * separate process (`generator.mjs`) so the two do not share an event loop. Postgres 16 and
 * Redis 7 are Testcontainers. Open-loop runs hold a fixed arrival rate and measure p99 from the
 * moment each request was due. The throughput run drives the connections as fast as they go.
 *
 * What is NOT measured here, and why, is stated in docs/LOAD_RESULTS.md: the event consumer
 * (Phase 3, not built) is only approximated by the payment lifecycle service it will call.
 *
 * Every target is asserted after all runs have finished and the results have been written, so
 * a miss still leaves the numbers on disk.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_KEY_SCOPES } from '../../src/common/authz/permissions';
import { DbApiKeyAuthenticator } from '../../src/modules/api-keys/api-key-authenticator.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { Client } from '../support/identity';
import {
  apiClient,
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  toProcessing,
  type TestMerchant,
} from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

/** Arrivals per second for the latency runs: below saturation, so p99 is not queueing. */
const READ_RATE = Number(process.env.LOAD_READ_RATE ?? 300);
const WRITE_RATE = Number(process.env.LOAD_WRITE_RATE ?? 100);
const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 15_000);
const WARMUP_MS = Number(process.env.LOAD_WARMUP_MS ?? 5_000);
const SEEDED_TRANSACTIONS = Number(process.env.LOAD_TRANSACTIONS ?? 200_000);
const SEEDED_PAYMENTS = 300;

interface HttpResult {
  mode: string;
  rate: number | null;
  connections: number;
  requests: number;
  failures: number;
  byStatus: Record<string, number>;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
interface Measure {
  readonly name: string;
  readonly target: string;
  readonly limit: number;
  readonly unit: 'ms' | 'req/s';
  readonly direction: 'below' | 'above';
  readonly measured: number;
  readonly detail: string;
}
const measures: Measure[] = [];
const notes: string[] = [];

let ctx: SupportContext;
let merchant: TestMerchant;
let baseUrl: string;
let paymentRefs: string[] = [];
let merchantClient: Client;

function generate(options: Record<string, unknown>): Promise<HttpResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, 'generator.mjs'), JSON.stringify({ baseUrl, ...options })],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) =>
      code === 0
        ? resolveRun(JSON.parse(out) as HttpResult)
        : reject(new Error(`generator ${code}`))
    );
  });
}
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

function latency(
  name: string,
  target: string,
  limit: number,
  result: HttpResult,
  expectStatus: number
) {
  expect(result.failures, `${name}: connection failures`).toBe(0);
  expect(
    Object.keys(result.byStatus),
    `${name}: every answer must be ${expectStatus} (got ${JSON.stringify(result.byStatus)})`
  ).toEqual([String(expectStatus)]);
  measures.push({
    name,
    target,
    limit,
    unit: 'ms',
    direction: 'below',
    measured: result.p99,
    detail: `${result.requests} requests at ${result.rate}/s over ${result.connections} connections; p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms`,
  });
}

beforeAll(async () => {
  ctx = await startSupportContext({
    isolated: 'runbooks',
    overrides: { DB_POOL_MAX: '20' },
  });
  // Diagnostic only (`LOAD_ASYNC_COMMIT=1`): how much of the write latency is the disk flush at commit.
  // The reported results are always taken with the default, durable setting.
  if (process.env.LOAD_ASYNC_COMMIT === '1') {
    await ctx.query('alter database mulapay_runbooks set synchronous_commit = off');
    notes.push('DIAGNOSTIC RUN with synchronous_commit = off: not a result against the targets.');
  }
  merchant = await createTestMerchant(ctx, { label: 'load' });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Data volume: the transactions list and its indexes should not be measured on an empty table.
  // The registry trigger only allows the application's own inserts, so it is switched off for this load.
  await ctx.query('begin');
  await ctx.query('set local session_replication_role = replica');
  await ctx.query(
    `insert into core.transaction_keys (id, ref, transaction_created_at, merchant_id, environment, type, created_at)
     select gen_random_uuid(), 'txn_' || upper(substr(md5(g::text) || md5(g::text || 'x'), 1, 26)),
            now() - (g * interval '3 seconds'), $1, 'test', 'payment', now() - (g * interval '3 seconds')
       from generate_series(1, $2::int) g`,
    [merchant.id, SEEDED_TRANSACTIONS]
  );
  await ctx.query(
    `insert into core.transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, provider, channel, initiated_at, completed_at, created_at, updated_at)
     select k.id, k.ref, k.merchant_id, 'test', 'payment', 'succeeded', 1000, 10, 990, 'UGX', 'mtn', 'mobile_money', k.created_at, k.created_at, k.created_at, k.created_at
       from core.transaction_keys k where k.merchant_id = $1`,
    [merchant.id]
  );
  await ctx.query('commit');
  await ctx.query('analyze core.transactions');

  // Real payments through the API, for the by-reference reads.
  const refs: string[] = [];
  for (let i = 0; i < SEEDED_PAYMENTS; i += 10) {
    const batch = await Promise.all(
      Array.from({ length: 10 }, () => createPayment(merchant.test, { amountMinor: '5000' }))
    );
    refs.push(...batch.map((p) => p.id));
  }
  paymentRefs = refs;
  await ctx.rollups.recomputeRecent();
  const key = await merchant.owner.client.post('/dashboard/v1/api-keys', {
    name: 'load',
    environment: 'test',
    scopes: [...API_KEY_SCOPES],
  });
  if (key.statusCode !== 201) throw new Error(`api key failed: ${key.body}`);
  readKey = key.json().data.key as string;
  merchantClient = apiClient(ctx, readKey);
});
afterAll(async () => {
  await ctx?.close();
});

/** A test key with every scope, so the balance and transaction routes answer. */
let readKey = '';
const auth = () => ({ authorization: `Bearer ${readKey}` });

describe('HTTP latency at a steady arrival rate (p99)', () => {
  it('GET /v1/payments/:ref', async () => {
    const result = await generate({
      paths: paymentRefs.map((ref) => `/v1/payments/${ref}`),
      headers: auth(),
      rate: READ_RATE,
      connections: 32,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    latency('GET /v1/payments/:ref', '< 50 ms', 50, result, 200);
  });
  it('GET /v1/transactions (25 rows, cursor)', async () => {
    const first = await merchantClient.get('/v1/transactions?limit=25');
    expect(first.statusCode, first.body).toBe(200);
    const cursor = first.json().meta?.nextCursor ?? first.json().data?.nextCursor;
    const paths = ['/v1/transactions?limit=25'];
    if (cursor) paths.push(`/v1/transactions?limit=25&cursor=${encodeURIComponent(cursor)}`);
    const result = await generate({
      paths,
      headers: auth(),
      rate: READ_RATE,
      connections: 32,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    latency('GET /v1/transactions (25 rows, cursor)', '< 120 ms', 120, result, 200);
  });
  it('GET /v1/balances', async () => {
    const result = await generate({
      paths: ['/v1/balances'],
      headers: auth(),
      rate: READ_RATE,
      connections: 32,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    latency('GET /v1/balances', '< 30 ms', 30, result, 200);
  });
  it('POST /v1/payments, excluding the gateway call (none exists yet)', async () => {
    const result = await generate({
      paths: ['/v1/payments'],
      method: 'POST',
      headers: auth(),
      body: { amountMinor: '10000', currency: 'UGX', paymentMethod: { msisdn: '+256700000001' } },
      uniqueKey: true,
      rate: WRITE_RATE,
      connections: 32,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    latency('POST /v1/payments (no gateway call)', '< 80 ms', 80, result, 201);
    notes.push(
      'POST /v1/payments runs the whole write path of Phase 4 (AML pre-check, idempotency, transaction, outbox) and no gateway call, because the Provider Gateway client is not built; the target excludes that call.'
    );
  });
  it('GET /dashboard/v1/analytics/overview', async () => {
    const owner = merchant.owner.client;
    const day = new Date().toISOString().slice(0, 10);
    const path = `/dashboard/v1/analytics/overview?environment=test&from=${day}&to=${day}`;
    const probe = await owner.get(path);
    expect(probe.statusCode, probe.body).toBe(200);
    const result = await generate({
      paths: [path],
      headers: { authorization: `Bearer ${owner.token}` },
      rate: READ_RATE,
      connections: 32,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    latency('GET /dashboard/v1/analytics/overview', '< 150 ms', 150, result, 200);
  });
});

describe('throughput', () => {
  it('sustains more than 1,200 req/s on a read mix, from one API process', async () => {
    const result = await generate({
      mode: 'closed',
      paths: [
        ...paymentRefs.slice(0, 50).map((ref) => `/v1/payments/${ref}`),
        '/v1/balances',
        '/v1/transactions?limit=25',
      ],
      headers: auth(),
      connections: 64,
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
    });
    expect(result.failures).toBe(0);
    expect(Object.keys(result.byStatus)).toEqual(['200']);
    measures.push({
      name: 'Read throughput, one API process',
      target: '> 1,200 req/s per 2 vCPU replica',
      limit: 1200,
      unit: 'req/s',
      direction: 'above',
      measured: result.throughput,
      detail: `${result.requests} requests over ${result.connections} connections; p50 ${result.p50.toFixed(1)} ms, p99 ${result.p99.toFixed(1)} ms. One Node process uses about one core; the target is for two.`,
    });
  });
});

describe('in-process measurements', () => {
  it('API key authentication overhead, on a cached key', async () => {
    const authenticator = ctx.app.get(DbApiKeyAuthenticator, { strict: false });
    const rawKey = readKey;
    for (let i = 0; i < 5000; i++) await authenticator.authenticate(rawKey, '10.0.0.1');
    const samples: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      const started = process.hrtime.bigint();
      const principal = await authenticator.authenticate(rawKey, '10.0.0.1');
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      if (!principal) throw new Error('key was refused');
    }
    samples.sort((a, b) => a - b);
    measures.push({
      name: 'API key authentication overhead',
      target: '< 1 ms',
      limit: 1,
      unit: 'ms',
      direction: 'below',
      measured: percentile(samples, 0.99),
      detail: `50,000 authentications of a cached key; p50 ${percentile(samples, 0.5).toFixed(3)} ms, p99.9 ${percentile(samples, 0.999).toFixed(3)} ms. Includes key parsing, the cache lookup and the constant-time hash comparison.`,
    });
  });

  it('ledger posting of a 6-line entry', async () => {
    const accounts = ctx.app.get(AccountsService, { strict: false });
    const open = async (n: number) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          ctx.unitOfWork
            .run((tx) =>
              accounts.openBankAccount(tx, {
                environment: 'test',
                bankKey: `ld${randomUUID().slice(0, 8)}${i}`,
                name: 'Load account',
                currency: 'MWK',
              })
            )
            .then((a) => a.code)
        )
      );
    const post = async (codes: string[]) => {
      const sourceId = `load-${randomUUID()}`;
      const started = process.hrtime.bigint();
      await ctx.unitOfWork.run((tx) =>
        ctx.posting.postEntry(tx, {
          idempotencyKey: ledgerIdempotencyKey('adjustment', sourceId),
          environment: 'test',
          currency: 'MWK',
          source: 'adjustment',
          sourceId,
          description: 'load',
          lines: [
            { accountCode: codes[0]!, direction: 'debit', amountMinor: 600n },
            { accountCode: codes[1]!, direction: 'debit', amountMinor: 300n },
            { accountCode: codes[2]!, direction: 'debit', amountMinor: 100n },
            { accountCode: codes[3]!, direction: 'credit', amountMinor: 700n },
            { accountCode: codes[4]!, direction: 'credit', amountMinor: 200n },
            { accountCode: codes[5]!, direction: 'credit', amountMinor: 100n },
          ],
          createdBy: { type: 'system', id: 'load' },
        })
      );
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const shared = await open(6);
    for (let i = 0; i < 200; i++) await post(shared);
    const sequential: number[] = [];
    for (let i = 0; i < 3000; i++) sequential.push(await post(shared));
    sequential.sort((a, b) => a - b);
    measures.push({
      name: 'Ledger posting, 6 lines, one caller',
      target: '< 25 ms',
      limit: 25,
      unit: 'ms',
      direction: 'below',
      measured: percentile(sequential, 0.99),
      detail: `3,000 sequential postings to the same six accounts; p50 ${percentile(sequential, 0.5).toFixed(1)} ms, max ${sequential.at(-1)?.toFixed(1)} ms. Each posting is one transaction: idempotency key, entry, 6 lines, 6 balance updates.`,
    });
    const sets = await Promise.all(Array.from({ length: 8 }, () => open(6)));
    const concurrent: number[] = [];
    await Promise.all(
      sets.map(async (codes) => {
        for (let i = 0; i < 500; i++) concurrent.push(await post(codes));
      })
    );
    concurrent.sort((a, b) => a - b);
    notes.push(
      `Ledger posting with 8 concurrent callers, each on its own six accounts: p50 ${percentile(concurrent, 0.5).toFixed(1)} ms, p99 ${percentile(concurrent, 0.99).toFixed(1)} ms over 4,000 postings. Callers that share an account queue on its row lock; that is the ledger's serialisation, not an overhead to tune away.`
    );
  });

  it('payment lifecycle events per second (a proxy, not the consumer)', async () => {
    const count = 600;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 20) {
      const batch = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const created = await createPayment(merchant.test, { amountMinor: '3000' });
          const detail = await ctx.paymentsRepository.findDetailByRef(
            merchant.scope('test'),
            created.id
          );
          await toProcessing(ctx, detail!.payment.id);
          return detail!.payment.id;
        })
      );
      ids.push(...batch);
    }
    const started = process.hrtime.bigint();
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < ids.length) {
          const id = ids[next++]!;
          const done = await applyEvent(
            ctx,
            id,
            event(
              { kind: 'succeeded', amountMinor: 3000n, currency: 'UGX' },
              {
                identifiers: {
                  provider: 'mtn',
                  providerTransactionId: `P-${randomUUID().slice(0, 10)}`,
                },
                occurredAt: ctx.clock.now(),
              }
            )
          );
          if (done.result !== 'applied') throw new Error(JSON.stringify(done));
        }
      })
    );
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    notes.push(
      `Payment lifecycle, ${count} succeeded events applied by 8 workers: ${(count / seconds).toFixed(0)} events/s. Each event is one transaction (state change, ledger posting, outbox rows). This is an upper bound for the event consumer, which also reads the gateway table and commits a cursor; the consumer (Phase 3) is not built, so the target of 500 events/s is NOT measured.`
    );
    expect(count / seconds).toBeGreaterThan(0);
  });
});

describe('the targets', () => {
  it('writes the results and holds every measured target', () => {
    const lines = [
      '# Load results',
      '',
      'Written by `npm run test:load` to `test/load/results/last-run.md`. Numbers below are from the run dated below; rerun to refresh. Targets are spec section 9.1, p99, steady state.',
      '',
      '## Environment',
      '',
      `- Date: ${new Date().toISOString()}`,
      `- Host: ${cpus().length} x ${cpus()[0]?.model ?? 'cpu'}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB, ${platform()} ${release()}, Node ${process.version}`,
      '- One API process (this test process) on loopback. Postgres 16 and Redis 7 in Docker on the same machine. The load generator is a separate Node process.',
      `- Data: ${SEEDED_TRANSACTIONS.toLocaleString('en')} transactions for the merchant under test, ${SEEDED_PAYMENTS} payments created through the API.`,
      `- Latency runs: open loop at ${READ_RATE} req/s (${WRITE_RATE} req/s for the write), ${WARMUP_MS / 1000} s warm-up, ${DURATION_MS / 1000} s measured, latency counted from when each request was due.`,
      '- The host is a development machine that also runs the database and the load generator, so absolute numbers are indicative; a replica of 2 vCPU on its own hardware is the reference for the target.',
      '',
      '## Results',
      '',
      '| Operation | Target | Measured (p99) | Result | Detail |',
      '| --- | --- | --- | --- | --- |',
      ...measures.map((m) => {
        const ok = m.direction === 'below' ? m.measured < m.limit : m.measured > m.limit;
        const shown =
          m.unit === 'ms'
            ? `${m.measured.toFixed(m.measured < 10 ? 3 : 1)} ms`
            : `${m.measured.toFixed(0)} req/s`;
        return `| ${m.name} | ${m.target} | ${shown} | ${ok ? 'met' : '**missed**'} | ${m.detail} |`;
      }),
      '| Event consumer throughput | > 500 events/s | not measured | open | The consumer is Phase 3 and not built. See the note on the lifecycle service below. |',
      '',
      '## Notes',
      '',
      ...notes.map((n) => `- ${n}`),
      '- The 30 minute soak test (no memory growth, no connection leak) belongs to Phase 9 (hardening) in the build order and has not been run.',
      '',
    ];
    if (process.env.LOAD_WRITE_RESULTS === '1') {
      // The committed docs/LOAD_RESULTS.md is curated from runs on suitable hardware; a run writes here.
      mkdirSync(join(__dirname, 'results'), { recursive: true });
      writeFileSync(join(__dirname, 'results/last-run.md'), lines.join('\n'));
    }
    for (const m of measures) {
      if (m.direction === 'below') {
        expect(m.measured, `${m.name} p99 ${m.measured} ms must be ${m.target}`).toBeLessThan(
          m.limit
        );
      } else {
        expect(m.measured, `${m.name} must be ${m.target}`).toBeGreaterThan(m.limit);
      }
    }
  });
});
