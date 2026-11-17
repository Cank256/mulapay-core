/**
 * The worker and consumer answer health probes (P9-RDY-1). Only the api role served HTTP, so an
 * orchestrator could not tell a hung worker from a healthy one. This starts the built worker and
 * consumer (what the image runs) and checks the listener, then the container healthcheck script
 * against it.
 *
 * Needs `npm run build` first.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sleep } from '../support/chaos';
import {
  BUILT,
  freePort,
  isCleanStop,
  startApplication,
  type RunningApplication,
} from '../support/processes';

const HEALTHCHECK = resolve(__dirname, '../../dist/scripts/healthcheck.js');
let running: RunningApplication | undefined;
afterEach(() => {
  if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
  running = undefined;
});

async function ready(port: number): Promise<Response> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health/ready`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('health listener never answered');
}

// LOG_LEVEL=info: the harness recognises a started consumer by its lock log line.
describe.skipIf(!BUILT).each(['worker', 'consumer'] as const)(
  'health listener of the %s process',
  (role) => {
    it('answers liveness and readiness, and the image healthcheck script passes', async () => {
      const port = await freePort();
      running = await startApplication(role, { HEALTH_PORT: String(port), LOG_LEVEL: 'info' });
      const readiness = await ready(port);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toEqual({ status: 'ready' });
      const liveness = await fetch(`http://127.0.0.1:${port}/health`);
      expect(liveness.status).toBe(200);
      const script = spawnSync(process.execPath, [HEALTHCHECK], {
        env: { APP_ROLE: role, HEALTH_PORT: String(port) },
      });
      expect(script.status).toBe(0);
      expect(isCleanStop(await running.stop())).toBe(true);
    }, 120_000);

    it('fails the healthcheck script once the process is gone', async () => {
      const port = await freePort();
      running = await startApplication(role, { HEALTH_PORT: String(port), LOG_LEVEL: 'info' });
      expect((await ready(port)).status).toBe(200);
      await running.stop();
      const script = spawnSync(process.execPath, [HEALTHCHECK], {
        env: { APP_ROLE: role, HEALTH_PORT: String(port) },
      });
      expect(script.status).toBe(1);
    }, 120_000);
  }
);
