/**
 * Phase 9: partition automation and retention (spec 5.1 and 11), against real Postgres.
 *
 * Runs on its own database (`mulapay_lifecycle`): it creates and drops partitions.
 *
 * What is proven here:
 *  - partitions for the next three months exist for every partitioned table, with exact UTC
 *    boundaries, the policy's revokes and the parent's append-only triggers;
 *  - rows route to the right partition and a range query reads only that partition;
 *  - a row already in a default partition blocks its month, is never moved, and fails the run
 *    after the other months are created;
 *  - retention drops only partitions entirely past their window (checked at the exact boundary),
 *    keeps pending webhook deliveries, audits every drop, and is idempotent and concurrency safe;
 *  - financial tables and the audit log cannot be given a retention period, and the drop function
 *    refuses them even when called directly;
 *  - idempotency keys and published outbox rows are purged in batches, unpublished outbox rows
 *    and rows inside the grace window are not.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/common/ids/ids';
import {
  LifecycleService,
  PartitionMaintenanceError,
} from '../../src/modules/lifecycle/lifecycle.service';
import { FixedClock } from '../support/fixed-clock';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';

const PARENTS = [
  'audit_logs',
  'journal_entries',
  'journal_lines',
  'transactions',
  'webhook_deliveries',
  'api_request_logs',
  'notification_deliveries',
] as const;

const urls = inject('lifecycleDatabaseUrls');
const clock = new FixedClock('2031-06-15T10:00:00.000Z');
let app: NestFastifyApplication;
let lifecycle: LifecycleService;
let admin: Client;
let rw: Client;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await admin.query(text, values)).rows as T[];
}

/** Superuser writes that skip FK checks and the immutability triggers: test data only. */
async function seed(statements: string[]): Promise<void> {
  await admin.query('begin');
  try {
    await admin.query('set local session_replication_role = replica');
    for (const statement of statements) await admin.query(statement);
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

async function exists(name: string): Promise<boolean> {
  return (
    (await q<{ r: string | null }>('select to_regclass($1)::text as r', [`core.${name}`]))[0]?.r !==
    null
  );
}

async function sqlState(client: Client, statement: string): Promise<string | undefined> {
  try {
    await client.query(statement);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function requestLogRow(createdAt: string): string {
  return `insert into core.api_request_logs (id, ref, merchant_id, environment, api_key_id, method, path, route, status_code, latency_ms, request_id, created_at)
          values ('${randomUUID()}', 'arl_${randomUUID()}', '${randomUUID()}', 'live', '${randomUUID()}', 'GET', '/v1/ping', '/v1/ping', 200, 1, 'req-${randomUUID()}', '${createdAt}')`;
}

function deliveryRow(createdAt: string, status: 'pending' | 'succeeded'): string {
  const next = status === 'pending' ? `'${createdAt}'` : 'null';
  return `insert into core.webhook_deliveries (id, ref, endpoint_id, merchant_id, environment, event_id, event_type, dedupe_key, attempt, status, next_attempt_at, created_at)
          values ('${randomUUID()}', 'whd_${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 'live', '${randomUUID()}', 'payment.succeeded', 'dk-${randomUUID()}', 0, '${status}', ${next}, '${createdAt}')`;
}

beforeAll(async () => {
  admin = new Client({ connectionString: urls.superuser });
  rw = new Client({ connectionString: urls.rw });
  await Promise.all([admin.connect(), rw.connect()]);
  app = await createTestApp(
    testConfig({
      DATABASE_URL: urls.rw,
      DATABASE_RO_URL: urls.ro,
      DATABASE_DIRECT_URL: urls.rw,
      REDIS_URL: `${inject('redisUrl').replace(/\/\d*$/, '')}/3`,
      QUEUE_PREFIX: `lc-${randomUUID().slice(0, 8)}`,
    }),
    { clock }
  );
  lifecycle = app.get(LifecycleService, { strict: false });
});

afterAll(async () => {
  await app?.close();
  await Promise.all([admin?.end(), rw?.end()]);
});

describe('partition creation', () => {
  it('creates the current month and three ahead for every partitioned table', async () => {
    const result = await lifecycle.ensurePartitions();
    expect(result.problems).toEqual([]);
    // 7 tables x 4 months; none existed for 2031.
    expect(result.created).toHaveLength(PARENTS.length * 4);
    for (const parent of PARENTS) {
      for (const month of ['203106', '203107', '203108', '203109']) {
        expect(await exists(`${parent}_${month}`), `${parent}_${month}`).toBe(true);
      }
      expect(await exists(`${parent}_203110`), `${parent}_203110 must not exist yet`).toBe(false);
    }
  });

  it('uses exact UTC month boundaries', async () => {
    const rows = await q<{ name: string; bound: string; upper: string }>(
      `select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound,
              core.partition_upper_bound(c.oid)::text as upper
         from pg_class c join pg_inherits i on i.inhrelid = c.oid
        where i.inhparent = 'core.journal_lines'::regclass and c.relname ~ '_2031(06|09)$'
        order by c.relname`
    );
    expect(rows.map((r) => r.name)).toEqual(['journal_lines_203106', 'journal_lines_203109']);
    expect(rows[0]?.bound).toMatch(
      /FROM \('2031-06-01 00:00:00\+00'\) TO \('2031-07-01 00:00:00\+00'\)/
    );
    expect(rows[1]?.bound).toMatch(
      /FROM \('2031-09-01 00:00:00\+00'\) TO \('2031-10-01 00:00:00\+00'\)/
    );
    expect(new Date(rows[1]?.upper ?? '').toISOString()).toBe('2031-10-01T00:00:00.000Z');
  });

  it('applies the policy revokes to every new partition and clones the append-only triggers', async () => {
    for (const parent of PARENTS) {
      const policy = (
        await q<{ revoked_privileges: string }>(
          'select revoked_privileges from core.partition_policies where parent = $1',
          [parent]
        )
      )[0];
      const revoked = (policy?.revoked_privileges ?? '').split(', ');
      for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const allowed = (
          await q<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [
            'mulapay_core_rw',
            `core.${parent}_203107`,
            privilege,
          ])
        )[0]?.ok;
        expect(allowed, `${parent}_203107 ${privilege}`).toBe(!revoked.includes(privilege));
      }
    }
    // Row-level append-only triggers on the parent are cloned to a partition created later.
    const triggers = await q<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'core.journal_lines_203108'::regclass and not tgisinternal`
    );
    expect(triggers.map((t) => t.tgname)).toContain('journal_lines_append_only');
    // And the privilege checks hold against the partition addressed directly.
    expect(await sqlState(rw, 'update core.journal_lines_203108 set line_no = line_no')).toBe(
      '42501'
    );
    expect(await sqlState(rw, 'truncate core.audit_logs_203108')).toBe('42501');
    expect(await sqlState(rw, 'delete from core.transactions_203108')).toBe('42501');
  });

  it('is idempotent', async () => {
    const before = await q<{ n: string }>(
      `select count(*)::text as n from pg_inherits i join pg_class c on c.oid = i.inhparent where c.relnamespace = 'core'::regnamespace`
    );
    const again = await lifecycle.ensurePartitions();
    expect(again.created).toEqual([]);
    const after = await q<{ n: string }>(
      `select count(*)::text as n from pg_inherits i join pg_class c on c.oid = i.inhparent where c.relnamespace = 'core'::regnamespace`
    );
    expect(after).toEqual(before);
  });

  it('reports three months ahead and a clean default partition', async () => {
    const status = await q<{ parent: string; months_ahead: number; default_has_rows: boolean }>(
      `select parent, months_ahead, default_has_rows from core.partition_status($1::timestamptz)`,
      [clock.now()]
    );
    expect(status).toHaveLength(PARENTS.length);
    for (const row of status) {
      expect(row.months_ahead, row.parent).toBe(3);
      expect(row.default_has_rows, row.parent).toBe(false);
    }
  });
});

describe('query routing', () => {
  it('routes rows to their month and prunes a range query to one partition', async () => {
    await seed([requestLogRow('2031-07-10T12:00:00Z'), requestLogRow('2031-08-02T00:00:00Z')]);
    const routed = await q<{ part: string }>(
      `select tableoid::regclass::text as part from core.api_request_logs
        where created_at >= '2031-07-01' and created_at < '2031-08-01'`
    );
    expect(routed).toEqual([{ part: 'core.api_request_logs_203107' }]);
    const plan = (
      await q<Record<string, string>>(
        `explain select * from core.api_request_logs where created_at >= '2031-07-01' and created_at < '2031-08-01'`
      )
    )
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('api_request_logs_203107');
    expect(plan).not.toContain('api_request_logs_203108');
    expect(plan).not.toContain('api_request_logs_default');
  });
});

describe('default partition guard', () => {
  it('blocks a month with rows in the default partition, moves nothing, and still creates the rest', async () => {
    await seed([requestLogRow('2035-03-10T00:00:00Z')]);
    clock.set('2035-02-20T00:00:00.000Z');
    await expect(lifecycle.ensurePartitions()).rejects.toBeInstanceOf(PartitionMaintenanceError);

    expect(await exists('api_request_logs_203502')).toBe(true);
    expect(await exists('api_request_logs_203503')).toBe(false);
    expect(await exists('api_request_logs_203504')).toBe(true);
    // Every other table got all four months: one table's problem stops nothing else.
    expect(await exists('journal_lines_203505')).toBe(true);
    // The row is where it was written.
    expect(
      await q('select 1 from core.api_request_logs_default where created_at = $1', [
        '2035-03-10T00:00:00Z',
      ])
    ).toHaveLength(1);
    const status = await q<{ default_has_rows: boolean }>(
      `select default_has_rows from core.partition_status($1::timestamptz) where parent = 'api_request_logs'`,
      [clock.now()]
    );
    expect(status[0]?.default_has_rows).toBe(true);

    await seed(['delete from core.api_request_logs_default']);
    clock.set('2031-06-15T10:00:00.000Z');
  });
});

describe('retention of partitioned tables', () => {
  it('drops the partitions the migration created once they are past their window', async () => {
    // The database was migrated in 2026; at the fixed 2031 clock those months are long expired.
    const run = await lifecycle.enforceRetention();
    expect(run.droppedPartitions).toContain('api_request_logs_202611');
    expect(run.droppedPartitions).toContain('webhook_deliveries_202611');
    expect(run.droppedPartitions).toContain('notification_deliveries_202611');
    expect(run.droppedPartitions.some((p) => /^(journal|transactions|audit)/.test(p))).toBe(false);
    expect(await exists('journal_lines_202611')).toBe(true);
    expect(await exists('audit_logs_202611')).toBe(true);
  });

  it('drops partitions entirely past 90 days, exactly at the boundary, and keeps the rest', async () => {
    await rw.query(
      `select core.create_monthly_partitions('api_request_logs', '2031-01-01', 3, true)`
    );
    await seed([
      requestLogRow('2031-01-15T00:00:00Z'),
      requestLogRow('2031-02-27T23:59:59Z'),
      requestLogRow('2031-03-05T00:00:00Z'),
    ]);

    // Partition 2031-02 ends 2031-03-01T00:00Z; 90 days later is 2031-05-30T00:00Z.
    clock.set('2031-05-29T23:59:59.999Z');
    const early = await lifecycle.enforceRetention();
    expect(early.droppedPartitions).toEqual(['api_request_logs_203101']);
    expect(await exists('api_request_logs_203102')).toBe(true);

    clock.set('2031-05-30T00:00:00.000Z');
    const onTheLine = await lifecycle.enforceRetention();
    expect(onTheLine.droppedPartitions).toEqual(['api_request_logs_203102']);
    expect(await exists('api_request_logs_203103')).toBe(true);
    expect(
      await q('select 1 from core.api_request_logs where created_at = $1', ['2031-03-05T00:00:00Z'])
    ).toHaveLength(1);

    // Second run: nothing left to do.
    const again = await lifecycle.enforceRetention();
    expect(again.droppedPartitions).toEqual([]);

    const audit = await q<{ resource_id: string; actor_type: string; before: { table: string } }>(
      `select resource_id, actor_type, "before" from core.audit_logs
        where action = 'retention.partition_dropped' and resource_id ~ '_2031' order by seq`
    );
    expect(audit.map((a) => a.resource_id)).toEqual([
      'api_request_logs_203101',
      'api_request_logs_203102',
    ]);
    expect(
      audit.every((a) => a.actor_type === 'job' && a.before.table === 'api_request_logs')
    ).toBe(true);
    clock.set('2031-06-15T10:00:00.000Z');
  });

  it('keeps a partition that still has a pending webhook delivery, and drops it once resolved', async () => {
    await rw.query(
      `select core.create_monthly_partitions('webhook_deliveries', '2030-01-01', 1, false)`
    );
    await seed([deliveryRow('2030-01-10T00:00:00Z', 'pending')]);
    const kept = await lifecycle.enforceRetention();
    expect(kept.droppedPartitions).not.toContain('webhook_deliveries_203001');
    expect(kept.keptPartitions).toContainEqual({
      partition: 'webhook_deliveries_203001',
      reason: 'pending_deliveries',
    });
    expect(await exists('webhook_deliveries_203001')).toBe(true);

    await seed([
      `update core.webhook_deliveries set status = 'succeeded', next_attempt_at = null where created_at = '2030-01-10T00:00:00Z'`,
    ]);
    const dropped = await lifecycle.enforceRetention();
    expect(dropped.droppedPartitions).toContain('webhook_deliveries_203001');
  });

  it('applies 180 days to notification deliveries', async () => {
    await rw.query(
      `select core.create_monthly_partitions('notification_deliveries', '2030-11-01', 1, false)`
    );
    // 2030-11 ends 2030-12-01; +179 days is still inside the window at the fixed clock below.
    clock.set('2031-05-29T00:00:00.000Z');
    expect((await lifecycle.enforceRetention()).droppedPartitions).not.toContain(
      'notification_deliveries_203011'
    );
    clock.set('2031-05-30T00:00:00.000Z');
    expect((await lifecycle.enforceRetention()).droppedPartitions).toContain(
      'notification_deliveries_203011'
    );
    clock.set('2031-06-15T10:00:00.000Z');
  });

  it('never drops financial or audit partitions, however old, and the database refuses a policy that would', async () => {
    // A partition inside its window is refused by the function itself.
    await expect(
      rw.query('select core.drop_partition($1, $2, $3)', [
        'api_request_logs',
        'api_request_logs_203108',
        '2031-06-15T00:00:00Z',
      ])
    ).rejects.toMatchObject({ code: '23514' });
    for (const parent of ['journal_lines', 'journal_entries', 'transactions', 'audit_logs']) {
      await rw.query('select core.create_monthly_partitions($1, $2, 1, true)', [
        parent,
        '2001-01-01',
      ]);
    }
    clock.set('2040-01-01T00:00:00.000Z');
    const run = await lifecycle.enforceRetention();
    expect(run.droppedPartitions.filter((p) => /^(journal|transactions|audit)/.test(p))).toEqual(
      []
    );
    for (const parent of ['journal_lines', 'journal_entries', 'transactions', 'audit_logs']) {
      expect(await exists(`${parent}_200101`), parent).toBe(true);
    }
    clock.set('2031-06-15T10:00:00.000Z');

    // The function itself is a second door, and it is closed for these tables.
    for (const [parent, partition] of [
      ['journal_lines', 'journal_lines_200101'],
      ['audit_logs', 'audit_logs_200101'],
      ['transactions', 'transactions_200101'],
    ] as const) {
      await expect(
        rw.query('select core.drop_partition($1, $2, $3)', [
          parent,
          partition,
          '2099-01-01T00:00:00Z',
        ])
      ).rejects.toMatchObject({ code: '42501' });
    }
    // The default partition, a stranger table and a partition inside its window are refused too.
    await expect(
      rw.query('select core.drop_partition($1, $2, $3)', [
        'api_request_logs',
        'api_request_logs_default',
        '2099-01-01T00:00:00Z',
      ])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      rw.query('select core.drop_partition($1, $2, $3)', [
        'api_request_logs',
        'journal_lines_200101',
        '2099-01-01T00:00:00Z',
      ])
    ).rejects.toMatchObject({ code: '42P01' });

    // A retention period on a protected table cannot even be stored.
    await expect(
      admin.query(
        `update core.partition_policies set retention_days = 90 where parent = 'journal_lines'`
      )
    ).rejects.toMatchObject({ code: '42501' }); // append-only trigger
    await expect(
      admin.query(`insert into core.partition_policies values ('ledger_x', 'DELETE', 90)`)
    ).rejects.toMatchObject({ code: '23514' });
    // The application role cannot edit policies at all.
    expect(
      await sqlState(
        rw,
        `update core.partition_policies set retention_days = 30 where parent = 'api_request_logs'`
      )
    ).toBe('42501');
    expect(
      await sqlState(rw, `delete from core.partition_policies where parent = 'audit_logs'`)
    ).toBe('42501');
  });

  it('survives two retention runs at once', async () => {
    await rw.query(
      `select core.create_monthly_partitions('api_request_logs', '2029-01-01', 2, true)`
    );
    const results = await Promise.allSettled([
      lifecycle.enforceRetention(),
      lifecycle.enforceRetention(),
    ]);
    // One may find the partition already gone or wait on its lock; neither may leave it behind or
    // corrupt the other: at most a clean failure that the retry would absorb.
    const dropped = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value.droppedPartitions : []
    );
    expect(dropped.filter((p) => p === 'api_request_logs_202901')).toHaveLength(1);
    expect(await exists('api_request_logs_202901')).toBe(false);
    expect(await exists('api_request_logs_202902')).toBe(false);
  });
});

describe('batched clean-ups', () => {
  const now = new Date('2031-06-15T10:00:00.000Z');
  const day = 86_400_000;

  function idempotencyRow(
    expiresAt: Date,
    status: 'completed' | 'in_flight' = 'completed'
  ): string {
    const response = status === 'completed' ? `, 200, '{}'::jsonb` : ', null, null';
    return `insert into core.idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, response_status, response_body, locked_at, expires_at)
            values ('${uuidv7(now)}', '${randomUUID()}', 'live', 'payments.create', 'k-${randomUUID()}', repeat('a', 64), '${status}'${response}, now(), '${expiresAt.toISOString()}')`;
  }

  function outboxRow(createdAt: Date, publishedAt: Date | null): string {
    const published = publishedAt ? `'${publishedAt.toISOString()}'` : 'null';
    const locked = publishedAt ? `'${publishedAt.toISOString()}'` : 'null';
    return `insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at, attempts, locked_at, published_at, created_at)
            values ('${uuidv7(createdAt)}', 'probe', '1', 'probe.created', '{}'::jsonb, 'dk-${randomUUID()}', '${createdAt.toISOString()}', 0, ${locked}, ${published}, '${createdAt.toISOString()}')`;
  }

  it('purges idempotency keys that expired more than 7 days ago, in batches, and only those', async () => {
    await seed([
      ...Array.from({ length: 2500 }, () => idempotencyRow(new Date(now.getTime() - 8 * day))),
      idempotencyRow(new Date(now.getTime() - 10 * day), 'in_flight'),
      idempotencyRow(new Date(now.getTime() - 2 * day)), // inside the grace window
      idempotencyRow(new Date(now.getTime() + day)), // still valid
    ]);
    const run = await lifecycle.enforceRetention();
    expect(run.idempotencyKeysDeleted).toBe(2501);
    const left = await q<{ n: string }>('select count(*)::text as n from core.idempotency_keys');
    expect(left[0]?.n).toBe('2');
    expect((await lifecycle.enforceRetention()).idempotencyKeysDeleted).toBe(0);
  });

  it('purges published outbox rows older than 14 days and never an unpublished one', async () => {
    await seed([
      outboxRow(new Date(now.getTime() - 30 * day), new Date(now.getTime() - 20 * day)), // purge
      outboxRow(new Date(now.getTime() - 16 * day), new Date(now.getTime() - 15 * day)), // purge
      outboxRow(new Date(now.getTime() - 6 * day), new Date(now.getTime() - 5 * day)), // keep: recent
      outboxRow(new Date(now.getTime() - 40 * day), null), // keep: never published
      // Created long ago, published recently (a late retry): the id bound alone would allow it.
      outboxRow(new Date(now.getTime() - 40 * day), new Date(now.getTime() - 1 * day)), // keep
    ]);
    const run = await lifecycle.enforceRetention();
    expect(run.outboxRowsDeleted).toBe(2);
    const left = await q<{ published: boolean }>(
      'select published_at is not null as published from core.outbox order by id'
    );
    expect(left).toHaveLength(3);
    expect(left.filter((r) => !r.published)).toHaveLength(1);
    expect((await lifecycle.enforceRetention()).outboxRowsDeleted).toBe(0);
  });

  it('two concurrent purges delete each row once', async () => {
    await seed(
      Array.from({ length: 1800 }, () => idempotencyRow(new Date(now.getTime() - 9 * day)))
    );
    const [a, b] = await Promise.all([lifecycle.enforceRetention(), lifecycle.enforceRetention()]);
    expect(a.idempotencyKeysDeleted + b.idempotencyKeysDeleted).toBe(1800);
  });
});
