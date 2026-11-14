/**
 * Database roles, grants and migrations (decisions D1, D2), and the transaction boundary.
 * These assertions need real Postgres: they are about privileges and transaction scope.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runInTransaction } from '../../src/common/db/unit-of-work';
import * as schema from '../../src/db/schema';
import { MigrationIntegrityError, runMigrations } from '../../src/db/migrator';

const MIGRATIONS = resolve(__dirname, '../../src/db/migrations');
const silent = pino({ level: 'silent' });

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function sqlState(url: string, statement: string): Promise<string | undefined> {
  return withClient(url, async (c) => {
    try {
      await c.query(statement);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

const PERMISSION_DENIED = '42501';

describe('database roles and grants', () => {
  const urls = inject('databaseUrls');

  it('mulapay_core_rw can create objects in core', async () => {
    await withClient(urls.rw, async (c) => {
      await c.query('begin');
      await c.query('create table core.grant_probe (id int)');
      await c.query('insert into core.grant_probe values (1)');
      await c.query('rollback');
    });
  });

  it('mulapay_core_rw has no rights on gateway tables', async () => {
    expect(await sqlState(urls.rw, 'select * from public.operation_events limit 1')).toBe(
      PERMISSION_DENIED
    );
    expect(await sqlState(urls.rw, 'select * from public.provider_operations limit 1')).toBe(
      PERMISSION_DENIED
    );
    expect(
      await sqlState(
        urls.rw,
        "insert into public.provider_operations (id, tenant_id, provider_id, operation_type, status) values (gen_random_uuid(), 'core', 'mtn', 'collection', 'pending')"
      )
    ).toBe(PERMISSION_DENIED);
    expect(await sqlState(urls.rw, 'create table public.rw_probe (id int)')).toBe(
      PERMISSION_DENIED
    );
  });

  it('mulapay_core_rw cannot create schemas', async () => {
    expect(await sqlState(urls.rw, 'create schema rogue')).toBe(PERMISSION_DENIED);
  });

  it('mulapay_core_ro can read the gateway event tables', async () => {
    await withClient(urls.ro, async (c) => {
      const events = await c.query('select count(*) from public.operation_events');
      const ops = await c.query('select count(*) from public.provider_operations');
      expect(events.rowCount).toBe(1);
      expect(ops.rowCount).toBe(1);
    });
  });

  it('mulapay_core_ro cannot write gateway tables even with read-only mode switched off', async () => {
    await withClient(urls.ro, async (c) => {
      // Layer 1: the role default makes every transaction read-only.
      await expect(
        c.query("update public.provider_operations set status = 'x' where false")
      ).rejects.toMatchObject({ code: '25006' });
      // Layer 2: the grants alone also refuse the write.
      await c.query('set default_transaction_read_only = off');
      await expect(
        c.query("update public.provider_operations set status = 'x' where false")
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        c.query('delete from public.operation_events where false')
      ).rejects.toMatchObject({
        code: PERMISSION_DENIED,
      });
    });
  });

  it('mulapay_core_ro has no access to core', async () => {
    expect(await sqlState(urls.ro, 'select * from core.__drizzle_migrations')).toBe(
      PERMISSION_DENIED
    );
  });

  it('applies role-level timeout and search_path defaults', async () => {
    await withClient(urls.rw, async (c) => {
      expect((await c.query('show statement_timeout')).rows[0].statement_timeout).toBe('15s');
      expect((await c.query('show idle_in_transaction_session_timeout')).rows[0]).toEqual({
        idle_in_transaction_session_timeout: '10s',
      });
      expect((await c.query('show search_path')).rows[0].search_path).toBe('core');
    });
  });
});

describe('migrations', () => {
  const urls = inject('databaseUrls');

  it('were applied to core by the global setup', async () => {
    await withClient(urls.rw, async (c) => {
      const applied = await c.query('select count(*)::int as n from core.__drizzle_migrations');
      expect(applied.rows[0].n).toBeGreaterThanOrEqual(1);
      const fn = await c.query(
        "select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname = 'set_updated_at'"
      );
      expect(fn.rowCount).toBe(1);
    });
  });

  it('are a no-op when re-run', async () => {
    const result = await runMigrations({
      connectionString: urls.rw,
      migrationsFolder: MIGRATIONS,
      logger: silent,
    });
    expect(result.applied).toBe(0);
  });

  it('refuse to run when an applied migration was edited', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'core-migrations-'));
    cpSync(MIGRATIONS, copy, { recursive: true });
    const file = join(copy, '0000_core_foundation.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited\n`);
    await expect(
      runMigrations({ connectionString: urls.rw, migrationsFolder: copy, logger: silent })
    ).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it('maintain updated_at through core.set_updated_at()', async () => {
    await withClient(urls.rw, async (c) => {
      await c.query('begin');
      await c.query(
        "create table core.touch_probe (id int primary key, updated_at timestamptz not null default '2000-01-01')"
      );
      await c.query(
        'create trigger touch_probe_set_updated_at before update on core.touch_probe for each row execute function core.set_updated_at()'
      );
      await c.query('insert into core.touch_probe (id) values (1)');
      await c.query('update core.touch_probe set id = 1');
      const row = await c.query(
        "select updated_at > now() - interval '1 minute' as fresh from core.touch_probe"
      );
      expect(row.rows[0].fresh).toBe(true);
      await c.query('rollback');
    });
  });
});

describe('runInTransaction', () => {
  const urls = inject('databaseUrls');
  let pool: Pool;
  const timeouts = { statementTimeoutMs: 4000, idleInTransactionTimeoutMs: 3000 };

  beforeAll(() => {
    pool = new Pool({ connectionString: urls.rw, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const db = () => drizzle({ client: pool, schema });

  it('applies the configured timeouts for the transaction only', async () => {
    const inside = await runInTransaction(db(), timeouts, async (tx) => {
      const st = await tx.execute(sql`show statement_timeout`);
      const idle = await tx.execute(sql`show idle_in_transaction_session_timeout`);
      return [st.rows[0], idle.rows[0]];
    });
    expect(inside).toEqual([
      { statement_timeout: '4s' },
      { idle_in_transaction_session_timeout: '3s' },
    ]);
    const after = await pool.query('show statement_timeout');
    expect(after.rows[0].statement_timeout).toBe('15s');
  });

  it('cancels a statement that exceeds the timeout', async () => {
    await expect(
      runInTransaction(db(), timeouts, (tx) => tx.execute(sql`select pg_sleep(1)`), {
        statementTimeoutMs: 100,
      })
    ).rejects.toMatchObject({ cause: { code: '57014' } });
  });

  it('rolls back everything when the work throws', async () => {
    await expect(
      runInTransaction(db(), timeouts, async (tx) => {
        await tx.execute(sql`create table core.rollback_probe (id int)`);
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');
    const exists = await pool.query("select to_regclass('core.rollback_probe') as t");
    expect(exists.rows[0].t).toBeNull();
  });

  it('uses the requested isolation level', async () => {
    const level = await runInTransaction(
      db(),
      timeouts,
      async (tx) => (await tx.execute(sql`show transaction_isolation`)).rows[0],
      { isolationLevel: 'serializable' }
    );
    expect(level).toEqual({ transaction_isolation: 'serializable' });
  });
});
