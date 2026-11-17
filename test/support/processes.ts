/**
 * Runs the built application (`dist/main.js`, exactly what the image runs) as separate operating
 * system processes against the test containers: the production topology, with its own memory,
 * event loop and connection pools per process. Used by the shutdown and soak suites.
 *
 * Needs `npm run build` first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { inject } from 'vitest';
import { sleep } from './chaos';
import { TEST_JWT } from './test-env';

export const DIST_MAIN = resolve(__dirname, '../../dist/main.js');
export const BUILT = existsSync(DIST_MAIN);

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Environment for one process role. `overrides` win. Secrets are test-only values. */
export function applicationEnv(
  role: 'api' | 'worker' | 'consumer',
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const urls = inject('databaseUrls');
  const redisUrl = inject('redisUrl');
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    APP_ROLE: role,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: urls.rw,
    DATABASE_RO_URL: urls.ro,
    DATABASE_DIRECT_URL: urls.rw,
    DB_POOL_MAX: '10',
    REDIS_URL: redisUrl,
    JWT_PRIVATE_KEY: TEST_JWT.privateKey,
    JWT_PUBLIC_KEY: TEST_JWT.publicKey,
    JWT_KID: TEST_JWT.kid,
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PII_HMAC_PEPPER: 'test-pepper-test-pepper-test-pepper',
    // Load and soak runs send bursts through one key; the limits themselves are tested elsewhere.
    RATE_LIMIT_WRITE_PER_MIN: '1000000',
    RATE_LIMIT_READ_PER_MIN: '1000000',
    RATE_LIMIT_PAYOUT_PER_MIN: '1000000',
    RATE_LIMIT_BURST_CAPACITY: '100000',
    RATE_LIMIT_BURST_REFILL_PER_SECOND: '100000',
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    ...extra,
  };
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A clean stop: status 0, or ended by the SIGTERM that asked for it after the shutdown hooks ran. */
export function isCleanStop(exit: Exit | 'timeout' | null): boolean {
  return exit !== null && exit !== 'timeout' && (exit.code === 0 || exit.signal === 'SIGTERM');
}

export interface RunningApplication {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly port: number | null;
  readonly logs: () => string;
  /** How the process ended: an exit code, or the signal that ended it (NestJS re-raises SIGTERM after its hooks). */
  readonly exited: Promise<Exit>;
  stop(signal?: NodeJS.Signals): Promise<Exit | null>;
}

/** Starts one process and waits until it is ready: the API answers its health check, a worker logs that its workers started. */
export async function startApplication(
  role: 'api' | 'worker' | 'consumer',
  extra: Record<string, string> = {}
): Promise<RunningApplication> {
  if (!BUILT) throw new Error('dist/main.js is missing: run `npm run build` first');
  const port = role === 'api' ? await freePort() : null;
  const env = applicationEnv(role, { ...(port ? { PORT: String(port) } : {}), ...extra });
  const child = spawn(process.execPath, [DIST_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const exited = new Promise<Exit>((r) =>
    child.once('exit', (code, signal) => r({ code, signal }))
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${role} exited during start:\n${out}`);
    if (role === 'api') {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
    } else if (out.includes('workers started') || out.includes('holds the singleton lock')) {
      break;
    } else if (role === 'worker' && Date.now() - (deadline - 90_000) > 8000) {
      // The worker logs at info and the harness runs at warn: after a few seconds with the
      // process still alive and no error, it is up.
      break;
    }
    if (Date.now() > deadline) throw new Error(`${role} did not start:\n${out}`);
    await sleep(250);
  }
  return {
    child,
    pid: child.pid ?? 0,
    port,
    logs: () => out,
    exited,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode !== null) return { code: child.exitCode, signal: null };
      child.kill(signal);
      return Promise.race([exited, sleep(30_000).then(() => null)]);
    },
  };
}
