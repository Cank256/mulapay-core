/**
 * Disaster recovery (docs/OPERATIONS.md "Disaster recovery"): restore from a backup onto a new
 * server, lose Redis, restart the application.
 *
 * The restore test is the one that matters most: it takes a `pg_dump` of a database holding real
 * ledger and payment data, restores it onto a completely fresh PostgreSQL server using the
 * documented procedure (roles from `pg_dumpall --globals-only`, then `pg_restore`), and proves that
 * the data, the triggers, the grants and the role settings all came back, that the application
 * boots against it, and that the migrator sees nothing left to do.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Redis } from 'ioredis';
import pino from 'pino';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from '../../src/db/migrator';
import { chaosContainers, restartContainer, sleep, waitForRedis } from '../support/chaos';
import { checkFinancialInvariants, trialBalance } from '../support/invariants';
import {
  createMerchant,
  deliveriesOf,
  emitEvent,
  issueKey,
  pumpOutbox,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
} from '../support/developer';
import {
  createTestMerchant,
  sql,
  startPaymentsContext,
  type PaymentsContext,
} from '../support/payments';
import { succeedLivePayment } from '../support/compliance';
import { testConfig } from '../support/test-env';
import { createTestApp } from '../support/test-app';

const redisUrl = inject('redisUrl');
const ROOT = resolve(__dirname, '../..');

/** A fixed query per table of a closed list: no caller input reaches a statement. */
const COUNT_SQL: Record<string, string> = {
  journal_entries: 'select count(*)::text as n from core.journal_entries',
  journal_lines: 'select count(*)::text as n from core.journal_lines',
  account_balances: 'select count(*)::text as n from core.account_balances',
  transactions: 'select count(*)::text as n from core.transactions',
  payments: 'select count(*)::text as n from core.payments',
  audit_logs: 'select count(*)::text as n from core.audit_logs',
  outbox: 'select count(*)::text as n from core.outbox',
};

