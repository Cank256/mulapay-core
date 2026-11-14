import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';

const TOKEN = 'metrics-test-token-0123456789';

describe('GET /metrics', () => {
  it('is not registered without METRICS_TOKEN', async () => {
    const app = await createTestApp(testConfig());
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  describe('with METRICS_TOKEN', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await createTestApp(testConfig({ METRICS_TOKEN: TOKEN }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('rejects missing or wrong bearer tokens', async () => {
      for (const headers of [{}, { authorization: 'Bearer wrong-token-0123456789abcd' }]) {
        const res = await app.inject({ method: 'GET', url: '/metrics', headers });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHORIZED');
      }
    });

    it('exposes infrastructure metrics in Prometheus format', async () => {
      await app.inject({ method: 'GET', url: '/v1/health' });
      await app.inject({ method: 'GET', url: '/v1/does-not-exist/abc123' });

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const body = res.body;
      expect(body).toMatch(
        /core_http_request_duration_seconds_count\{[^}]*surface="infra",method="GET",route="\/v1\/health",status_code="200"[,}]/
      );
      // Unknown URLs never become label values.
      expect(body).toContain('route="unmatched"');
      expect(body).not.toContain('abc123');
      expect(body).toMatch(/core_db_pool_connections\{[^}]*pool="rw",state="total"[,}]/);
      expect(body).toMatch(/core_db_pool_connections\{[^}]*pool="ro",state="idle"[,}]/);
      expect(body).toMatch(/core_queue_depth\{[^}]*queue="outbox-dispatch"[,}]/);
      expect(body).toMatch(/core_queue_oldest_job_seconds\{[^}]*queue="dead-letter"[,}]/);
      expect(body).toContain('process_cpu_user_seconds_total');
      expect(body).toContain('service="mulapay-core"');
    });
  });
});
