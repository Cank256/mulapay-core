/**
 * Cross-cutting HTTP behaviour through the real Fastify + Nest stack: envelope, error
 * catalogue, validation, request ids, response-schema allowlisting, security headers,
 * CORS per surface and log correlation.
 */
import { Body, Controller, Get, Inject, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createZodDto } from 'nestjs-zod';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Public } from '../../src/common/authz/policy.decorators';
import { AppError } from '../../src/common/errors/app-error';
import { ApiEnvelopedResponses } from '../../src/common/http/response-schema.decorator';
import { ROOT_LOGGER } from '../../src/common/tokens';
import { captureLogs, type CapturedLogs } from '../support/log-capture';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';

const createSchema = z.strictObject({
  amount: z.string().regex(/^\d+$/),
  currency: z.string().length(3),
});
class CreateDto extends createZodDto(createSchema) {}
const resultSchema = z.object({ amount: z.string(), currency: z.string() });

@Public()
@Controller('__test')
class FoundationTestController {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  @Post('echo')
  @ApiEnvelopedResponses({ 201: resultSchema })
  echo(@Body() body: CreateDto) {
    // The response schema must strip fields it does not declare.
    return { ...body, internalSecret: 'must-not-leak' };
  }

  @Get('boom')
  boom(): never {
    throw new Error('connect to 10.0.0.5 failed: password=hunter2');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new AppError('FORBIDDEN');
  }

  @Get('log')
  @ApiEnvelopedResponses({ 200: z.object({ ok: z.boolean() }) })
  log() {
    this.logger.info('inside handler');
    return { ok: true };
  }
}

@Module({ controllers: [FoundationTestController] })
class FoundationTestModule {}

const DASHBOARD_ORIGIN = 'https://dashboard.example.com';

describe('HTTP foundation', () => {
  let app: NestFastifyApplication;
  let logs: CapturedLogs;

  beforeAll(async () => {
    const config = testConfig({ CORS_DASHBOARD_ORIGINS: DASHBOARD_ORIGIN });
    logs = captureLogs(config, 'debug');
    app = await createTestApp(config, {
      extraImports: [FoundationTestModule],
      logger: logs.logger,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('success envelope', () => {
    it('wraps data with the requestId and serializes only declared fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        payload: { amount: '1000', currency: 'UGX' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        success: true,
        data: { amount: '1000', currency: 'UGX' },
        meta: { requestId: res.headers['x-request-id'] },
      });
      expect(res.body).not.toContain('must-not-leak');
    });
  });

  describe('error envelope', () => {
    it('returns 400 VALIDATION_FAILED with a per-field list', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        payload: { amount: 10, currency: 'UGXX' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          requestId: res.headers['x-request-id'],
          docUrl: 'https://docs.mulapay.com/errors/validation_failed',
        },
      });
      expect(body.error.details.fields.map((f: { path: string }) => f.path)).toEqual([
        'amount',
        'currency',
      ]);
    });

    it('rejects unknown properties', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        payload: { amount: '1', currency: 'UGX', extra: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.fields[0].code).toBe('unrecognized_keys');
    });

    it('returns 400 INVALID_REQUEST for malformed JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"amount":',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
    });

    it('returns 413 above the 256 KB body limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ amount: '1', currency: 'UGX', pad: 'x'.repeat(256 * 1024) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('returns 415 for unsupported content types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 404 NOT_FOUND for unknown routes on every surface', async () => {
      for (const url of ['/v1/nope', '/dashboard/v1/nope', '/admin/v1/nope', '/nope']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'The requested resource was not found',
            requestId: res.headers['x-request-id'],
            docUrl: 'https://docs.mulapay.com/errors/not_found',
          },
        });
      }
    });

    it('maps AppError through the catalogue', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/forbidden' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('returns a generic 500 and logs the detail internally', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.',
        requestId: res.headers['x-request-id'],
        docUrl: 'https://docs.mulapay.com/errors/internal_error',
      });
      expect(res.body).not.toMatch(/hunter2|10\.0\.0\.5|stack/);

      const line = logs.lines.find(
        (l) => l.msg === 'request failed' && l.requestId === res.headers['x-request-id']
      );
      expect(line).toMatchObject({ level: 50, errorCode: 'INTERNAL_ERROR', surface: 'unknown' });
      expect(JSON.stringify(line)).toContain('hunter2');
    });
  });

  describe('request ids', () => {
    it('echoes an acceptable X-Request-Id from the edge', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: { 'x-request-id': 'edge-0123456789' },
      });
      expect(res.headers['x-request-id']).toBe('edge-0123456789');
    });

    it('replaces an unsafe X-Request-Id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: { 'x-request-id': 'bad id with spaces' },
      });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('puts requestId and surface on log lines written inside a handler', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/log' });
      const id = res.headers['x-request-id'];
      const handlerLine = logs.lines.find((l) => l.msg === 'inside handler' && l.requestId === id);
      const completion = logs.lines.find(
        (l) => l.msg === 'request completed' && l.requestId === id
      );
      expect(handlerLine).toMatchObject({ requestId: id, surface: 'unknown' });
      expect(completion).toMatchObject({ route: '/__test/log', statusCode: 200, method: 'GET' });
      // Exactly one requestId key per line (no duplicate child binding).
      const raw = logs.raw.find((r) => r.includes('"inside handler"') && r.includes(String(id)));
      expect(raw?.match(/"requestId"/g)).toHaveLength(1);
    });
  });

  describe('security headers', () => {
    it('sets helmet headers and no Server header', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers.server).toBeUndefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    const preflight = (url: string, origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url,
        headers: { origin, 'access-control-request-method': 'GET' },
      });

    it('allows no browser origin on the public API', async () => {
      const res = await preflight('/v1/health', DASHBOARD_ORIGIN);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows the configured dashboard origin on the dashboard surface only', async () => {
      const ok = await preflight('/dashboard/v1/anything', DASHBOARD_ORIGIN);
      expect(ok.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
      expect(ok.headers['access-control-allow-credentials']).toBe('true');

      const other = await preflight('/dashboard/v1/anything', 'https://evil.example.com');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();

      const admin = await preflight('/admin/v1/anything', DASHBOARD_ORIGIN);
      expect(admin.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
