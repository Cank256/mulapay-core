/**
 * Starts Postgres 16 and Redis 7 once for the integration project and prepares the
 * database exactly as a real environment is prepared:
 *
 *   1. bootstrap SQL as superuser (roles, `core` schema)          src/db/bootstrap/001
 *   2. stand-in gateway tables (test fixture)                     test/fixtures
 *   3. gateway read grants as superuser                           src/db/bootstrap/002
 *   4. migrations as mulapay_core_rw over a direct connection     src/db/migrator.ts
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pino from 'pino';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrator';

const ROOT = resolve(__dirname, '../..');
const CAPTURE_STATEMENTS = process.env.PG_STAT_STATEMENTS === '1';
const DB = 'mulapay';
const RW_PASSWORD = 'core_rw_test';
const RO_PASSWORD = 'core_ro_test';

export interface TestDatabaseUrls {
  readonly superuser: string;
  readonly rw: string;
  readonly ro: string;
}

/**
 * A second database, prepared like the first. Suites that change platform-wide state (maintenance
 * mode, provider switches, routing rules, feature flags, the consumer cursor) or that read every
 * transaction in the database (the incident monitors) run here, so they cannot act on the
 * suites that share the main database.
 */
const ISOLATED_DB = 'mulapay_isolated';
/** The runbook walk-through changes the same platform-wide state as the operations suite: its own database. */
const RUNBOOKS_DB = 'mulapay_runbooks';

/** Partition and retention suites create, drop and fill partitions: their own database. */
const LIFECYCLE_DB = 'mulapay_lifecycle';
/** Migrated only up to 0008, so the Phase 9 migration can be applied over existing data. */
const UPGRADE_DB = 'mulapay_upgrade';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
    isolatedDatabaseUrls: TestDatabaseUrls;
    runbookDatabaseUrls: TestDatabaseUrls;
    lifecycleDatabaseUrls: TestDatabaseUrls;
    upgradeDatabaseUrls: TestDatabaseUrls;
    /** Container ids of a chaos run, so a test can kill and restart them (null otherwise). */
    chaosContainers: { postgresId: string; redisId: string } | null;
    redisUrl: string;
  }
}

async function psql(
  container: StartedPostgreSqlContainer,
  args: string[],
  database: string = DB
): Promise<void> {
  const result = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    database,
    ...args,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`psql failed (${result.exitCode}): ${result.output}`);
  }
}

