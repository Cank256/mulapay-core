/**
 * Database security (spec 5.3, 11, decisions D2 and D5): what each role can and cannot do,
 * proven by attempting it. Phase 9 review.
 *
 *   mulapay_core_rw   DML on `core`, nothing on gateway tables, never UPDATE/DELETE/TRUNCATE on
 *                     the append-only tables, never DELETE on financial state
 *   mulapay_core_ro   SELECT on two gateway tables, nothing else, read-only by default
 *
 * One test is marked `it.fails` and documents FINDING DB-1: `mulapay_core_rw` owns the `core`
 * schema and every table in it, so the append-only controls (revokes and triggers) can be
 * undone by anyone holding that role's credentials. The spec states the opposite expectation
 * ("no UPDATE or DELETE ... revoked from mulapay_core_rw"). The fix is an architecture change (a
 * separate migration/owner role), so it is reported, not applied: see docs/SECURITY.md.
 * When the finding is fixed, the `it.fails` test starts failing, which is the signal to turn it
 * into a plain `it`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const urls = inject('databaseUrls');
const DENIED = '42501';
/** A write by the ro role is stopped by the read-only default (25006) or by the missing privilege (42501). */
const WRITE_REFUSED = ['42501', '25006'];
let rw: Client;
let ro: Client;
let admin: Client;

async function code(client: Client, statement: string): Promise<string | undefined> {
  await client.query('begin');
  try {
    await client.query(statement);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await client.query('rollback');
  }
}

beforeAll(async () => {
  rw = new Client({ connectionString: urls.rw });
  ro = new Client({ connectionString: urls.ro });
  admin = new Client({ connectionString: urls.superuser });
  await Promise.all([rw.connect(), ro.connect(), admin.connect()]);
});

afterAll(async () => {
  await Promise.all([rw.end(), ro.end(), admin.end()]);
});

describe('role attributes', () => {
  it('neither application role can escalate', async () => {
    const roles = (
      await admin.query(
        `select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
           from pg_roles where rolname in ('mulapay_core_rw', 'mulapay_core_ro') order by rolname`
      )
    ).rows;
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
    }
  });

  it('carries statement and idle-transaction timeouts, and the ro role is read-only by default', async () => {
    const config = (
      await admin.query(
        `select rolname, rolconfig from pg_roles where rolname in ('mulapay_core_rw', 'mulapay_core_ro')`
      )
    ).rows as { rolname: string; rolconfig: string[] }[];
    const of = (name: string) => config.find((r) => r.rolname === name)?.rolconfig ?? [];
    expect(of('mulapay_core_rw').some((c) => c.startsWith('statement_timeout='))).toBe(true);
    expect(
      of('mulapay_core_rw').some((c) => c.startsWith('idle_in_transaction_session_timeout='))
    ).toBe(true);
    expect(of('mulapay_core_ro')).toContain('default_transaction_read_only=on');
    expect(of('mulapay_core_ro').some((c) => c.startsWith('statement_timeout='))).toBe(true);
  });

  it('cannot become another role', async () => {
    for (const statement of ['set role postgres', 'set session authorization postgres']) {
      expect(await code(rw, statement), statement).toBe(DENIED);
      expect(await code(ro, statement), statement).toBe(DENIED);
    }
    expect(await code(rw, `create role mulapay_evil login`)).toBe(DENIED);
    expect(await code(rw, `alter role mulapay_core_rw superuser`)).toBe(DENIED);
    expect(await code(rw, `create extension if not exists pgcrypto`)).toBe(DENIED);
  });

  it('PUBLIC holds no privilege on any core table or function', async () => {
    const tables = await admin.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'core' and grantee = 'PUBLIC'`
    );
    expect(tables.rows).toEqual([]);
    const schema = await admin.query(
      `select has_schema_privilege('public', 'core', 'USAGE') as usage`
    );
    expect(schema.rows[0]?.usage).toBe(false);
  });

  it('no function in core runs with its owner’s rights', async () => {
    const definers = await admin.query(
      `select proname from pg_proc where pronamespace = 'core'::regnamespace and prosecdef`
    );
    expect(definers.rows).toEqual([]);
  });
});

describe('mulapay_core_rw and the gateway’s tables', () => {
  const gateway = ['public.operation_events', 'public.provider_operations'];

  it('has no privilege at all on anything in public', async () => {
    const grants = await admin.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'mulapay_core_rw'`
    );
    expect(grants.rows).toEqual([]);
  });

  it.each(gateway)('cannot read, insert, update, delete or truncate %s', async (table) => {
    for (const statement of [
      `select * from ${table} limit 1`,
      `insert into ${table} default values`,
      `update ${table} set status = 'successful'`,
      `delete from ${table}`,
      `truncate ${table}`,
    ]) {
      expect(await code(rw, statement), statement).toBe(DENIED);
    }
  });

  it('cannot create, alter or drop anything in public', async () => {
    expect(await code(rw, 'create table public.rw_probe (id int)')).toBe(DENIED);
    expect(await code(rw, 'alter table public.operation_events add column probe int')).toBe(DENIED);
    expect(await code(rw, 'drop table public.operation_events')).toBe(DENIED);
  });
});

