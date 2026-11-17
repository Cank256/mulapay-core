/**
 * Gateway failure modes (spec 3.5, 6.2, 17 rule 5), over real HTTP and a real Redis.
 *
 * The rule under test: a failure to get an answer is never an answer. A timeout, a 5xx, a 504, a
 * truncated or malformed body and a dropped connection all leave the outcome of a disbursement
 * unknown, so core records `ambiguous`, never `rejected`, and a lookup that cannot be answered is
 * `unavailable`, never `not_found`. Nothing retries under a different `externalId`.
 *
 * The circuit breaker is exercised against Redis with a controllable clock: opens after five
 * consecutive ambiguous outcomes, half-opens after the reset time, closes after three successes,
 * reopens on a failed probe, and fails open (allows calls) when Redis is unreachable.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { GatewayOperationsClient } from '../../src/integrations/gateway/gateway-operations.client';
import { RedisCircuitBreaker } from '../../src/integrations/gateway/circuit-breaker';
import type { DisbursementRequest } from '../../src/integrations/gateway/gateway-operations.port';
import { FixedClock } from '../support/fixed-clock';
import { testConfig } from '../support/test-env';

type Mode =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'raw'; status: number; body: string }
  | { kind: 'truncated' }
  | { kind: 'drop' }
  | { kind: 'delay'; ms: number; status: number; body: unknown }
  | { kind: 'hang' };

let server: Server;
let baseUrl: string;
let mode: Mode = { kind: 'json', status: 201, body: {} };
const received: { method: string; url: string; body: string }[] = [];
const sockets = new Set<import('node:net').Socket>();

function accepted(status = 'pending', referenceId = 'ref-1') {
  return { success: true, data: { referenceId, status } };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  received.push({
    method: req.method ?? '',
    url: req.url ?? '',
    body: Buffer.concat(chunks).toString(),
  });
  const current = mode;
  switch (current.kind) {
    case 'json':
      res.writeHead(current.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(current.body));
      return;
    case 'raw':
      res.writeHead(current.status, { 'content-type': 'application/json' });
      res.end(current.body);
      return;
    case 'truncated':
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"success":true,"data":{"referenceId":"ref');
      res.destroy();
      return;
    case 'drop':
      req.socket.destroy();
      return;
    case 'delay':
      await new Promise((r) => setTimeout(r, current.ms));
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(current.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(current.body));
      }
      return;
    case 'hang':
      return;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  received.length = 0;
  mode = { kind: 'json', status: 201, body: accepted() };
});

function client(timeoutMs = 1000, circuitBreaker?: RedisCircuitBreaker): GatewayOperationsClient {
  // Create a no-op breaker that always allows and records as success
  const noopBreaker =
    circuitBreaker ??
    ({
      allow: async () => true,
      record: async () => 'closed' as const,
      mode: async () => 'closed' as const,
    } as unknown as RedisCircuitBreaker);

  const noopRecorder = {
    record: async () => {},
  };

  return new GatewayOperationsClient(
    testConfig({
      GATEWAY_BASE_URL: baseUrl,
      GATEWAY_API_KEY: 'gateway-test-key-0123456789',
      GATEWAY_TIMEOUT_MS: String(timeoutMs),
    }),
    pino({ level: 'silent' }),
    noopBreaker,
    noopRecorder as any
  );
}

const request: DisbursementRequest = {
  environment: 'live',
  providerId: 'airtel',
  externalId: 'po_01JBX8TESTPAYOUT0000000001',
  amountMinor: 50_000n,
  currency: 'UGX',
  payee: { partyIdType: 'MSISDN', partyId: '+256700000001' },
  metadata: { merchantId: 'mch_1', environment: 'live', coreTransactionId: 'txn_1' },
};

describe('disbursement outcomes: every non-answer is ambiguous', () => {
  it('201 and 200 are accepted; 200 is a duplicate of the same operation', async () => {
    expect(await client().submitDisbursement(request)).toEqual({
      kind: 'accepted',
      duplicate: false,
      referenceId: 'ref-1',
      status: 'pending',
    });
    mode = { kind: 'json', status: 200, body: accepted('successful', 'ref-1') };
    expect(await client().submitDisbursement(request)).toMatchObject({
      kind: 'accepted',
      duplicate: true,
      status: 'successful',
    });
  });

  it('504 carries identifiers and is ambiguous, and the request is sent exactly once', async () => {
    mode = {
      kind: 'json',
      status: 504,
      body: {
        success: false,
        error: {
          code: 'GATEWAY_TIMEOUT',
          details: { operationId: 'op-1', referenceId: 'ref-9', status: 'unknown' },
        },
      },
    };
    expect(await client().submitDisbursement(request)).toEqual({
      kind: 'ambiguous',
      referenceId: 'ref-9',
      httpStatus: 504,
    });
    // One attempt: a retry is the caller's job and must reuse the externalId.
    expect(received).toHaveLength(1);
  });

  it.each([500, 502, 503])('%i is ambiguous, not a failure', async (status) => {
    mode = { kind: 'json', status, body: { success: false } };
    expect(await client().submitDisbursement(request)).toMatchObject({
      kind: 'ambiguous',
      httpStatus: status,
    });
  });

  it('a request that outlives the timeout is ambiguous, even though the gateway may complete it', async () => {
    mode = { kind: 'hang' };
    const started = Date.now();
    expect(await client(1000).submitDisbursement(request)).toEqual({
      kind: 'ambiguous',
      referenceId: null,
      httpStatus: null,
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(received).toHaveLength(1);
  });

  it('a slow answer inside the timeout is still an answer', async () => {
    mode = { kind: 'delay', ms: 600, status: 201, body: accepted() };
    expect(await client(2000).submitDisbursement(request)).toMatchObject({ kind: 'accepted' });
  });

  it('a dropped connection is ambiguous', async () => {
    mode = { kind: 'drop' };
    expect(await client().submitDisbursement(request)).toMatchObject({ kind: 'ambiguous' });
  });

  it('a body cut off mid-answer is ambiguous', async () => {
    mode = { kind: 'truncated' };
    expect(await client().submitDisbursement(request)).toMatchObject({ kind: 'ambiguous' });
  });

  it.each([
    ['not JSON', 'upstream connect error'],
    ['empty', ''],
    ['an array', '[]'],
    ['a success without a reference', JSON.stringify({ success: true, data: {} })],
    ['a status core does not know', JSON.stringify(accepted('mystery'))],
  ])(
    'a 201 whose body is %s is ambiguous, never accepted and never failed',
    async (_name, body) => {
      mode = { kind: 'raw', status: 201, body };
      expect(await client().submitDisbursement(request)).toMatchObject({ kind: 'ambiguous' });
    }
  );

  it('refusals that provably created nothing are rejected, and 429 asks for a retry', async () => {
    const cases: [number, unknown][] = [
      [400, { kind: 'rejected', reason: 'validation', httpStatus: 400 }],
      [409, { kind: 'rejected', reason: 'conflict', httpStatus: 409 }],
      [401, { kind: 'rejected', reason: 'unauthorized', httpStatus: 401 }],
      [403, { kind: 'rejected', reason: 'unauthorized', httpStatus: 403 }],
      [404, { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 404 }],
      [429, { kind: 'rate_limited', retryAfterMs: null }],
    ];
    for (const [status, expected] of cases) {
      mode = { kind: 'json', status, body: { success: false } };
      expect(await client().submitDisbursement(request), String(status)).toEqual(expected);
    }
  });

  it('a retry after an ambiguous answer carries the same externalId and amount', async () => {
    mode = { kind: 'json', status: 504, body: { success: false } };
    await client().submitDisbursement(request);
    await client().submitDisbursement(request);
    mode = { kind: 'json', status: 200, body: accepted() };
    await client().submitDisbursement(request);
    const bodies = received.map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(new Set(bodies.map((b) => b.externalId))).toEqual(new Set([request.externalId]));
    expect(new Set(bodies.map((b) => b.amount))).toEqual(new Set(['50000']));
  });

  it('test-environment operations never reach the gateway', async () => {
    await expect(
      client().submitDisbursement({ ...request, environment: 'test' })
    ).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  it('refuses before sending when the client is not configured, and sends nothing', async () => {
    const noopBreaker = {
      allow: async () => true,
      record: async () => 'closed' as const,
      mode: async () => 'closed' as const,
    } as unknown as RedisCircuitBreaker;

    const noopRecorder = {
      record: async () => {},
    };

    const unconfigured = new GatewayOperationsClient(
      testConfig({ GATEWAY_BASE_URL: undefined, GATEWAY_API_KEY: undefined }),
      pino({ level: 'silent' }),
      noopBreaker,
      noopRecorder as any
    );
    expect(await unconfigured.submitDisbursement(request)).toMatchObject({
      kind: 'rejected',
      reason: 'provider_unavailable',
    });
    expect(received).toHaveLength(0);
  });
});

describe('lookups: not being able to ask is not "not found"', () => {
  it.each<[string, Mode]>([
    ['504', { kind: 'json', status: 504, body: {} }],
    ['500', { kind: 'json', status: 500, body: {} }],
    ['a dropped connection', { kind: 'drop' }],
    ['a malformed body', { kind: 'raw', status: 200, body: 'garbage' }],
    ['a 200 without an operation', { kind: 'json', status: 200, body: { data: {} } }],
  ])('by-external-id with %s is unavailable', async (_name, failure) => {
    mode = failure;
    expect((await client().findByExternalId('po_x')).kind).toBe('unavailable');
  });

  it('only a real 404 means the gateway has no such operation', async () => {
    mode = { kind: 'json', status: 404, body: {} };
    expect(await client().findByExternalId('po_x')).toEqual({ kind: 'not_found' });
  });

  it('a timed-out lookup, list and balance are all unavailable', async () => {
    mode = { kind: 'hang' };
    const c = client(1000);
    expect((await c.findByExternalId('po_x')).kind).toBe('unavailable');
    expect((await c.listOperations({ limit: 10, offset: 0 })).kind).toBe('unavailable');
    expect((await c.getBalance('mtn', 'disbursement', 'UGX')).kind).toBe('unavailable');
  });

  it('a list with one malformed operation is refused whole', async () => {
    mode = {
      kind: 'json',
      status: 200,
      body: { data: { operations: [{ status: 'successful' }], pagination: { total: 1 } } },
    };
    expect(await client().listOperations({ limit: 10, offset: 0 })).toMatchObject({
      kind: 'unavailable',
      reason: 'malformed_response',
    });
  });

  it('a balance in another currency is refused, not converted', async () => {
    mode = {
      kind: 'json',
      status: 200,
      body: { data: { availableBalance: '10.0000', currency: 'KES' } },
    };
    expect((await client().getBalance('mtn', 'disbursement', 'UGX')).kind).toBe('unavailable');
  });
});

describe('circuit breaker (Redis, shared by replicas)', () => {
  const redisUrl = `${inject('redisUrl').replace(/\/\d*$/, '')}/4`;
  const clock = new FixedClock('2031-01-01T00:00:00.000Z');
  let redis: Redis;
  let breaker: RedisCircuitBreaker;
  let provider = '';

  function make(connection: Redis): RedisCircuitBreaker {
    return new RedisCircuitBreaker(
      connection,
      clock,
      pino({ level: 'silent' }),
      testConfig({ GATEWAY_CIRCUIT_FAILURE_THRESHOLD: '5', GATEWAY_CIRCUIT_RESET_MS: '15000' })
    );
  }

  beforeAll(() => {
    redis = new Redis(redisUrl);
    breaker = make(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(() => {
    provider = `p${Math.random().toString(36).slice(2, 8)}`;
    clock.set('2031-01-01T00:00:00.000Z');
  });

  it('stays closed below five consecutive failures, and a success resets the run', async () => {
    for (let i = 0; i < 4; i += 1) await breaker.record(provider, 'disbursement', 'failure');
    expect(await breaker.mode(provider, 'disbursement')).toBe('closed');
    await breaker.record(provider, 'disbursement', 'success');
    for (let i = 0; i < 4; i += 1) await breaker.record(provider, 'disbursement', 'failure');
    expect(await breaker.mode(provider, 'disbursement')).toBe('closed');
  });

  it('opens on the fifth consecutive failure and refuses calls', async () => {
    for (let i = 0; i < 5; i += 1) {
      clock.advanceBy(1000);
      await breaker.record(provider, 'disbursement', 'failure');
    }
    expect(await breaker.mode(provider, 'disbursement')).toBe('open');
    expect(await breaker.allow(provider, 'disbursement')).toBe(false);
    // Another provider, or another operation, is unaffected.
    expect(await breaker.allow(`${provider}x`, 'disbursement')).toBe(true);
    expect(await breaker.allow(provider, 'collection')).toBe(true);
  });

  it('failures spread over more than 30 seconds do not open it', async () => {
    for (let i = 0; i < 6; i += 1) {
      await breaker.record(provider, 'disbursement', 'failure');
      clock.advanceBy(31_000);
    }
    expect(await breaker.mode(provider, 'disbursement')).toBe('closed');
  });

  it('half-opens after 15 seconds, closes after three successful probes', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.record(provider, 'disbursement', 'failure');
    clock.advanceBy(14_999);
    expect(await breaker.allow(provider, 'disbursement')).toBe(false);
    clock.advanceBy(1);
    expect(await breaker.allow(provider, 'disbursement')).toBe(true);
    expect(await breaker.mode(provider, 'disbursement')).toBe('half_open');
    await breaker.record(provider, 'disbursement', 'success');
    await breaker.record(provider, 'disbursement', 'success');
    expect(await breaker.mode(provider, 'disbursement')).toBe('half_open');
    await breaker.record(provider, 'disbursement', 'success');
    expect(await breaker.mode(provider, 'disbursement')).toBe('closed');
    expect(await breaker.allow(provider, 'disbursement')).toBe(true);
  });

  it('a failed probe reopens it for a full reset period', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.record(provider, 'disbursement', 'failure');
    clock.advanceBy(15_000);
    await breaker.allow(provider, 'disbursement');
    await breaker.record(provider, 'disbursement', 'failure');
    expect(await breaker.mode(provider, 'disbursement')).toBe('open');
    clock.advanceBy(14_000);
    expect(await breaker.allow(provider, 'disbursement')).toBe(false);
  });

  it('is shared: a second replica sees the state the first one wrote', async () => {
    const replica = new Redis(redisUrl);
    try {
      const other = make(replica);
      for (let i = 0; i < 5; i += 1) await breaker.record(provider, 'disbursement', 'failure');
      expect(await other.allow(provider, 'disbursement')).toBe(false);
    } finally {
      await replica.quit();
    }
  });

  it('concurrent failures from many callers are all counted', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => breaker.record(provider, 'disbursement', 'failure'))
    );
    expect(await breaker.mode(provider, 'disbursement')).toBe('open');
  });

  it('fails open when Redis is unreachable: payments are not blocked by a cache outage', async () => {
    const broken = new Redis({
      host: '127.0.0.1',
      port: 1,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    broken.on('error', () => undefined);
    const other = make(broken);
    expect(await other.allow(provider, 'disbursement')).toBe(true);
    expect(await other.record(provider, 'disbursement', 'failure')).toBe('closed');
    expect(await other.mode(provider, 'disbursement')).toBe('closed');
    broken.disconnect();
  });
});
