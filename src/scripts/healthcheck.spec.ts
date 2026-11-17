import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { healthcheckTarget, probe } from './healthcheck';

describe('container healthcheck', () => {
  it('probes the api on PORT and the other roles on HEALTH_PORT', () => {
    expect(healthcheckTarget({})).toEqual({ port: 4000, path: '/v1/health' });
    expect(healthcheckTarget({ APP_ROLE: 'api', PORT: '5000' })).toEqual({
      port: 5000,
      path: '/v1/health',
    });
    for (const role of ['worker', 'consumer']) {
      expect(healthcheckTarget({ APP_ROLE: role })).toEqual({ port: 4001, path: '/health' });
      expect(healthcheckTarget({ APP_ROLE: role, HEALTH_PORT: '4100' }).port).toBe(4100);
    }
  });
  it('is healthy on a 200 and unhealthy on anything else or no listener', async () => {
    let status = 200;
    const server = createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = String((server.address() as AddressInfo).port);
    const env = { APP_ROLE: 'worker', HEALTH_PORT: port };
    try {
      expect(await probe(env)).toBe(true);
      status = 503;
      expect(await probe(env)).toBe(false);
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(await probe(env, 500)).toBe(false);
  });
});
