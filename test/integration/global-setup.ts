/**
 * Starts Postgres 16 and Redis 7 once for the integration project and prepares the
 * database exactly as a real environment is prepared:
 *
 *   1. bootstrap SQL as superuser (roles, `core` schema)          src/db/bootstrap/001
 *   2. stand-in gateway tables (test fixture)                     test/fixtures
 *   3. gateway read grants as superuser                           src/db/bootstrap/002
 *   4. migrations as mulapay_core_rw over a direct connection     src/db/migrator.ts
 */
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pino from 'pino';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrator';

const ROOT = resolve(__dirname, '../..');
const DB = 'mulapay';
const RW_PASSWORD = 'core_rw_test';
const RO_PASSWORD = 'core_ro_test';

export interface TestDatabaseUrls {
  readonly superuser: string;
  readonly rw: string;
  readonly ro: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
    redisUrl: string;
  }
}

async function psql(container: StartedPostgreSqlContainer, args: string[]): Promise<void> {
  const result = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    DB,
    ...args,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`psql failed (${result.exitCode}): ${result.output}`);
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DB)
      // The suites run in parallel, each with its own app and pools.
      .withCommand(['postgres', '-c', 'max_connections=400'])
      .withUsername('postgres')
      .withPassword('postgres')
      .withCopyDirectoriesToContainer([
        { source: resolve(ROOT, 'src/db/bootstrap'), target: '/bootstrap' },
        { source: resolve(ROOT, 'test/fixtures'), target: '/fixtures' },
      ])
      .start(),
    new RedisContainer('redis:7-alpine').start(),
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

  project.provide('databaseUrls', urls);
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await Promise.all([redis?.stop(), postgres?.stop()]);
}