describe('mulapay_core_ro (the gateway read role)', () => {
  it('reads the two gateway tables', async () => {
    await ro.query('select id from public.operation_events limit 1');
    await ro.query('select id from public.provider_operations limit 1');
  });

  it('reads nothing in core and cannot call core functions', async () => {
    expect(await code(ro, 'select 1 from core.merchants limit 1')).toBe(DENIED);
    expect(await code(ro, 'select 1 from core.journal_lines limit 1')).toBe(DENIED);
    expect(await code(ro, 'select 1 from core.audit_logs limit 1')).toBe(DENIED);
    expect(await code(ro, 'select * from core.ensure_partitions()')).toBe(DENIED);
  });

  it('cannot write the gateway tables, even after switching the read-only default off', async () => {
    for (const table of ['public.operation_events', 'public.provider_operations']) {
      expect(WRITE_REFUSED).toContain(await code(ro, `insert into ${table} default values`));
      expect(WRITE_REFUSED).toContain(await code(ro, `update ${table} set status = 'failed'`));
      expect(WRITE_REFUSED).toContain(await code(ro, `delete from ${table}`));
    }
    await ro.query('begin');
    await ro.query('set transaction read write');
    expect(
      await ro
        .query(`insert into public.operation_events default values`)
        .then(() => undefined)
        .catch((e: { code?: string }) => e.code)
    ).toBe(DENIED);
    await ro.query('rollback');
  });

  it('cannot create objects', async () => {
    expect(WRITE_REFUSED).toContain(await code(ro, 'create table public.ro_probe (id int)'));
    expect(WRITE_REFUSED).toContain(await code(ro, 'create schema ro_probe'));
  });

  it('has exactly SELECT on exactly two tables', async () => {
    const grants = await admin.query(
      `select table_schema || '.' || table_name as t, privilege_type from information_schema.role_table_grants
        where grantee = 'mulapay_core_ro' order by 1, 2`
    );
    expect(grants.rows).toEqual([
      { t: 'public.operation_events', privilege_type: 'SELECT' },
      { t: 'public.provider_operations', privilege_type: 'SELECT' },
    ]);
  });
});

