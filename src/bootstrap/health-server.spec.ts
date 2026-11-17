import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHealthServer, type HealthServer } from './health-server';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;
let server: HealthServer | undefined;

async function start(probes: Parameters<typeof startHealthServer>[0]['probes'], timeoutMs = 200) {
  server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    probes,
    logger: logger(),
    timeoutMs,
  });
  return `http://127.0.0.1:${server.port}`;
}
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('worker and consumer health listener (P9-RDY-1)', () => {
  it('answers liveness without running any check', async () => {
    const run = vi.fn();
    const base = await start([{ name: 'database_rw', run }]);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(run).not.toHaveBeenCalled();
  });
  it('is ready when every check passes', async () => {
    const base = await start([
      { name: 'database_rw', run: async () => undefined },
      { name: 'redis', run: async () => true },
    ]);
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });
  it.each([
    ['rejects', () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432'))],
    ['returns false', () => Promise.resolve(false)],
    ['hangs', () => new Promise<void>(() => undefined)],
  ])('is not ready when a check %s, and the reply names nothing', async (_name, run) => {
    const base = await start([
      { name: 'redis', run: async () => true },
      { name: 'database_rw', run },
    ]);
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: 'not_ready' });
    expect(text).not.toMatch(/database|ECONNREFUSED|10\.0/);
  });
  it('serves nothing else and only answers GET', async () => {
    const base = await start([]);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });
});
