/**
 * Applies drizzle-kit migrations to the `core` schema.
 *
 * Same journal format and bookkeeping table as drizzle-orm's migrator
 * (`core.__drizzle_migrations`, keyed by the journal timestamp), with three differences:
 *
 * 1. It never runs CREATE SCHEMA. Drizzle's migrator always does, and that requires
 *    database-level CREATE, which mulapay_core_rw does not have.
 * 2. It holds an advisory lock so two deploys cannot migrate concurrently.
 * 3. It refuses to run if an applied migration file has been edited (hash mismatch).
 *    Migrations are append-only; fix a bad one with a new migration.
 *
 * All pending migrations apply in one transaction: all or nothing.
 */
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import type { Logger } from 'pino';

const MIGRATION_LOCK = 'core:migrations';

export interface MigrateOptions {
  readonly connectionString: string;
  readonly migrationsFolder: string;
  readonly logger: Logger;
  readonly lockTimeoutMs?: number;
}

export interface MigrateResult {
  readonly applied: number;
  readonly total: number;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const migrations = readMigrationFiles({ migrationsFolder: options.migrationsFolder });
  const client = new Client({
    connectionString: options.connectionString,
    application_name: 'mulapay-core:migrate',
  });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
    // Session-level settings are fine here: this is a direct connection, not PgBouncer.
    await client.query("select set_config('statement_timeout', '0', false)");
    await client.query("select set_config('lock_timeout', $1, false)", [
      String(options.lockTimeoutMs ?? 15000),
    ]);

    const schema = await client.query<{ exists: boolean }>(
      "select exists (select 1 from pg_namespace where nspname = 'core') as exists"
    );
    if (schema.rows[0]?.exists !== true) {
      throw new MigrationIntegrityError(
        'schema "core" does not exist; run the bootstrap SQL first (docs/DATABASE.md)'
      );
    }
    await client.query(
      'create table if not exists core.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)'
    );
    const appliedRows = await client.query<{ hash: string; created_at: string }>(
      'select hash, created_at from core.__drizzle_migrations order by created_at asc'
    );

    const byTimestamp = new Map(migrations.map((m) => [String(m.folderMillis), m]));
    for (const row of appliedRows.rows) {
      const file = byTimestamp.get(String(row.created_at));
      if (!file) {
        throw new MigrationIntegrityError(
          `applied migration ${row.created_at} has no file in ${options.migrationsFolder}`
        );
      }
      if (file.hash !== row.hash) {
        throw new MigrationIntegrityError(
          `migration ${row.created_at} was edited after it was applied; add a new migration instead`
        );
      }
    }

    const lastApplied = appliedRows.rows.reduce((max, r) => Math.max(max, Number(r.created_at)), 0);
    const pending = migrations.filter((m) => m.folderMillis > lastApplied);
    if (pending.length === 0) {
      options.logger.info({ total: migrations.length }, 'database is up to date');
      return { applied: 0, total: migrations.length };
    }

    await client.query('begin');
    try {
      for (const migration of pending) {
        for (const statement of migration.sql) {
          if (statement.trim().length > 0) await client.query(statement);
        }
        await client.query(
          'insert into core.__drizzle_migrations (hash, created_at) values ($1, $2)',
          [migration.hash, migration.folderMillis]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    options.logger.info(
      { applied: pending.length, total: migrations.length },
      'migrations applied'
    );
    return { applied: pending.length, total: migrations.length };
  } finally {
    await client
      .query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK])
      .catch(() => undefined);
    await client.end();
  }
}
