/**
 * Database pools (spec section 9.2 rule 3, decision D2).
 *
 * - `rw`      primary via PgBouncer, role mulapay_core_rw (full rights on `core` only)
 * - `ro`      primary, role mulapay_core_ro (SELECT on the gateway's event tables only)
 * - `replica` read replica for reports, analytics and admin lists
 *
 * PgBouncer runs in transaction mode, so nothing here sets session state: no `SET`, no
 * startup `statement_timeout` (PgBouncer rejects unknown startup parameters), no named
 * prepared statements. Timeouts are applied per transaction by the UnitOfWork and as
 * role defaults by the bootstrap SQL. Advisory locks use a dedicated direct connection.
 */
import { Pool, type PoolConfig } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { toLoggableError } from '../logging/redaction';

export type PoolName = 'rw' | 'ro' | 'replica';

export interface DatabasePools {
  readonly rw: Pool;
  readonly ro: Pool;
  /** Same object as `rw` when DATABASE_REPLICA_URL is unset. */
  readonly replica: Pool;
}

type PoolSettings = Pick<
  AppConfig,
  | 'DATABASE_URL'
  | 'DATABASE_RO_URL'
  | 'DATABASE_REPLICA_URL'
  | 'DB_POOL_MIN'
  | 'DB_POOL_MAX'
  | 'DB_STATEMENT_TIMEOUT_MS'
  | 'APP_ROLE'
>;

const CONNECTION_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30000;
/**
 * The client gives up this long after the server's `statement_timeout` would have. The server's
 * own error arrives first whenever the server is alive; this limit exists for the case where it is
 * not: a network partition, a vanished host or a failover that never closes the socket. Then the
 * server cannot time anything out, and without a client-side limit the query, the request waiting on
 * it and the pool client wait for the operating system's TCP timeout, which is hours (Phase 9
 * finding DB-3).
 *
 * It is derived from the global `DB_STATEMENT_TIMEOUT_MS`. A transaction that raises its own
 * `statementTimeoutMs` above that (the `UnitOfWork` option) would be cut off here first: no caller does
 * today; raise this limit with it if one ever does.
 */
const CLIENT_QUERY_GRACE_MS = 2000;
/** Idle time before the first TCP keepalive probe, so a dead peer is noticed in about a minute. */
const KEEPALIVE_INITIAL_DELAY_MS = 10000;

function poolConfig(url: string, name: PoolName, settings: PoolSettings): PoolConfig {
  return {
    connectionString: url,
    min: settings.DB_POOL_MIN,
    max: settings.DB_POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    query_timeout: settings.DB_STATEMENT_TIMEOUT_MS + CLIENT_QUERY_GRACE_MS,
    application_name: `mulapay-core:${settings.APP_ROLE}:${name}`,
  };
}

function createPool(url: string, name: PoolName, settings: PoolSettings, logger: Logger): Pool {
  const pool = new Pool(poolConfig(url, name, settings));
  // An idle client error must not crash the process; the pool discards the client.
  pool.on('error', (error) => {
    logger.error({ pool: name, err: toLoggableError(error) }, 'idle database client error');
  });
  // pg-pool drops its own `error` listener while a client is checked out. A connection that dies
  // mid-transaction (a failover, a crash, a killed backend) then emits `error` with no listener,
  // which Node raises as an uncaught exception, and `runProcess` exits the process on one. Every
  // client keeps a listener for its whole life: the failure reaches the caller as a rejected query,
  // which is where it belongs, and is logged here without the connection details.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.warn({ pool: name, err: toLoggableError(error) }, 'database client error');
    });
  });
  return pool;
}

export function createDatabasePools(settings: PoolSettings, logger: Logger): DatabasePools {
  const rw = createPool(settings.DATABASE_URL, 'rw', settings, logger);
  const ro = createPool(settings.DATABASE_RO_URL, 'ro', settings, logger);
  let replica = rw;
  if (settings.DATABASE_REPLICA_URL) {
    replica = createPool(settings.DATABASE_REPLICA_URL, 'replica', settings, logger);
  } else {
    logger.warn('DATABASE_REPLICA_URL is not set; replica reads use the primary rw pool');
  }
  return { rw, ro, replica };
}

export async function closeDatabasePools(pools: DatabasePools): Promise<void> {
  const unique = new Set<Pool>([pools.rw, pools.ro, pools.replica]);
  await Promise.all([...unique].map((pool) => pool.end()));
}

export function poolStats(
  pools: DatabasePools
): Array<{ pool: PoolName; total: number; idle: number; waiting: number }> {
  const entries: Array<[PoolName, Pool]> = [
    ['rw', pools.rw],
    ['ro', pools.ro],
  ];
  if (pools.replica !== pools.rw) entries.push(['replica', pools.replica]);
  return entries.map(([pool, p]) => ({
    pool,
    total: p.totalCount,
    idle: p.idleCount,
    waiting: p.waitingCount,
  }));
}
