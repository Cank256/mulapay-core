/**
 * A database connection that dies while a request is using it must fail that request, not the
 * process. `bootstrap/process.ts` turns an uncaught exception into `process.exit(1)` (a financial
 * process does not keep running in an unknown state), so an `error` event with no listener on a
 * checked-out client would crash every API and worker pod at once on a failover.
 *
 * pg-pool removes its own error listener while a client is checked out, so the pools must keep one
 * of their own (`src/common/db/pools.ts`). Found by the chaos suite (docs/PRODUCTION_READINESS.md,
 * finding DB-2).
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createDatabasePools,
  closeDatabasePools,
  type DatabasePools,
} from '../../src/common/db/pools';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import * as schema from '../../src/db/schema';
import { testConfig } from '../support/test-env';

const urls = inject('databaseUrls');

describe('a connection that dies while in use', () => {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => uncaught.push(error);
  let pools: DatabasePools;
  let admin: Client;

  beforeEach(async () => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    const config = testConfig({ DB_POOL_MAX: '4' });
    pools = createDatabasePools(config, pino({ level: 'silent' }));
    admin = new Client({ connectionString: urls.superuser });
    await admin.connect();
  });

  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    await admin.end();
    await closeDatabasePools(pools);
  });

  it('rejects the query it was running and raises no uncaught exception', async () => {
    const client = await pools.rw.connect();
    try {
      await client.query('begin');
      const pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0]?.pid);
      // The backend is killed while the transaction is open: what a failover or a crash does.
      const pending = client.query('select pg_sleep(30)').catch((error: Error) => error);
      await admin.query('select pg_terminate_backend($1)', [pid]);
      const result = await pending;
      expect(result).toBeInstanceOf(Error);
    } finally {
      client.release(true);
    }
    // The error event is emitted on a later tick.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(uncaught).toEqual([]);
  });

  it('keeps serving: the dead client is discarded and the next checkout works', async () => {
    const client = await pools.rw.connect();
    const pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0]?.pid);
    await admin.query('select pg_terminate_backend($1)', [pid]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.release(true);
    const next = await pools.rw.query('select 1 as ok');
    expect(next.rows[0]?.ok).toBe(1);
    expect(uncaught).toEqual([]);
  });

  it('shuts down promptly after connections were killed', async () => {
    const clients = await Promise.all([pools.rw.connect(), pools.rw.connect(), pools.rw.connect()]);
    const pids = await Promise.all(
      clients.map(async (c) =>
        Number((await c.query('select pg_backend_pid() as pid')).rows[0]?.pid)
      )
    );
    for (const pid of pids) await admin.query('select pg_terminate_backend($1)', [pid]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const client of clients) client.release(true);
    const started = Date.now();
    await closeDatabasePools(pools);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(uncaught).toEqual([]);
    // `afterEach` closes again: ending an ended pool must not throw.
    pools = createDatabasePools(testConfig({ DB_POOL_MAX: '2' }), pino({ level: 'silent' }));
  });
});

describe('a database that stops answering without closing the connection', () => {
  /**
   * A TCP proxy in front of Postgres that can go silent: it keeps the socket open and forwards
   * nothing, which is what a network partition or a vanished host looks like. The server's own
   * `statement_timeout` cannot help (the server never sees the query), so only a client-side limit
   * can free the connection and the request that is waiting on it.
   */
  async function silentProxy(): Promise<{
    url: string;
    silence: () => void;
    close: () => Promise<void>;
  }> {
    const { createServer, connect } = await import('node:net');
    const target = new URL(urls.rw);
    let silent = false;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((client) => {
      const upstream = connect(Number(target.port), target.hostname);
      sockets.add(client);
      sockets.add(upstream);
      client.on('data', (chunk) => {
        if (!silent) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!silent) client.write(chunk);
      });
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const proxied = new URL(urls.rw);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(port);
    return {
      url: proxied.toString(),
      silence: () => {
        silent = true;
      },
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('fails the waiting query within the client-side limit, and the pool can close', async () => {
    const proxy = await silentProxy();
    const config = testConfig({
      DB_POOL_MAX: '2',
      DATABASE_URL: proxy.url,
      DB_STATEMENT_TIMEOUT_MS: '2000',
    });
    const local = createDatabasePools(config, pino({ level: 'silent' }));
    try {
      expect((await local.rw.query('select 1 as ok')).rows[0]?.ok).toBe(1);
      proxy.silence();
      const started = Date.now();
      const outcome = await Promise.race([
        local.rw.query('select 2 as ok').then(
          () => 'answered',
          (error: Error) => error.message
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('WAITING FOREVER'), 20_000)),
      ]);
      expect(outcome).not.toBe('WAITING FOREVER');
      expect(outcome).toMatch(/timeout/i);
      // Bounded by the statement timeout plus a small margin, not by the operating system.
      expect(Date.now() - started).toBeLessThan(8000);
      const closing = Date.now();
      await closeDatabasePools(local);
      expect(Date.now() - closing).toBeLessThan(5000);
    } finally {
      await proxy.close();
    }
  }, 60_000);
});

describe('UnitOfWork releases its connection when BEGIN itself fails (finding DB-4)', () => {
  /**
   * drizzle-orm 0.45.4 issues `begin` before its try/finally, so a client that looked healthy at
   * checkout and failed on its first statement was never released: one pool slot lost per such
   * failure, and `pool.end()` waiting for it forever. A half-open socket looks exactly like that
   * (a database host killed without closing its connections). Found as a hang in `app.close()`
   * after a SIGKILL of Postgres (test/chaos/postgres.chaos-spec.ts).
   *
   * Here the connection is reset by the peer between checkout and `begin`.
   */
  it('returns the client to the pool, so the pool does not shrink and can close', async () => {
    const { createServer, connect } = await import('node:net');
    const target = new URL(urls.rw);
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((client) => {
      const upstream = connect(Number(target.port), target.hostname);
      sockets.add(client);
      sockets.add(upstream);
      client.on('data', (chunk) => upstream.write(chunk));
      upstream.on('data', (chunk) => client.write(chunk));
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const proxied = new URL(urls.rw);
    proxied.hostname = '127.0.0.1';
    proxied.port = String((server.address() as import('node:net').AddressInfo).port);
    const config = testConfig({ DB_POOL_MAX: '2', DATABASE_URL: proxied.toString() });
    const pools = createDatabasePools(config, pino({ level: 'silent' }));
    try {
      const unit = new UnitOfWork(drizzle({ client: pools.rw, schema }), config);
      await unit.run((tx) => tx.execute(sql`select 1`));
      // The idle client is now connected through the proxy. Reset the proxied sockets without the
      // pool seeing a FIN first: write to a destroyed stream on the next statement.
      for (const socket of sockets) socket.resetAndDestroy?.();
      // Immediately: the pool has not yet noticed, so it hands out the dead client.
      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () => unit.run((tx) => tx.execute(sql`select 1`)))
      );
      expect(attempts.some((a) => a.status === 'rejected')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pools.rw.totalCount - pools.rw.idleCount, 'clients still checked out').toBe(0);
      const started = Date.now();
      await closeDatabasePools(pools);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
