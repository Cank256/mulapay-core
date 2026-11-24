import { randomUUID } from 'node:crypto';
/**
 * OpenAPI documents per surface, the Scalar docs routes and their CSP, and that the
 * worker and consumer process modules boot and shut down cleanly.
 */
import { NestFactory } from '@nestjs/core';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocuments } from '../../src/common/openapi/openapi';
import { ConsumerModule } from '../../src/consumer.module';
import { WorkerModule } from '../../src/worker.module';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';

const logger = pino({ level: 'silent' });

describe('API docs', () => {
  it('builds one document per surface, each holding only its own routes', async () => {
    const app = await createTestApp(testConfig());
    try {
      const docs = buildOpenApiDocuments(app);
      expect(Object.keys(docs).sort()).toEqual(['admin', 'dashboard', 'public']);
      expect(Object.keys(docs.public.paths).sort()).toEqual([
        '/v1/balance-transactions',
        '/v1/balances',
        '/v1/checkout-sessions',
        '/v1/checkout-sessions/{ref}',
        '/v1/checkout-sessions/{ref}/expire',
        '/v1/events',
        '/v1/events/{ref}',
        '/v1/health',
        '/v1/health/ready',
        '/v1/holds',
        '/v1/payment-links',
        '/v1/payment-links/{ref}',
        '/v1/payment-links/{ref}/deactivate',
        '/v1/payments',
        '/v1/payments/{ref}',
        '/v1/payments/{ref}/cancel',
        '/v1/payments/{ref}/timeline',
        '/v1/ping',
        '/v1/settlements',
        '/v1/settlements/{ref}',
        '/v1/settlements/{ref}/items',
        '/v1/status',
        '/v1/transactions',
        '/v1/transactions/{ref}',
        '/v1/webhook-endpoints',
        '/v1/webhook-endpoints/{ref}',
        '/v1/webhook-endpoints/{ref}/rotate-secret',
      ]);
      const dashboardPaths = Object.keys(docs.dashboard.paths);
      const adminPaths = Object.keys(docs.admin.paths);
      expect(dashboardPaths).toContain('/merchant/v1/auth/login');
      expect(dashboardPaths).toContain('/merchant/v1/api-keys');
      expect(adminPaths).toContain('/admin/v1/merchants');
      expect(adminPaths).toContain('/admin/v1/audit-logs/verify');
      expect(dashboardPaths.every((p) => p.startsWith('/merchant/v1/'))).toBe(true);
      expect(adminPaths.every((p) => p.startsWith('/admin/v1/'))).toBe(true);
      expect(JSON.stringify(docs.public)).not.toContain('/metrics');
    } finally {
      await app.close();
    }
  });

  it('serves Scalar and the JSON per surface with a nonce-based CSP when enabled', async () => {
    const app = await createTestApp(testConfig({ ENABLE_API_DOCS: 'true' }));
    try {
      const page = await app.inject({ method: 'GET', url: '/docs/public/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      const csp = String(page.headers['content-security-policy']);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeDefined();
      expect(page.body).toContain(`nonce="${nonce}"`);
      expect(csp).not.toContain('unsafe-inline');

      const json = await app.inject({ method: 'GET', url: '/docs/admin/openapi.json' });
      expect(json.statusCode).toBe(200);
      expect(json.json().info.title).toBe('MulaPay Admin API');
    } finally {
      await app.close();
    }
  });

  it('does not serve docs when disabled', async () => {
    const app = await createTestApp(testConfig({ ENABLE_API_DOCS: 'false' }));
    try {
      const res = await app.inject({ method: 'GET', url: '/docs/public/' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('process modules', () => {
  it('boots and closes the worker process module', async () => {
    // The worker shares a database with the other suites, so it runs without the repeating
    // jobs and under its own queue prefix: it must not act on rows or jobs that are not its.
    const config = testConfig({
      APP_ROLE: 'worker',
      QUEUE_PREFIX: `boot-test-${randomUUID().slice(0, 8)}`,
    });
    const app = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, logger, { schedules: false }),
      {
        logger: false,
        abortOnError: false,
      }
    );
    await app.close();
  });

  it('boots and closes the consumer process module', async () => {
    const config = testConfig({ APP_ROLE: 'consumer' });
    const app = await NestFactory.createApplicationContext(ConsumerModule.forRoot(config, logger), {
      logger: false,
      abortOnError: false,
    });
    await app.close();
  });
});
