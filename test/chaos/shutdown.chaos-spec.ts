/**
 * Graceful shutdown of the built application (`dist/`, as the image runs it). A rolling deploy,
 * a scale-in and a node drain all send SIGTERM; a payments API must finish the requests it has
 * accepted before it exits, or a client sees a reset on a request that may already have
 * committed.
 *
 * The test sends a request whose body is only half written, sends SIGTERM while the server is
 * still waiting for the rest, then completes the request. A server that stops at once drops it; a
 * server that drains answers it and then exits with status 0.
 *
 * Needs `npm run build` first.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sleep } from '../support/chaos';
import {
  BUILT,
  isCleanStop,
  startApplication,
  type RunningApplication,
} from '../support/processes';

let running: RunningApplication | undefined;

afterEach(() => {
  if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
  running = undefined;
});

describe.skipIf(!BUILT)('graceful shutdown of the API process', () => {
  it('finishes an accepted request after SIGTERM, then exits with status 0', async () => {
    const api = (running = await startApplication('api'));
    // A request the server has accepted but not finished: headers sent, half the body outstanding.
    const body = JSON.stringify({ email: 'nobody@example.com', password: 'x'.repeat(16) });
    const half = Math.floor(body.length / 2);
    const socket = connect(api.port ?? 0, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      `POST /dashboard/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`
    );
    await sleep(500);

    api.child.kill('SIGTERM');
    await sleep(500);
    // Still running: it is draining, not dead.
    expect(api.child.exitCode, api.logs()).toBeNull();

    // The client finishes its request; the server answers it.
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(body.slice(half));
    await Promise.race([closed, sleep(15_000)]);
    expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 \d{3}/);
    const code = await Promise.race([api.exited, sleep(30_000).then(() => 'timeout' as const)]);
    expect(isCleanStop(code), api.logs()).toBe(true);
  }, 120_000);

  it('exits promptly with status 0 on SIGTERM when idle', async () => {
    const api = (running = await startApplication('api'));
    const started = Date.now();
    api.child.kill('SIGTERM');
    const code = await Promise.race([api.exited, sleep(20_000).then(() => 'timeout' as const)]);
    expect(isCleanStop(code), api.logs()).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);

  it('a worker finishes and exits with status 0 on SIGTERM', async () => {
    const worker = (running = await startApplication('worker', {
      QUEUE_PREFIX: 'shutdown-worker',
    }));
    const started = Date.now();
    worker.child.kill('SIGTERM');
    const code = await Promise.race([worker.exited, sleep(30_000).then(() => 'timeout' as const)]);
    expect(isCleanStop(code), worker.logs()).toBe(true);
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 120_000);
});