describe('append-only and financial tables, as the application role', () => {
  const appendOnly = [
    'core.journal_entries',
    'core.journal_lines',
    'core.journal_entry_keys',
    'core.audit_logs',
    'core.transaction_keys',
    'core.transaction_events',
    'core.currencies',
    'core.api_request_logs',
    'core.merchant_events',
    'core.partition_policies',
    'core.complaint_messages',
    'core.approval_decisions',
  ];

  it.each(appendOnly)('%s cannot be updated, deleted or truncated', async (table) => {
    // The privilege check comes before any row is read, so no data is needed. Some tables keep a
    // column grant on created_at (foreign key locks, docs/DATABASE.md), so probe another column.
    const [schema, name] = table.split('.');
    const column = (
      await admin.query(
        `select column_name from information_schema.columns
          where table_schema = $1 and table_name = $2 and column_name <> 'created_at'
          order by ordinal_position limit 1`,
        [schema, name]
      )
    ).rows[0]?.column_name as string;
    expect(column, `a column of ${table} to probe`).toBeTruthy();
    expect(await code(rw, `update ${table} set ${column} = ${column} where false`), 'update').toBe(
      DENIED
    );
    expect(await code(rw, `delete from ${table} where false`), 'delete').toBe(DENIED);
    expect(await code(rw, `truncate ${table}`), 'truncate').toBe(DENIED);
  });

  it.each([
    'core.journal_lines_default',
    'core.journal_entries_default',
    'core.audit_logs_default',
    'core.api_request_logs_default',
  ])('the default partition %s is guarded when addressed directly', async (partition) => {
    expect(await code(rw, `delete from ${partition} where false`)).toBe(DENIED);
    expect(await code(rw, `update ${partition} set created_at = created_at where false`)).toBe(
      DENIED
    );
    expect(await code(rw, `truncate ${partition}`)).toBe(DENIED);
  });

  it.each([
    'core.transactions',
    'core.payments',
    'core.payment_links',
    'core.checkout_sessions',
    'core.holds',
    'core.accounts',
    'core.account_balances',
    'core.webhook_endpoints',
    'core.complaints',
    'core.approvals',
    'core.reports',
    'core.notifications',
  ])('%s can never be deleted from or truncated', async (table) => {
    expect(await code(rw, `delete from ${table} where false`), 'delete').toBe(DENIED);
    expect(await code(rw, `truncate ${table}`), 'truncate').toBe(DENIED);
  });

  it('the append-only triggers are enabled, and stop even a role that holds the privilege', async () => {
    const triggers = await admin.query(
      `select c.relname as table, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relnamespace = 'core'::regnamespace and not c.relispartition and not t.tgisinternal
          and t.tgname in ('journal_lines_append_only', 'journal_entries_append_only', 'audit_logs_append_only',
                           'journal_lines_no_truncate', 'journal_entries_no_truncate', 'audit_logs_no_truncate')
        order by t.tgname`
    );
    expect(triggers.rows).toHaveLength(6);
    expect(triggers.rows.every((t: { tgenabled: string }) => t.tgenabled === 'O')).toBe(true);
    // The superuser holds every privilege, so only the statement-level trigger stands in the way.
    for (const table of ['core.journal_lines', 'core.journal_entries', 'core.audit_logs']) {
      // 0A000: a table that a foreign key references cannot be truncated at all; both are refusals.
      expect(['42501', '0A000']).toContain(await code(admin, `truncate ${table}`));
    }
  });

  it('has no write path to the gateway tables in the source', () => {
    const root = resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
          const text = readFileSync(path, 'utf8');
          if (
            /(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+(only\s+)?public\.(operation_events|provider_operations)/i.test(
              text
            )
          ) {
            offenders.push(path.replace(root, 'src'));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('FINDING DB-1: the application role owns the objects it must not alter', () => {
  it('documents current ownership', async () => {
    const owners = await admin.query(
      `select distinct pg_get_userbyid(relowner) as owner from pg_class
        where relnamespace = 'core'::regnamespace and relkind in ('r', 'p')`
    );
    // If this stops being the application role, DB-1 is fixed: update docs/SECURITY.md.
    expect(owners.rows).toEqual([{ owner: 'mulapay_core_rw' }]);
  });

  it.fails(
    'mulapay_core_rw cannot disable the append-only trigger (DB-1: it can, as owner)',
    async () => {
      expect(
        await code(rw, 'alter table core.journal_lines disable trigger journal_lines_append_only')
      ).toBe(DENIED);
    }
  );

  it.fails(
    'mulapay_core_rw cannot re-grant itself UPDATE on the journal (DB-1: it can, as owner)',
    async () => {
      expect(await code(rw, 'grant update on core.journal_lines to mulapay_core_rw')).toBe(DENIED);
    }
  );

  it.fails('mulapay_core_rw cannot drop a ledger table (DB-1: it can, as owner)', async () => {
    expect(await code(rw, 'drop table core.journal_entry_keys cascade')).toBe(DENIED);
  });
});
