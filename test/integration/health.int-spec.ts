/**
 * Phase 0 exit criterion: GET /v1/health/ready passes against real containers, and fails
 * closed (503) when any dependency is unavailable.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGateway, type FakeGateway } from '../support/fake-gateway';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';
import { inject } from 'vitest';

describe('health endpoints', () => {
  let gateway: FakeGateway;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    gateway = await startFakeGateway();
    app = await createTestApp(testConfig({ GATEWAY_BASE_URL: gateway.baseUrl }));
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
  });

  it('GET /v1/health reports liveness without dependency checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /v1/health/ready is ready when Postgres (rw, ro), Redis and the gateway are up', async () => {
    gateway.readyStatus = 200;
    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('is not ready when the gateway reports not ready', async () => {
    gateway.readyStatus = 503;
    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
    gateway.readyStatus = 200;
  });

  it('is not ready when the gateway hangs past the check timeout', async () => {
    gateway.delayMs = 3000;
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    gateway.delayMs = 0;
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2900);
  });
});

describe('readiness with failing dependencies', () => {
  it('is ready without a gateway URL outside production', async () => {
    const app = await createTestApp(testConfig());
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('is not ready when Redis is unreachable', async () => {
    const app = await createTestApp(testConfig({ REDIS_URL: 'redis://127.0.0.1:1' }));
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'not_ready' });
    } finally {
      await app.close();
    }
  });

  it('is not ready when the ro database role cannot connect', async () => {
    const bad = inject('databaseUrls').ro.replace(/:[^:@/]+@/, ':wrong-password@');
    const app = await createTestApp(testConfig({ DATABASE_RO_URL: bad }));
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(res.statusCode).toBe(503);
      // The body never says which dependency failed or why.
      expect(res.body).not.toMatch(/password|database|ro/i);
    } finally {
      await app.close();
    }
  });
});
