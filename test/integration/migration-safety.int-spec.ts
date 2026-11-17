/**
 * Migration safety for Phase 9 (0009 and 0010): applied over a database that already holds data, as the
 * application role (no superuser), without touching existing rows, grants or triggers, and
 * safe to run twice. `mulapay_upgrade` is prepared by the global setup with migrations 0000 to 0008.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MigrationIntegrityError, runMigrations } from '../../src/db/migrator';

const urls = inject('upgradeDatabaseUrls');
const MIGRATIONS = resolve(__dirname, '../../src/db/migrations');
const silent = pino({ level: 'silent' });
let admin: Client;
let rw: Client;

const scalar = async (client: Client, text: string): Promise<string> =>
  String((await client.query(text)).rows[0]?.v);

beforeAll(async () => {
  admin = new Client({ connectionString: urls.superuser });
  rw = new Client({ connectionString: urls.rw });
  await Promise.all([admin.connect(), rw.connect()]);
});

afterAll(async () => {
  await Promise.all([admin.end(), rw.end()]);
});

describe('migrations 0009 and 0010 over existing data', () => {
  const ids = Array.from({ length: 3 }, () => randomUUID());

  it('starts at 0008: no policies table, no partition functions', async () => {
    expect(await scalar(admin, `select to_regclass('core.partition_policies') is null as v`)).toBe(
      'true'
    );
    expect(await scalar(admin, `select count(*) as v from core.__drizzle_migrations`)).toBe('9');
  });

  it('applies as the application role, keeps every existing row, and creates nothing destructive', async () => {
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    for (const id of ids) {
      await admin.query(
        `insert into core.api_request_logs (id, ref, merchant_id, environment, api_key_id, method, path, route, status_code, latency_ms, request_id)
         values ($1, $2, $3, 'live', $3, 'GET', '/v1/ping', '/v1/ping', 200, 1, $2)`,
        [id, `arl_${id}`, randomUUID()]
      );
    }
    await admin.query(
      `insert into core.idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, response_status, response_body, locked_at, expires_at)
       values ($1, $2, 'live', 'payments.create', 'k1', repeat('a', 64), 'completed', 201, '{}'::jsonb, now(), now() + interval '1 day')`,
      [randomUUID(), randomUUID()]
    );
    await admin.query('commit');
    const before = await scalar(admin, 'select count(*) as v from core.api_request_logs');
    const grantsBefore = await scalar(
      admin,
      `select string_agg(relname || ':' || coalesce(relacl::text, ''), ',' order by relname) as v from pg_class where relnamespace = 'core'::regnamespace and relkind in ('r','p')`
    );

    const result = await runMigrations({
      connectionString: urls.rw,
      migrationsFolder: MIGRATIONS,
      logger: silent,
    });
    expect(result.applied).toBe(2); // 0009 partitions and retention, 0010 the processing index

    expect(await scalar(admin, 'select count(*) as v from core.api_request_logs')).toBe(before);
    expect(await scalar(admin, `select count(*) as v from core.idempotency_keys`)).toBe('1');
    expect(await scalar(admin, 'select count(*) as v from core.partition_policies')).toBe('7');
    // Only the new table appeared among the ACLs: no existing table's privileges moved.
    const grantsAfter = await scalar(
      admin,
      `select string_agg(relname || ':' || coalesce(relacl::text, ''), ',' order by relname) as v from pg_class where relnamespace = 'core'::regnamespace and relkind in ('r','p') and relname <> 'partition_policies'`
    );
    expect(grantsAfter).toBe(
      grantsBefore
        .split(',')
        .filter((e) => !e.startsWith('partition_policies'))
        .join(',')
    );
  });

  it('left every table with at least three months ahead', async () => {
    const rows = (await admin.query(`select parent, months_ahead from core.partition_status()`))
      .rows as { parent: string; months_ahead: number }[];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.months_ahead, row.parent).toBeGreaterThanOrEqual(3);
  });

  it('is a no-op when run again, and a second ensure creates nothing', async () => {
    const again = await runMigrations({
      connectionString: urls.rw,
      migrationsFolder: MIGRATIONS,
      logger: silent,
    });
    expect(again.applied).toBe(0);
    const created = await rw.query(
      `select * from core.ensure_partitions() where outcome = 'created'`
    );
    expect(created.rowCount).toBe(0);
  });

  it('refuses an edited migration file (migrations are append-only)', async () => {
    await admin.query(
      `update core.__drizzle_migrations set hash = 'tampered' where id = (select max(id) from core.__drizzle_migrations)`
    );
    await expect(
      runMigrations({ connectionString: urls.rw, migrationsFolder: MIGRATIONS, logger: silent })
    ).rejects.toBeInstanceOf(MigrationIntegrityError);
  });
});