/** The migrations folder, or a copy whose journal stops at `maxIdx` (to test an upgrade). */
function migrationsUpTo(maxIdx?: number): string {
  const source = resolve(ROOT, 'src/db/migrations');
  if (maxIdx === undefined) return source;
  const copy = mkdtempSync(resolve(tmpdir(), 'core-migrations-'));
  cpSync(source, copy, { recursive: true });
  const journalPath = resolve(copy, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return copy;
}

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

/**
 * Chaos runs (`CHAOS=1`, `npm run test:chaos`) kill and restart the containers, so each publishes
 * its port on a fixed host port: a restarted container keeps its address and the application's
 * pools reconnect on their own, as they would to a restarted database in production.
 */
const CHAOS = process.env.CHAOS === '1';

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

export async function setup(project: TestProject): Promise<void> {
  const [postgresPort, redisPort] = CHAOS ? [await freePort(), await freePort()] : [0, 0];
  const postgresBuilder = new PostgreSqlContainer('postgres:16-alpine');
  const redisBuilder = new RedisContainer('redis:7-alpine');
  if (CHAOS) {
    postgresBuilder.withExposedPorts({ container: 5432, host: postgresPort });
    // Redis keeps no data across a kill here on purpose: it is not a source of truth (spec).
    redisBuilder.withExposedPorts({ container: 6379, host: redisPort });
  }
  [postgres, redis] = await Promise.all([
    postgresBuilder
      .withDatabase(DB)
      // The suites run in parallel, each with its own app and pools.
      .withCommand([
        'postgres',
        '-c',
        'max_connections=400',
        // Opt-in (PG_STAT_STATEMENTS=1): records every statement the suites run, for the query
        // review in docs/query-plans (Phase 9). Off by default: it costs a little on every query.
        ...(CAPTURE_STATEMENTS
          ? [
              '-c',
              'shared_preload_libraries=pg_stat_statements',
              '-c',
              'pg_stat_statements.max=20000',
              '-c',
              'pg_stat_statements.track=all',
            ]
          : []),
      ])
      .withUsername('postgres')
      .withPassword('postgres')
      .withCopyDirectoriesToContainer([
        { source: resolve(ROOT, 'src/db/bootstrap'), target: '/bootstrap' },
        { source: resolve(ROOT, 'test/fixtures'), target: '/fixtures' },
      ])
      .start(),
    redisBuilder.start(),
  ]);

  await psql(postgres, [
    '-v',
    `rw_password=${RW_PASSWORD}`,
    '-v',
    `ro_password=${RO_PASSWORD}`,
    '-v',
    'statement_timeout=15s',
    '-v',
    'idle_tx_timeout=10s',
    '-f',
    '/bootstrap/001_core_roles_and_schema.sql',
  ]);
  await psql(postgres, ['-f', '/fixtures/gateway-contract-tables.sql']);
  await psql(postgres, ['-f', '/bootstrap/002_gateway_read_grants.sql']);

  if (CAPTURE_STATEMENTS) {
    await psql(postgres, ['-c', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements']);
  }
  const host = postgres.getHost();
  const port = postgres.getPort();
  const urls: TestDatabaseUrls = {
    superuser: `postgres://postgres:postgres@${host}:${port}/${DB}`,
    rw: `postgres://mulapay_core_rw:${RW_PASSWORD}@${host}:${port}/${DB}`,
    ro: `postgres://mulapay_core_ro:${RO_PASSWORD}@${host}:${port}/${DB}`,
  };

  await runMigrations({
    connectionString: urls.rw,
    migrationsFolder: resolve(ROOT, 'src/db/migrations'),
    logger: pino({ level: 'silent' }),
  });

  const bootstrapArgs = [
    '-v',
    `rw_password=${RW_PASSWORD}`,
    '-v',
    `ro_password=${RO_PASSWORD}`,
    '-v',
    'statement_timeout=15s',
    '-v',
    'idle_tx_timeout=10s',
    '-f',
    '/bootstrap/001_core_roles_and_schema.sql',
  ];
  const container = postgres;
  const prepareDatabase = async (name: string, upToIdx?: number): Promise<TestDatabaseUrls> => {
    await psql(container, ['-c', `CREATE DATABASE ${name}`]);
    await psql(container, bootstrapArgs, name);
    await psql(container, ['-f', '/fixtures/gateway-contract-tables.sql'], name);
    await psql(container, ['-f', '/bootstrap/002_gateway_read_grants.sql'], name);
    const prepared: TestDatabaseUrls = {
      superuser: `postgres://postgres:postgres@${host}:${port}/${name}`,
      rw: `postgres://mulapay_core_rw:${RW_PASSWORD}@${host}:${port}/${name}`,
      ro: `postgres://mulapay_core_ro:${RO_PASSWORD}@${host}:${port}/${name}`,
    };
    await runMigrations({
      connectionString: prepared.rw,
      migrationsFolder: migrationsUpTo(upToIdx),
      logger: pino({ level: 'silent' }),
    });
    return prepared;
  };
  const isolated = await prepareDatabase(ISOLATED_DB);
  const runbooks = await prepareDatabase(RUNBOOKS_DB);
  const lifecycle = await prepareDatabase(LIFECYCLE_DB);
  const upgrade = await prepareDatabase(UPGRADE_DB, 8);
  project.provide('databaseUrls', urls);
  project.provide('isolatedDatabaseUrls', isolated);
  project.provide('runbookDatabaseUrls', runbooks);
  project.provide('lifecycleDatabaseUrls', lifecycle);
  project.provide('upgradeDatabaseUrls', upgrade);
  project.provide(
    'chaosContainers',
    CHAOS ? { postgresId: postgres.getId(), redisId: redis.getId() } : null
  );
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  if (CAPTURE_STATEMENTS && postgres) {
    const out = process.env.PG_STAT_STATEMENTS_OUT ?? '/tmp/p9/pgss.json';
    const dump = await postgres.exec([
      'psql',
      '-U',
      'postgres',
      '-d',
      DB,
      '-At',
      '-c',
      `select coalesce(json_agg(t), '[]'::json) from (
         select r.rolname as role, d.datname as database, s.calls, s.rows,
                round(s.total_exec_time::numeric, 2) as total_ms, round(s.mean_exec_time::numeric, 3) as mean_ms,
                round(s.max_exec_time::numeric, 2) as max_ms,
                s.shared_blks_hit, s.shared_blks_read, s.shared_blks_dirtied, s.query
           from pg_stat_statements s
           join pg_roles r on r.oid = s.userid join pg_database d on d.oid = s.dbid
          where r.rolname in ('mulapay_core_rw', 'mulapay_core_ro')) t`,
    ]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, dump.output);
  }
  await Promise.all([redis?.stop(), postgres?.stop()]);
}