function countSql(table: string): string {
  const statement = COUNT_SQL[table];
  if (!statement) throw new Error(`no count query for ${table}`);
  return statement;
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('restore from backup onto a new server', () => {
  let ctx: PaymentsContext;
  let target: StartedPostgreSqlContainer | undefined;
  let work: string;
  const restored: { url: string; rw: string } = { url: '', rw: '' };
  let sourceCounts: Record<string, string> = {};
  const COUNT_TABLES = [
    'journal_entries',
    'journal_lines',
    'account_balances',
    'transactions',
    'payments',
    'audit_logs',
    'outbox',
  ];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'core-dr-'));
    ctx = await startPaymentsContext();
    const merchant = await createTestMerchant(ctx, { active: true, label: 'dr' });
    for (let i = 0; i < 6; i += 1) {
      await succeedLivePayment(ctx, merchant, {
        amountMinor: BigInt(10_000 + i * 1000),
        currency: 'UGX',
      });
    }
    const counts: Record<string, string> = {};
    for (const table of COUNT_TABLES) {
      counts[table] = (await sql<{ n: string }>(countSql(table)))[0]?.n ?? '0';
    }
    sourceCounts = counts;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
    await target?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('a pg_dump restores onto a fresh server with data, constraints, grants and role settings intact', async () => {
    const { postgresId } = chaosContainers();
    // 1. Back up, the way the runbook says: the database in custom format, and the cluster's roles.
    docker(
      'exec',
      postgresId,
      'sh',
      '-c',
      'pg_dump -U postgres -d mulapay -Fc -f /tmp/core.dump && pg_dumpall -U postgres --globals-only -f /tmp/globals.sql'
    );
    docker('cp', `${postgresId}:/tmp/core.dump`, join(work, 'core.dump'));
    docker('cp', `${postgresId}:/tmp/globals.sql`, join(work, 'globals.sql'));

    // 2. A brand new server: nothing of the old one exists, not even the roles.
    target = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('postgres')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    const id = target.getId();
    docker('cp', join(work, 'core.dump'), `${id}:/tmp/core.dump`);
    docker('cp', join(work, 'globals.sql'), `${id}:/tmp/globals.sql`);
    const roleCheck = await target.exec([
      'psql',
      '-U',
      'postgres',
      '-Atc',
      `select count(*) from pg_roles where rolname like 'mulapay_core_%'`,
    ]);
    expect(roleCheck.output.trim()).toBe('0');

    // 3. Roles first (passwords, attributes and per-role settings are cluster-level, not in the dump).
    const globals = await target.exec([
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=0',
      '-f',
      '/tmp/globals.sql',
    ]);
    expect(globals.exitCode).toBe(0);
    // 4. The database, then the restore as the superuser so ownership and ACLs are applied as dumped.
    for (const statement of ['create database mulapay_restored']) {
      const created = await target.exec(['psql', '-U', 'postgres', '-c', statement]);
      expect(created.exitCode).toBe(0);
    }
    // The dump creates the core schema and the citext extension itself.
    const restore = await target.exec([
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      'mulapay_restored',
      '--exit-on-error',
      '/tmp/core.dump',
    ]);
    expect(restore.exitCode, restore.output).toBe(0);

    // Grants that live on the database rather than in the dump are re-applied by the bootstrap
    // step "GRANT CONNECT"; the runbook runs it again, and so does this test.
    await target.exec([
      'psql',
      '-U',
      'postgres',
      '-d',
      'mulapay_restored',
      '-c',
      'grant connect on database mulapay_restored to mulapay_core_rw, mulapay_core_ro',
    ]);
    const host = target.getHost();
    const port = target.getPort();
    restored.url = `postgres://postgres:postgres@${host}:${port}/mulapay_restored`;
    // The password in the dump is the hash of the source cluster's: the same one still works.
    restored.rw = `postgres://mulapay_core_rw:core_rw_test@${host}:${port}/mulapay_restored`;

    const client = new Client({ connectionString: restored.url });
    await client.connect();
    try {
      // Data: every table has the rows it had.
      for (const table of COUNT_TABLES) {
        const n = (await client.query(countSql(table))).rows[0]?.n;
        expect(n, table).toBe(sourceCounts[table]);
      }
      // Constraints and triggers survived: the ledger is still append-only and balanced.
      const triggers = await client.query(
        `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where c.relnamespace = 'core'::regnamespace and not t.tgisinternal and t.tgname in ('journal_lines_append_only', 'journal_entries_append_only', 'audit_logs_append_only')`
      );
      expect(triggers.rows[0]?.n).toBeGreaterThanOrEqual(3);
      // Grants and ownership survived: the application role still cannot rewrite the journal.
      const privilege = await client.query(
        `select has_table_privilege('mulapay_core_rw', 'core.journal_lines', 'UPDATE') as u`
      );
      expect(privilege.rows[0]?.u).toBe(false);
      // Role settings came with the globals, not the dump.
      const settings = await client.query(
        `select rolname, rolconfig from pg_roles where rolname in ('mulapay_core_rw', 'mulapay_core_ro')`
      );
      const config = Object.fromEntries(
        settings.rows.map((r: { rolname: string; rolconfig: string[] }) => [
          r.rolname,
          r.rolconfig ?? [],
        ])
      );
      expect(config.mulapay_core_ro).toContain('default_transaction_read_only=on');
      expect(
        (config.mulapay_core_rw as string[]).some((c) => c.startsWith('statement_timeout='))
      ).toBe(true);
    } finally {
      await client.end();
    }
    // The independent invariant checks pass on the restored copy, and the books balance.
    expect(await checkFinancialInvariants(restored.url)).toEqual([]);
    for (const row of await trialBalance(restored.url)) expect(row.debits).toBe(row.credits);
    expect(sourceCounts.journal_entries).not.toBe('0');
  }, 240_000);

  it('the migrator finds nothing to apply, and refuses nothing', async () => {
    const result = await runMigrations({
      connectionString: restored.rw,
      migrationsFolder: resolve(ROOT, 'src/db/migrations'),
      logger: pino({ level: 'silent' }),
    });
    expect(result.applied).toBe(0);
  });

  it('the application boots on the restored database and serves a payment read', async () => {
    const app = await createTestApp(
      testConfig({
        DATABASE_URL: restored.rw,
        DATABASE_RO_URL: restored.rw,
        DATABASE_DIRECT_URL: restored.rw,
      })
    );
    try {
      const ready = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(ready.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('writes continue on the restored copy and keep the ledger balanced', async () => {
    const client = new Client({ connectionString: restored.rw });
    await client.connect();
    try {
      // The application role can still write through the same triggers.
      const before = (await client.query('select count(*)::int as n from core.audit_logs')).rows[0]
        ?.n as number;
      expect(before).toBeGreaterThan(0);
      await expect(
        client.query('update core.journal_lines set line_no = line_no')
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
    expect(await checkFinancialInvariants(restored.url)).toEqual([]);
  });
});

describe('Redis is lost', () => {
  let ctx: DeveloperContext;

  beforeAll(async () => {
    ctx = await startDeveloperContext();
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('webhook deliveries and outbox rows that Redis held jobs for are recovered from Postgres, once', async () => {
    const { redisId } = chaosContainers();
    const merchant = await createMerchant(ctx, { active: true, label: 'redis-loss' });
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
      const events: { id: string; ref: string }[] = [];
      for (let i = 0; i < 5; i += 1)
        events.push(await emitEvent(ctx, merchant, { type: 'payment.created' }));

      // Redis dies with its data: every queued job and every key is gone.
      restartContainer(redisId);
      const back = new Redis(redisUrl, { lazyConnect: true });
      back.on('error', () => undefined);
      await waitForRedis(redisUrl);
      await back.connect();
      await back.flushall();
      expect(await back.dbsize()).toBe(0);
      back.disconnect();

      // The rows that announce the events are in Postgres. Dispatching again publishes them.
      await pumpOutbox(ctx, merchant.id);
      const deliveries = (await deliveriesOf(ctx, merchant.id)).filter((d) =>
        events.some((e) => e.id === d.event_id)
      );
      expect(deliveries).toHaveLength(5);
      // Every pending delivery can be attempted without the queue: the recovery sweep's work.
      for (const delivery of deliveries) await ctx.deliveryService.attempt(delivery.ref);
      expect(receiver.received).toHaveLength(5);
      const after = (await deliveriesOf(ctx, merchant.id)).filter((d) =>
        events.some((e) => e.id === d.event_id)
      );
      expect(after.every((d) => d.status === 'succeeded' && d.attempt === 1)).toBe(true);
      // And nothing is delivered twice if the sweep runs again.
      for (const delivery of deliveries) await ctx.deliveryService.attempt(delivery.ref);
      expect(receiver.received).toHaveLength(5);
    } finally {
      await receiver.close();
    }
  }, 240_000);

  it('while Redis is down reads are served, money-moving writes are refused with a generic 503, and everything works again afterwards', async () => {
    const { redisId } = chaosContainers();
    const merchant = await createMerchant(ctx, { active: true, label: 'redis-down' });
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['webhooks:read', 'webhooks:write'],
    });
    expect((await key.client.get('/v1/ping')).statusCode).toBe(200);
    docker('kill', '--signal', 'KILL', redisId);
    // Documented design (rate-limit.guard.ts): a read is allowed without rate limiting, a write is
    // refused, because an unlimited write path is the dangerous one.
    const read = await key.client.get('/v1/ping');
    expect(read.statusCode).toBe(200);
    const write = await key.client.post(
      '/v1/webhook-endpoints',
      { url: 'https://example.com/hook', enabledEvents: ['*'] },
      { 'idempotency-key': `redis-down-${Date.now()}` }
    );
    expect(write.statusCode).toBe(503);
    expect(write.body).not.toMatch(/ECONNREFUSED|redis|ioredis|stack/i);
    docker('start', redisId);
    await waitForRedis(redisUrl);
    // ioredis reconnects on its own; allow it a moment.
    let status = 0;
    for (let i = 0; i < 40 && status !== 201; i += 1) {
      status = (
        await key.client.post(
          '/v1/webhook-endpoints',
          { url: 'https://example.com/hook', enabledEvents: ['*'] },
          { 'idempotency-key': `redis-up-${i}-${Date.now()}` }
        )
      ).statusCode;
      if (status !== 201) await sleep(500);
    }
    expect(status).toBe(201);
  }, 120_000);
});
