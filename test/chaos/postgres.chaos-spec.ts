/**
 * Chaos B, E and G: PostgreSQL killed while payment events are applied, duplicate gateway events,
 * and a crash between applying an event and acknowledging it.
 *
 * What stands in for the gateway event consumer: Phase 3 (the consumer, `gateway_events`, the
 * cursor) is not built, so these tests drive `PaymentLifecycleService.apply` exactly as the
 * consumer will, one transaction per event with the gateway's `event_id` as the idempotency key,
 * and redeliver an event until it is acknowledged (at-least-once, spec 3.6). They prove the
 * properties the consumer will depend on: an event is applied atomically or not at all, a replay
 * is a no-op, and a crash at any point leaves nothing half done.
 *
 * Every test ends by running the independent invariant checks over the whole database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  chaosContainers,
  killContainer,
  redeliver,
  runPool,
  sleep,
  startContainer,
  waitForPostgres,
} from '../support/chaos';
import { checkFinancialInvariants, trialBalance } from '../support/invariants';
import {
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  sql,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let merchant: TestMerchant;
const urls = inject('databaseUrls');

beforeAll(async () => {
  ctx = await startPaymentsContext({ DB_POOL_MAX: '10' });
  merchant = await createTestMerchant(ctx, { active: true, label: 'chaos-pg' });
});

afterAll(async () => {
  // A database crash must not leave the application unable to shut down (finding DB-3).
  const outcome = await Promise.race([
    ctx.close().then(() => 'closed'),
    sleep(30_000).then(() => 'HUNG'),
  ]);
  expect(outcome).toBe('closed');
});

/** A live payment in `processing`, with the event that will succeed it. */
async function processingPayment(amountMinor: bigint, key: string) {
  const live = merchant.live;
  if (!live) throw new Error('no live key');
  const created = await createPayment(live, {
    amountMinor: amountMinor.toString(),
    currency: 'UGX',
    paymentMethod: {
      provider: 'mtn',
      msisdn: `+2567${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    },
  });
  // `paymentId` looks in the merchant's test environment; these payments are live.
  const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('live'), created.id);
  if (!detail) throw new Error(`payment ${created.id} not found`);
  const id = detail.payment.id;
  await toProcessing(ctx, id, { identifiers: { provider: 'mtn' } });
  const succeeded = event(
    { kind: 'succeeded', amountMinor, currency: 'UGX' },
    {
      eventKey: key,
      identifiers: { provider: 'mtn', providerTransactionId: `P-${key}`.slice(0, 40) },
    }
  );
  return { id, ref: created.id, succeeded };
}

async function entriesFor(paymentRef: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from core.journal_entries e join core.payments p on p.transaction_id = e.transaction_id
      where p.ref = $1 and e.source = 'payment' and e.reverses_entry_id is null`,
    [paymentRef]
  );
  return Number(rows[0]?.n);
}

describe('B: PostgreSQL is killed while events are being applied', () => {
  it('applies every event exactly once, with nothing lost and nothing doubled, across a SIGKILL and crash recovery', async () => {
    const { postgresId } = chaosContainers();
    const payments = [];
    for (let i = 0; i < 48; i += 1) {
      payments.push(await processingPayment(10_000n + BigInt(i), `chaos-b-${randomUUID()}`));
    }

    let failures = 0;
    const results: string[] = [];
    let applied = 0;
    let killed = false;
    let restartedAfterMs = 0;
    const recover = async () => {
      killContainer(postgresId);
      await sleep(3000);
      startContainer(postgresId);
      restartedAfterMs = await waitForPostgres(urls.superuser);
    };
    let recovery: Promise<void> | undefined;

    await runPool(payments, 8, async (payment) => {
      const outcome = await redeliver(() => applyEvent(ctx, payment.id, payment.succeeded), {
        deadlineMs: 180_000,
        onFailure: () => {
          failures += 1;
        },
      });
      results.push(outcome.result);
      applied += 1;
      if (!killed && applied >= 12) {
        killed = true;
        recovery = recover();
      }
    });
    await recovery;

    // The failure was real: callers saw errors while the database was down.
    expect(failures).toBeGreaterThan(0);
    expect(restartedAfterMs).toBeGreaterThan(0);
    // Every event is acknowledged as applied, or as a duplicate when the commit landed but the
    // answer was lost with the connection; never rejected, never skipped.
    expect(new Set(results)).toEqual(
      new Set(results.filter((r) => r === 'applied' || r === 'duplicate'))
    );
    expect(
      results.filter((r) => r === 'applied').length +
        results.filter((r) => r === 'duplicate').length
    ).toBe(48);

    for (const payment of payments) {
      expect(await entriesFor(payment.ref), payment.ref).toBe(1);
    }
    const statuses = await sql<{ status: string; n: string }>(
      `select t.status, count(*)::text as n from core.payments p join core.transactions t on t.id = p.transaction_id
        where p.ref = any($1) group by t.status`,
      [payments.map((p) => p.ref)]
    );
    expect(statuses).toEqual([{ status: 'succeeded', n: '48' }]);
    // One recorded event per key: the replays did not write a second row.
    const events = await sql<{ keys: string; distinct_keys: string }>(
      `select count(*)::text as keys, count(distinct event_key)::text as distinct_keys from core.transaction_events where event_key = any($1)`,
      [payments.map((p) => p.succeeded.eventKey)]
    );
    expect(events[0]).toEqual({ keys: '48', distinct_keys: '48' });

    expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
    for (const row of await trialBalance(urls.superuser)) expect(row.debits).toBe(row.credits);
  });

  it('serves requests again once the database is back: pools reconnect without a restart', async () => {
    const ready = await ctx.app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    const live = merchant.live;
    if (!live) throw new Error('no live key');
    const created = await createPayment(live, {
      amountMinor: '5000',
      currency: 'UGX',
      paymentMethod: { provider: 'mtn', msisdn: '+256700099001' },
    });
    expect(created.status).toBe('created');
  });

  it('a request that arrives while the database is down fails closed: no payment, no key, a clean retry', async () => {
    const { postgresId } = chaosContainers();
    const live = merchant.live;
    if (!live) throw new Error('no live key');
    const key = `chaos-down-${randomUUID()}`;
    const body = {
      amountMinor: '7000',
      currency: 'UGX',
      paymentMethod: { provider: 'mtn', msisdn: '+256700099002' },
    };
    killContainer(postgresId);
    const during = await live.post('/v1/payments', body, { 'idempotency-key': key });
    expect(during.statusCode).toBeGreaterThanOrEqual(500);
    // The 5xx carries no internal detail (spec 8.1).
    expect(during.body).not.toMatch(/ECONNREFUSED|connection|postgres|terminat/i);
    startContainer(postgresId);
    await waitForPostgres(urls.superuser);
    // Nothing was created under that key, so the same request now creates exactly one payment.
    const keys = await sql<{ n: string }>(
      `select count(*)::text as n from core.idempotency_keys where key = $1`,
      [key]
    );
    expect(keys[0]?.n).toBe('0');
    const retry = await redeliver(
      async () => {
        const res = await live.post('/v1/payments', body, { 'idempotency-key': key });
        if (res.statusCode !== 201) throw new Error(`status ${res.statusCode}`);
        return res;
      },
      { deadlineMs: 60_000, onFailure: () => undefined }
    );
    const replay = await live.post('/v1/payments', body, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(retry.json().data.id);
    const count = await sql<{ n: string }>(
      `select count(*)::text as n from core.payments where idempotency_key = $1`,
      [key]
    );
    expect(count[0]?.n).toBe('1');
  });
});

describe('G: a crash between applying an event and acknowledging it', () => {
  it('a connection killed before COMMIT rolls back everything, and the redelivered event applies once', async () => {
    const payment = await processingPayment(21_000n, `chaos-g1-${randomUUID()}`);
    const units = ctx.unitOfWork;
    let backendPid = 0;
    let appliedInside = false;
    let releaseStall: () => void = () => undefined;
    const stall = new Promise<void>((r) => (releaseStall = r));

    // The event is applied inside the transaction, then the transaction is stalled before COMMIT.
    const stalled = units.run(async (tx) => {
      const result = await ctx.lifecycle.apply(tx, payment.id, payment.succeeded);
      appliedInside = result.result === 'applied';
      const pid = await tx.execute<{ pid: number }>(drizzleSql`select pg_backend_pid() as pid`);
      backendPid = Number(pid.rows[0]?.pid);
      await stall;
    });
    stalled.catch(() => undefined);
    while (backendPid === 0) await sleep(20);
    expect(appliedInside).toBe(true);

    // Not visible to anyone else yet.
    expect(await entriesFor(payment.ref)).toBe(0);
    // The host dies: the backend is terminated with the transaction open.
    await sql(`select pg_terminate_backend($1)`, [backendPid]);
    // The connection is gone; let the callback end so its client is discarded and the pool can close.
    releaseStall();
    await expect(stalled).rejects.toBeDefined();

    // Nothing of the half-applied event survived: no entry, still processing, no event row.
    expect(await entriesFor(payment.ref)).toBe(0);
    const state = await sql<{ status: string }>(
      `select t.status from core.payments p join core.transactions t on t.id = p.transaction_id where p.ref = $1`,
      [payment.ref]
    );
    expect(state[0]?.status).toBe('processing');
    expect(
      await sql(`select 1 from core.transaction_events where event_key = $1`, [
        payment.succeeded.eventKey,
      ])
    ).toHaveLength(0);

    // Redelivery applies it, once.
    const redelivered = await applyEvent(ctx, payment.id, payment.succeeded);
    expect(redelivered.result).toBe('applied');
    expect(await entriesFor(payment.ref)).toBe(1);
    expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
  });

  it('a commit whose acknowledgement is lost is recognised as a duplicate on redelivery', async () => {
    const payment = await processingPayment(22_000n, `chaos-g2-${randomUUID()}`);
    // First delivery commits; the consumer dies before it can record that it did.
    expect((await applyEvent(ctx, payment.id, payment.succeeded)).result).toBe('applied');
    const before = await entriesFor(payment.ref);
    // The same event arrives again, many times, from several consumers at once.
    const replays = await Promise.all(
      Array.from({ length: 12 }, () => applyEvent(ctx, payment.id, payment.succeeded))
    );
    expect(replays.every((r) => r.result === 'duplicate')).toBe(true);
    expect(await entriesFor(payment.ref)).toBe(before);
    expect(before).toBe(1);
    expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
  });
});

describe('E: duplicate gateway events', () => {
  it('twenty simultaneous deliveries of one event post one entry', async () => {
    const payment = await processingPayment(31_000n, `chaos-e1-${randomUUID()}`);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => applyEvent(ctx, payment.id, payment.succeeded))
    );
    expect(outcomes.filter((o) => o.result === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === 'duplicate')).toHaveLength(19);
    expect(await entriesFor(payment.ref)).toBe(1);
  });

  it('a different event for an already-succeeded payment changes nothing and is recorded as rejected', async () => {
    const payment = await processingPayment(32_000n, `chaos-e2-${randomUUID()}`);
    await applyEvent(ctx, payment.id, payment.succeeded);
    const late = await applyEvent(
      ctx,
      payment.id,
      event(
        { kind: 'failed', failureCode: 'late_failure' },
        { eventKey: `chaos-e2-late-${randomUUID()}`, identifiers: { provider: 'mtn' } }
      )
    );
    expect(late.result).toBe('rejected');
    const again = await applyEvent(
      ctx,
      payment.id,
      event(
        { kind: 'processing', outcomeUnknown: true },
        { eventKey: `chaos-e2-old-${randomUUID()}`, identifiers: { provider: 'mtn' } }
      )
    );
    expect(again.result).toBe('rejected');
    expect(await entriesFor(payment.ref)).toBe(1);
    const state = await sql<{ status: string; outcome_unknown: boolean }>(
      `select t.status, t.outcome_unknown from core.payments p join core.transactions t on t.id = p.transaction_id where p.ref = $1`,
      [payment.ref]
    );
    expect(state[0]).toEqual({ status: 'succeeded', outcome_unknown: false });
  });

  it('the same event key with a different amount is refused, not posted twice', async () => {
    const payment = await processingPayment(33_000n, `chaos-e3-${randomUUID()}`);
    await applyEvent(ctx, payment.id, payment.succeeded);
    const tampered = event(
      { kind: 'succeeded', amountMinor: 999_999n, currency: 'UGX' },
      { eventKey: payment.succeeded.eventKey, identifiers: { provider: 'mtn' } }
    );
    const outcome = await applyEvent(ctx, payment.id, tampered);
    expect(['duplicate', 'rejected']).toContain(outcome.result);
    expect(await entriesFor(payment.ref)).toBe(1);
    const lines = await sql<{ amount: string }>(
      `select l.amount_minor::text as amount from core.journal_lines l join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
        join core.payments p on p.transaction_id = e.transaction_id where p.ref = $1 and l.direction = 'debit' order by l.line_no limit 1`,
      [payment.ref]
    );
    expect(lines[0]?.amount).toBe('33000');
  });

  it('events for different payments delivered in a shuffled, duplicated order all converge', async () => {
    const batch = [];
    for (let i = 0; i < 16; i += 1)
      batch.push(await processingPayment(40_000n + BigInt(i), `chaos-e4-${randomUUID()}`));
    const deliveries = [...batch, ...batch, ...batch].sort(() => Math.random() - 0.5);
    await runPool(deliveries, 8, async (payment) => {
      await applyEvent(ctx, payment.id, payment.succeeded);
    });
    for (const payment of batch) expect(await entriesFor(payment.ref), payment.ref).toBe(1);
    expect(await checkFinancialInvariants(urls.superuser)).toEqual([]);
  });
});
