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
 */
export async function runInTransaction<T>(
  db: Database,
  timeouts: TransactionTimeouts,
  work: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const statementTimeout = String(options.statementTimeoutMs ?? timeouts.statementTimeoutMs);
  const idleTimeout = String(timeouts.idleInTransactionTimeoutMs);
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${statementTimeout}, true), set_config('idle_in_transaction_session_timeout', ${idleTimeout}, true)`
      );
      return work(tx);
    },
    { isolationLevel: options.isolationLevel ?? 'read committed' }
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
