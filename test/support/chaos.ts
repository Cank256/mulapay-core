/**
 * Helpers for the chaos and disaster-recovery suites (`npm run test:chaos`). They need the Docker CLI
 * and the same `DOCKER_HOST` the Testcontainers run uses; the containers are the ones the chaos
 * global setup started on fixed host ports (test/integration/global-setup.ts).
 */
import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { inject } from 'vitest';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function chaosContainers(): { postgresId: string; redisId: string } {
  const containers = inject('chaosContainers');
  if (!containers) throw new Error('chaos suites run only with CHAOS=1 (npm run test:chaos)');
  return containers;
}

/**
 * SIGKILL: the process gets no chance to flush or roll back, the way a host failure or the OOM
 * killer ends it. Postgres then runs crash recovery from the WAL when it starts again.
 */
export function killContainer(id: string): void {
  docker('kill', '--signal', 'KILL', id);
}

export function startContainer(id: string): void {
  docker('start', id);
}

export function restartContainer(id: string): void {
  docker('restart', '--time', '0', id);
}

export async function waitForPostgres(url: string, timeoutMs = 90_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return Date.now() - started;
    } catch {
      await client.end().catch(() => undefined);
      if (Date.now() - started > timeoutMs) throw new Error('postgres did not come back');
      await sleep(300);
    }
  }
}

export async function waitForRedis(url: string, timeoutMs = 60_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await redis.ping();
      redis.disconnect();
      return Date.now() - started;
    } catch {
      redis.disconnect();
      if (Date.now() - started > timeoutMs) throw new Error('redis did not come back');
      await sleep(300);
    }
  }
}

/**
 * A work queue of `items` processed by `concurrency` loops. A task that throws is passed to
 * `onError` and retried by the caller; this helper only schedules.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        await task(item, index);
      }
    })
  );
}

/** Retries `work` with the same input until it succeeds, counting failures: a redelivering consumer. */
export async function redeliver<T>(
  work: () => Promise<T>,
  options: { deadlineMs: number; onFailure: (error: unknown) => void }
): Promise<T> {
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      options.onFailure(error);
      if (Date.now() > deadline) throw error;
      await sleep(250);
    }
  }
}
