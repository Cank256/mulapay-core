/**
 * Process-singleton lock on a dedicated, direct (non-PgBouncer) connection (spec 4.1).
 *
 * Invariant: while `onLost` has not fired, this process holds the lock. The lock is a
 * session-level advisory lock, so it lives exactly as long as the connection. The
 * connection is watched three ways: socket errors, socket end, and a periodic query
 * confirming the lock is still granted to this backend. Any failure fires `onLost` once;
 * the caller must stop work immediately, because another instance may now acquire it.
 */
import { Client } from 'pg';
import type { Logger } from 'pino';
import { toLoggableError } from '../logging/redaction';

export interface SingletonLock {
  readonly name: string;
  release(): Promise<void>;
}

export interface SingletonLockOptions {
  readonly connectionString: string;
  readonly lockName: string;
  readonly applicationName: string;
  readonly logger: Logger;
  readonly onLost: (reason: Error) => void;
  readonly verifyIntervalMs?: number;
}

const DEFAULT_VERIFY_INTERVAL_MS = 5000;

/** Returns the lock, or null if another session already holds it. */
export async function tryAcquireSingletonLock(
  options: SingletonLockOptions
): Promise<SingletonLock | null> {
  const client = new Client({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    keepAlive: true,
  });
  await client.connect();

  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as acquired',
      [options.lockName]
    );
    acquired = result.rows[0]?.acquired === true;
  } finally {
    if (!acquired) await client.end().catch(() => undefined);
  }
  if (!acquired) return null;

  let releasing = false;
  let lost = false;
  const markLost = (reason: Error) => {
    if (releasing || lost) return;
    lost = true;
    clearInterval(timer);
    options.logger.error(
      { lock: options.lockName, err: toLoggableError(reason) },
      'singleton lock lost'
    );
    options.onLost(reason);
  };

  const timer = setInterval(() => {
    client
      .query<{ held: boolean }>(
        `select exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted) as held`
      )
      .then((r) => {
        if (r.rows[0]?.held !== true) markLost(new Error('advisory lock no longer held'));
      })
      .catch((error: unknown) =>
        markLost(error instanceof Error ? error : new Error(String(error)))
      );
  }, options.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS);
  timer.unref();

  // Registered after `timer` exists, so markLost never sees it uninitialised.
  client.on('error', (error) => markLost(error));
  client.on('end', () => markLost(new Error('lock connection ended')));

  return {
    name: options.lockName,
    async release() {
      if (releasing) return;
      releasing = true;
      clearInterval(timer);
      try {
        if (!lost) {
          await client.query('select pg_advisory_unlock(hashtext($1))', [options.lockName]);
        }
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
