/**
 * Transaction boundary for application services (spec section 4.3).
 *
 * Every transaction applies DB_STATEMENT_TIMEOUT_MS and DB_IDLE_TX_TIMEOUT_MS with
 * `set_config(..., true)`, which is transaction-scoped and therefore safe behind PgBouncer
 * in transaction mode.
 *
 * Rules for callers: keep the callback short and never perform HTTP, S3 or queue calls
 * inside it (spec section 9.2 rule 9). Write to the outbox instead.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../../db/schema';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../tokens';
import type { Database, Transaction } from './database.types';
import { DB_RW } from './tokens';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly statementTimeoutMs?: number;
}

export interface TransactionTimeouts {
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

/**
 * Runs `work` in one transaction on `db`. Commits when `work` resolves and rolls back when
 * it throws; the error is rethrown unchanged.
 *
 * This function checks the connection out of the pool and releases it itself. drizzle-orm
 * (0.45.4) does both inside `transaction()`, but issues `begin` before its `try/finally`, so a
 * connection that looked healthy at checkout and failed on that first statement was never
 * released: one pool slot lost per failure, and `pool.end()` waiting for it for ever. After a
 * database crash that made `app.close()` hang (Phase 9 finding DB-4). Here the release is in a
 * `finally` that covers `begin`. A dead client released this way is dropped by the pool (pg-pool
 * discards a client that is no longer queryable), so a live one is never handed out twice.
 */
export async function runInTransaction<T>(
  db: Database,
  timeouts: TransactionTimeouts,
  work: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const statementTimeout = String(options.statementTimeoutMs ?? timeouts.statementTimeoutMs);
  const idleTimeout = String(timeouts.idleInTransactionTimeoutMs);
  const run = async (scoped: Database): Promise<T> =>
    scoped.transaction(
      async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', ${statementTimeout}, true), set_config('idle_in_transaction_session_timeout', ${idleTimeout}, true)`
        );
        return work(tx);
      },
      { isolationLevel: options.isolationLevel ?? 'read committed' }
    );
  const pool = (db as { $client?: unknown }).$client;
  // Only a pool can be owned this way; anything else (a single client) is not ours to release.
  if (!isPool(pool)) return run(db);
  const client = await pool.connect();
  try {
    return await run(drizzle({ client, schema }));
  } finally {
    client.release();
  }
}

function isPool(client: unknown): client is Pool {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as { connect?: unknown }).connect === 'function' &&
    typeof (client as { totalCount?: unknown }).totalCount === 'number'
  );
}
@Injectable()
export class UnitOfWork {
  private readonly timeouts: TransactionTimeouts;

  constructor(
    @Inject(DB_RW) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig
  ) {
    this.timeouts = {
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DB_IDLE_TX_TIMEOUT_MS,
    };
  }

  run<T>(work: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return runInTransaction(this.db, this.timeouts, work, options);
  }
}
