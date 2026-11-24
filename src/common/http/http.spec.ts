import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { corsOptionsFor } from './cors';
import { toFastifySchema, toOpenApiSchema } from './json-schema';
import { generateRequestId, isAcceptableRequestId } from './request-id';
import { docsCsp } from './security-headers';
import { resolveSurface } from './surface';

describe('resolveSurface', () => {
  it.each([
    ['/v1/health', 'infra'],
    ['/v1/health/ready', 'infra'],
    ['/metrics', 'infra'],
    ['/v1/status?x=1', 'infra'],
    ['/v1/payments', 'public'],
    ['/v1', 'public'],
    ['/merchant/v1/auth/login', 'dashboard'],
    ['/admin/v1/merchants', 'admin'],
    ['/docs/public/', 'docs'],
    ['/v10/payments', 'unknown'],
    ['/', 'unknown'],
  ])('%s -> %s', (url, surface) => {
    expect(resolveSurface(url)).toBe(surface);
  });
});

describe('request ids', () => {
  it('accepts safe ids from the edge', () => {
    expect(generateRequestId({ headers: { 'x-request-id': '01JBX7ABCDEF' } })).toBe('01JBX7ABCDEF');
  });

  it.each(['short', 'has space inside', 'x'.repeat(129), 'inject\nline', undefined])(
    'replaces %j with a generated id',
    (value) => {
      const id = generateRequestId({ headers: { 'x-request-id': value } });
      expect(id).not.toBe(value);
      expect(isAcceptableRequestId(id)).toBe(true);
    }
  );

  it('ignores repeated headers', () => {
    const id = generateRequestId({ headers: { 'x-request-id': ['a1234567', 'b1234567'] } });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('corsOptionsFor', () => {
  const config = {
    CORS_DASHBOARD_ORIGINS: ['https://dashboard.mulapay.com'],
    CORS_ADMIN_ORIGINS: ['https://admin.mulapay.com'],
  };

  it('allows no browser origin on the public API', () => {
    expect(corsOptionsFor('/v1/payments', config)).toEqual({ origin: false });
    expect(corsOptionsFor('/v1/health', config)).toEqual({ origin: false });
  });

  it('allows only the configured origins per surface', () => {
    expect(corsOptionsFor('/merchant/v1/me', config)).toMatchObject({
      origin: ['https://dashboard.mulapay.com'],
      credentials: true,
    });
    expect(corsOptionsFor('/admin/v1/x', config)).toMatchObject({
      origin: ['https://admin.mulapay.com'],
    });
    expect(corsOptionsFor('/admin/v1/x', { ...config, CORS_ADMIN_ORIGINS: [] })).toEqual({
      origin: false,
    });
  });
});

describe('json schema conversion', () => {
  const schema = z.object({ status: z.enum(['ok']), count: z.number().int() });

  it('produces draft-07 schemas for Fastify without $schema', () => {
    const json = toFastifySchema(schema);
    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'count'],
    });
  });

  it('produces OpenAPI 3.0 schemas for the docs', () => {
    expect(toOpenApiSchema(z.literal(true))).toMatchObject({ type: 'boolean', enum: [true] });
  });

  it('refuses schemas JSON cannot represent', () => {
    expect(() => toFastifySchema(z.bigint())).toThrow();
  });
});

describe('docsCsp', () => {
  it('allows scripts and styles only from self with the nonce', () => {
    const csp = docsCsp('abc');
    expect(csp).toContain("script-src 'self' 'nonce-abc'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });
});
