/**
 * Phase 1 database invariants, proven against real Postgres as mulapay_core_rw: the
 * permission catalogue matches the code, the audit log is append-only, partitions exist,
 * one owner per merchant, and actor-type consistency of roles and memberships.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  MERCHANT_PERMISSIONS,
  MERCHANT_ROLES,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
} from '../../src/common/authz/permissions';
import { publicId } from '../../src/common/ids/ids';

const urls = inject('databaseUrls');
let rw: Client;

async function expectPgError(sql: string, params: unknown[], code: string) {
  await expect(rw.query(sql, params)).rejects.toMatchObject({ code });
}

async function insertUser(type: 'staff' | 'merchant_user') {
  const id = randomUUID();
  await rw.query(
    `insert into core.users (id, ref, type, email, password_hash, name) values ($1, $2, $3, $4, 'x', 'n')`,
    [id, publicId('user'), type, `${id}@example.com`]
  );
  return id;
}

async function insertMerchant() {
  const id = randomUUID();
  await rw.query(
    `insert into core.merchants (id, ref, legal_name, country, default_currency) values ($1, $2, 'M', 'UG', 'UGX')`,
    [id, publicId('merchant')]
  );
  return id;
}

beforeAll(async () => {
  rw = new Client({ connectionString: urls.rw });
  await rw.connect();
});

afterAll(async () => {
  await rw.end();
});

describe('roles and permissions seed', () => {
  it('matches the code catalogue exactly', async () => {
    const permissions = await rw.query<{ key: string; actor_type: string }>(
      'select key, actor_type from core.permissions order by key'
    );
    expect(
      permissions.rows
        .filter((r) => r.actor_type === 'merchant')
        .map((r) => r.key)
        .sort()
    ).toEqual([...MERCHANT_PERMISSIONS].sort());
    expect(
      permissions.rows
        .filter((r) => r.actor_type === 'staff')
        .map((r) => r.key)
        .sort()
    ).toEqual([...STAFF_PERMISSIONS].sort());
    const roles = await rw.query<{ key: string; actor_type: string }>(
      'select key, actor_type from core.roles'
    );
    expect(
      roles.rows
        .filter((r) => r.actor_type === 'merchant')
        .map((r) => r.key)
        .sort()
    ).toEqual([...MERCHANT_ROLES].sort());
    expect(
      roles.rows
        .filter((r) => r.actor_type === 'staff')
        .map((r) => r.key)
        .sort()
    ).toEqual([...STAFF_ROLES].sort());
  });

  it('refuses a permission of the wrong actor type on a role', async () => {
    await expectPgError(
      `insert into core.role_permissions (role_key, permission_key) values ('viewer', 'merchants:create')`,
      [],
      '23514'
    );
  });

  it('refuses staff roles for merchant users and merchant membership for staff', async () => {
    const merchantUser = await insertUser('merchant_user');
    const staff = await insertUser('staff');
    await expectPgError(
      `insert into core.staff_role_assignments (user_id, role_key) values ($1, 'super_admin')`,
      [merchantUser],
      '23514'
    );
    await expectPgError(
      `insert into core.staff_role_assignments (user_id, role_key) values ($1, 'owner')`,
      [staff],
      '23514'
    );
    const merchant = await insertMerchant();
    await expectPgError(
      `insert into core.merchant_members (id, merchant_id, user_id, role, joined_at) values ($1, $2, $3, 'viewer', now())`,
      [randomUUID(), merchant, staff],
      '23514'
    );
  });
});

describe('merchants and members', () => {
  it('allows exactly one active owner per merchant', async () => {
    const merchant = await insertMerchant();
    const [a, b] = [await insertUser('merchant_user'), await insertUser('merchant_user')];
    await rw.query(
      `insert into core.merchant_members (id, merchant_id, user_id, role, joined_at) values ($1, $2, $3, 'owner', now())`,
      [randomUUID(), merchant, a]
    );
    await expectPgError(
      `insert into core.merchant_members (id, merchant_id, user_id, role, joined_at) values ($1, $2, $3, 'owner', now())`,
      [randomUUID(), merchant, b],
      '23505'
    );
  });

  it('enforces merchant status, country and email uniqueness case-insensitively', async () => {
    const merchant = await insertMerchant();
    await expectPgError(
      `update core.merchants set status = 'live' where id = $1`,
      [merchant],
      '23514'
    );
    await expectPgError(
      `update core.merchants set country = 'ug' where id = $1`,
      [merchant],
      '23514'
    );
    const user = await insertUser('merchant_user');
    const { rows } = await rw.query<{ email: string }>(
      'select email from core.users where id = $1',
      [user]
    );
    await expectPgError(
      `insert into core.users (id, ref, type, email, password_hash, name) values ($1, $2, 'staff', $3, 'x', 'n')`,
      [randomUUID(), publicId('user'), rows[0]!.email.toUpperCase()],
      '23505'
    );
  });

  it('maintains updated_at by trigger', async () => {
    const merchant = await insertMerchant();
    await rw.query(`update core.merchants set updated_at = '2000-01-01' where id = $1`, [merchant]);
    const { rows } = await rw.query<{ updated_at: Date }>(
      'select updated_at from core.merchants where id = $1',
      [merchant]
    );
    expect(rows[0]!.updated_at.getFullYear()).toBeGreaterThan(2000);
  });
});

describe('audit log', () => {
  it('is partitioned monthly with a default partition', async () => {
    const { rows } = await rw.query<{ name: string }>(
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'core.audit_logs'::regclass order by 1`
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain('audit_logs_default');
    expect(names).toContain('audit_logs_202501');
    const now = new Date();
    const thisMonth = `audit_logs_${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(names).toContain(thisMonth);
  });

  it('refuses UPDATE, DELETE and TRUNCATE for the rw role, on the parent and on partitions', async () => {
    await expectPgError('update core.audit_logs set action = $1', ['x'], '42501');
    await expectPgError('delete from core.audit_logs', [], '42501');
    await expectPgError('truncate core.audit_logs', [], '42501');
    await expectPgError('delete from core.audit_logs_default', [], '42501');
    await expectPgError('update core.audit_logs_202501 set action = $1', ['x'], '42501');
    await expectPgError('delete from core.audit_chain_head', [], '42501');
  });

  it('refuses mutation by trigger even for a role that holds the privileges', async () => {
    const su = new Client({ connectionString: urls.superuser });
    await su.connect();
    try {
      await su.query(
        `insert into core.audit_logs (seq, actor_type, action, resource_type, changed_fields, outcome, prev_hash, hash, created_at)
         values (-1, 'system', 'test', 'test', '{}', 'success', repeat('0', 64), repeat('a', 64), now())`
      );
      await expect(
        su.query('update core.audit_logs set action = $1 where seq = -1', ['x'])
      ).rejects.toThrow(/append-only/);
      await expect(su.query('delete from core.audit_logs where seq = -1')).rejects.toThrow(
        /append-only/
      );
      await expect(su.query('truncate core.audit_logs')).rejects.toThrow(/append-only/);
    } finally {
      // Leave the chain intact for other suites: the probe row is outside it (seq -1).
      await su.query('alter table core.audit_logs disable trigger audit_logs_append_only');
      await su.query('delete from core.audit_logs where seq = -1');
      await su.query('alter table core.audit_logs enable trigger audit_logs_append_only');
      await su.end();
    }
  });
});
