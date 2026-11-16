/**
 * The public API contract (spec 6.11, 7.1, 16; Phase 5): the OpenAPI document is valid and
 * complete for every operation, its examples satisfy its own schemas, real responses satisfy
 * the documented schemas, and the committed document is the one the code generates.
 *
 * Set `OPENAPI_UPDATE=1` to rewrite docs/openapi/*.json from the code (what
 * `npm run openapi:export` does) when a route changes on purpose.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_KEY_SCOPES } from '../../src/common/authz/permissions';
import { ERROR_CATALOGUE } from '../../src/common/errors/catalogue';
import { buildOpenApiDocuments } from '../../src/common/openapi/openapi';
import { UNAUTHENTICATED_PATHS } from '../../src/common/openapi/public-api-document';
import { MERCHANT_EVENT_TYPES } from '../../src/modules/events/domain/event-types';
import {
  createMerchant,
  issueKey,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';

/** A loosely typed JSON object: the OpenAPI document is inspected structurally. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspecting an arbitrary document
type Json = Record<string, any>;

// Built at collection time: the tests below are generated from the document itself.
/** OpenAPI 3.0 spells an exclusive bound `minimum` + `exclusiveMinimum: true`; Ajv wants the number. */
function toDraft7(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft7);
  if (node === null || typeof node !== 'object') return node;
  const copy: Json = {};
  for (const [name, value] of Object.entries(node as Json)) copy[name] = toDraft7(value);
  for (const [exclusive, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (copy[exclusive] === true && typeof copy[bound] === 'number') {
      copy[exclusive] = copy[bound];
      delete copy[bound];
    } else if (copy[exclusive] === false) {
      delete copy[exclusive];
    }
  }
  return copy;
}

async function build() {
  const started = await startDeveloperContext();
  const documents = buildOpenApiDocuments(started.app);
  const validator = new Ajv({ strict: false, allErrors: true });
  addFormats(validator);
  validator.addSchema(toDraft7(JSON.parse(JSON.stringify(documents.public))) as object, 'api');
  return { started, documents, validator };
}
// @ts-expect-error TS1309: vitest compiles test files as ES modules, where top-level await is valid
const built = await build();
const ctx: DeveloperContext = built.started;
const docs = built.documents;
const doc: OpenAPIObject = docs.public;
const ajv = built.validator;

afterAll(async () => {
  await ctx.close();
});

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const escapePointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

function operations(): Array<{ path: string; method: (typeof METHODS)[number]; op: Json }> {
  const out: Array<{ path: string; method: (typeof METHODS)[number]; op: Json }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = (item as Json)[method] as Json | undefined;
      if (op) out.push({ path, method, op });
    }
  }
  return out;
}
const apiOperations = () =>
  operations().filter(({ path }) => !UNAUTHENTICATED_PATHS.some((p) => path.startsWith(p)));

function responseValidator(method: string, path: string, status: number): ValidateFunction {
  const pointer = `api#/paths/${escapePointer(path)}/${method}/responses/${status}/content/application~1json/schema`;
  const validate = ajv.getSchema(pointer);
  if (!validate)
    throw new Error(`no documented ${status} response for ${method.toUpperCase()} ${path}`);
  return validate;
}

function expectValid(validate: ValidateFunction, value: unknown, label: string): void {
  const ok = validate(value);
  expect(ok, `${label}: ${JSON.stringify(validate.errors)}\n${JSON.stringify(value)}`).toBe(true);
}

describe('the document', () => {
  it('is a valid OpenAPI 3 document', async () => {
    const copy = JSON.parse(JSON.stringify(doc)) as OpenAPIObject;
    await expect(SwaggerParser.validate(copy as never)).resolves.toBeDefined();
    expect(doc.openapi).toMatch(/^3\.0\./);
    for (const surface of ['dashboard', 'admin'] as const) {
      await expect(
        SwaggerParser.validate(JSON.parse(JSON.stringify(docs[surface])) as never)
      ).resolves.toBeDefined();
    }
  });

  it('describes authentication, signing, idempotency, rate limits, errors, webhooks and the sandbox', () => {
    const description = doc.info.description ?? '';
    for (const topic of [
      'Authentication',
      'Request signing',
      'Idempotency',
      'Rate limits',
      'Errors',
      'Sandbox',
      'X-MulaPay-Signature',
      'payouts:write',
    ]) {
      expect(description, topic).toContain(topic);
    }
    expect(doc.components?.securitySchemes).toMatchObject({
      bearer: { type: 'http', scheme: 'bearer' },
    });
    const webhooks = (doc as unknown as Json)['x-webhooks'] as Json;
    expect(webhooks.eventTypes).toEqual([...MERCHANT_EVENT_TYPES]);
    expect(Object.keys(webhooks.headers)).toEqual(
      expect.arrayContaining(['MulaPay-Signature', 'MulaPay-Event-Id'])
    );
    expect(String(webhooks.description)).toContain('50 consecutive');
    expect(doc.components?.schemas).toHaveProperty('MerchantEvent');
    expect(doc.components?.schemas).toHaveProperty('ErrorEnvelope');
  });

  it('documents the status feed as unauthenticated', () => {
    const op = (doc.paths['/v1/status'] as Json).get as Json;
    expect(op.security).toBeUndefined();
    expect(op['x-required-scopes']).toBeUndefined();
    expect(Object.keys(op.responses as Json)).toContain('200');
  });
  it('documents every route of the public surface (nothing was left out of the document)', () => {
    const paths = Object.keys(doc.paths);
    for (const expected of [
      '/v1/ping',
      '/v1/status',
      '/v1/payments',
      '/v1/payments/{ref}',
      '/v1/payments/{ref}/cancel',
      '/v1/payments/{ref}/timeline',
      '/v1/payment-links',
      '/v1/checkout-sessions',
      '/v1/transactions',
      '/v1/balances',
      '/v1/balance-transactions',
      '/v1/holds',
      '/v1/events',
      '/v1/events/{ref}',
      '/v1/webhook-endpoints',
      '/v1/webhook-endpoints/{ref}',
      '/v1/webhook-endpoints/{ref}/rotate-secret',
    ]) {
      expect(paths, expected).toContain(expected);
    }
    expect(paths.some((p) => p.includes('__probe'))).toBe(false);
  });

  it.each(apiOperations().map((o) => [`${o.method.toUpperCase()} ${o.path}`, o] as const))(
    '%s states authentication, scope, errors, examples and idempotency',
    (_label, { path, method, op }) => {
      expect(op.security, 'authentication').toEqual([{ bearer: [] }]);
      if (path !== '/v1/ping') {
        const scopes = op['x-required-scopes'] as string[];
        expect(scopes, 'scope').toHaveLength(1);
        expect(API_KEY_SCOPES as readonly string[], 'scope is a defined scope').toContain(
          scopes[0]
        );
        expect(String(op.description)).toContain(`\`${scopes[0]}\``);
      }
      expect(typeof op['x-idempotent']).toBe('boolean');
      const idempotencyHeader = (op.parameters as Json[]).some(
        (p) => p.name === 'Idempotency-Key' && p.required === true
      );
      expect(op['x-idempotent']).toBe(idempotencyHeader);
      expect(op.summary, 'summary').toBeTruthy();

      const responses = op.responses as Json;
      const successStatuses = Object.keys(responses).filter((s) => s.startsWith('2'));
      expect(successStatuses.length, 'a success response').toBeGreaterThan(0);
      for (const status of successStatuses) {
        const content = responses[status].content['application/json'];
        expect(content.schema, `${status} schema`).toBeDefined();
        expect(content.example, `${status} example`).toBeDefined();
        expect(content.example.success).toBe(true);
        expect(responses[status].headers).toHaveProperty('X-RateLimit-Remaining');
      }
      const errorStatuses = Object.keys(responses).filter((s) => !s.startsWith('2'));
      for (const needed of ['401', '429', '500', '503'])
        expect(errorStatuses, `${needed}`).toContain(needed);
      if (op['x-required-scopes']) {
        const forbidden = errorStatuses.flatMap((s) => responses[s]['x-error-codes'] as string[]);
        expect(forbidden, 'FORBIDDEN is documented').toContain('FORBIDDEN');
      }
      if (path.includes('{')) expect(errorStatuses).toContain('404');
      if (op.requestBody || (op.parameters as Json[]).some((p) => p.in === 'query'))
        expect(errorStatuses).toContain('400');
      if (op['x-idempotent']) {
        const codes = errorStatuses.flatMap((s) => responses[s]['x-error-codes'] as string[]);
        for (const code of [
          'IDEMPOTENCY_KEY_REQUIRED',
          'IDEMPOTENCY_KEY_REUSED',
          'REQUEST_IN_PROGRESS',
        ])
          expect(codes).toContain(code);
      }
      for (const status of errorStatuses) {
        const codes = responses[status]['x-error-codes'] as string[];
        expect(codes.length).toBeGreaterThan(0);
        for (const code of codes) {
          expect(ERROR_CATALOGUE, code).toHaveProperty(code);
          expect(String(ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE].httpStatus)).toBe(
            status
          );
          expect(
            responses[status].content['application/json'].examples[code].value.error.code
          ).toBe(code);
        }
      }
      if (['post', 'put', 'patch'].includes(method) && op.requestBody) {
        expect(op.requestBody.content['application/json'].example, 'request example').toBeDefined();
      }
      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        const names = (op.parameters as Json[]).map((p) => p.name ?? p.$ref);
        expect(names.some((n) => String(n).includes('RequestSignature'))).toBe(true);
      }
    }
  );

  it('names the webhook events a route causes', () => {
    const create = (doc.paths['/v1/payments'] as Json).post;
    expect(create['x-webhook-events']).toEqual([
      'payment.created',
      'payment.succeeded',
      'payment.failed',
      'payment.expired',
    ]);
    expect(String(create.description)).toContain('Webhook events');
    expect((doc.paths['/v1/payments/{ref}/cancel'] as Json).post['x-webhook-events']).toEqual([
      'payment.cancelled',
    ]);
    expect((doc.paths['/v1/payments'] as Json).get['x-webhook-events']).toBeUndefined();
  });

  it('documents the idempotency requirement of every route that creates a payment, link or session', () => {
    for (const path of ['/v1/payments', '/v1/payment-links', '/v1/checkout-sessions']) {
      expect((doc.paths[path] as Json).post['x-idempotent'], path).toBe(true);
    }
    expect((doc.paths['/v1/webhook-endpoints'] as Json).post['x-idempotent']).toBe(false);
  });

  it('exposes no internal field in any schema', () => {
    const text = JSON.stringify(doc);
    for (const forbidden of [
      'secretHash',
      'secret_hash',
      'secretEnc',
      'signingSecretEnc',
      'previousSecret',
      'clientSecretHash',
      'request_fingerprint',
      'lockedUntil',
      'dedupeKey',
      'tenant_id',
      'passwordHash',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe('examples satisfy their schemas', () => {
  it.each(apiOperations().map((o) => [`${o.method.toUpperCase()} ${o.path}`, o] as const))(
    '%s',
    (_label, { path, method, op }) => {
      for (const [status, response] of Object.entries(op.responses as Json)) {
        const content = response.content?.['application/json'];
        if (!content) continue;
        if (status.startsWith('2')) {
          expectValid(
            responseValidator(method, path, Number(status)),
            content.example,
            `${status} example`
          );
        } else {
          const validate = ajv.getSchema(
            'api#/components/schemas/ErrorEnvelope'
          ) as ValidateFunction;
          for (const [code, example] of Object.entries(content.examples as Json)) {
            expectValid(validate, example.value, `${status} ${code}`);
          }
        }
      }
      if (op.requestBody) {
        const pointer = `api#/paths/${escapePointer(path)}/${method}/requestBody/content/application~1json/schema`;
        const validate = ajv.getSchema(pointer) as ValidateFunction;
        expectValid(
          validate,
          op.requestBody.content['application/json'].example,
          'request example'
        );
      }
    }
  );
});

describe('real responses satisfy the documented schemas', () => {
  let merchant: DeveloperMerchant;
  let key: IssuedKey;
  const SCOPES = [...API_KEY_SCOPES];

  beforeAll(async () => {
    merchant = await createMerchant(ctx, { active: true, label: 'contract' });
    key = await issueKey(ctx, merchant.owner, { environment: 'test', scopes: SCOPES });
  });

  async function check(
    method: 'get' | 'post' | 'patch' | 'delete',
    template: string,
    url: string,
    expected: number,
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    const res =
      method === 'get'
        ? await key.client.get(url, headers)
        : method === 'post'
          ? await key.client.post(url, body, headers)
          : method === 'patch'
            ? await key.client.patch(url, body)
            : await key.client.delete(url);
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(expected);
    expectValid(
      responseValidator(method, template, expected),
      res.json(),
      `${method.toUpperCase()} ${template} ${expected}`
    );
    return res.json().data as Json;
  }

  it('across payments, links, sessions, transactions, balances, events and webhook endpoints', async () => {
    await check('get', '/v1/ping', '/v1/ping', 200);
    const payment = await check(
      'post',
      '/v1/payments',
      '/v1/payments',
      201,
      { amountMinor: '12000', currency: 'UGX', paymentMethod: { msisdn: '+256700000020' } },
      { 'idempotency-key': 'contract-pay-1' }
    );
    await check('get', '/v1/payments', '/v1/payments', 200);
    await check('get', '/v1/payments/{ref}', `/v1/payments/${payment.id}`, 200);
    await check('get', '/v1/payments/{ref}/timeline', `/v1/payments/${payment.id}/timeline`, 200);
    await check('post', '/v1/payments/{ref}/cancel', `/v1/payments/${payment.id}/cancel`, 200);
    await check('get', '/v1/transactions', '/v1/transactions', 200);
    await check('get', '/v1/transactions/{ref}', `/v1/transactions/${payment.transactionId}`, 200);
    const link = await check(
      'post',
      '/v1/payment-links',
      '/v1/payment-links',
      201,
      { title: 'Pay me', currency: 'UGX', amountMinor: '5000' },
      { 'idempotency-key': 'contract-link-1' }
    );
    await check('get', '/v1/payment-links', '/v1/payment-links', 200);
    await check('get', '/v1/payment-links/{ref}', `/v1/payment-links/${link.id}`, 200);
    await check('patch', '/v1/payment-links/{ref}', `/v1/payment-links/${link.id}`, 200, {
      title: 'Pay me now',
    });
    await check(
      'post',
      '/v1/payment-links/{ref}/deactivate',
      `/v1/payment-links/${link.id}/deactivate`,
      200,
      {}
    );
    const session = await check(
      'post',
      '/v1/checkout-sessions',
      '/v1/checkout-sessions',
      201,
      { amountMinor: '7000', currency: 'UGX' },
      { 'idempotency-key': 'contract-cs-1' }
    );
    await check('get', '/v1/checkout-sessions/{ref}', `/v1/checkout-sessions/${session.id}`, 200);
    await check(
      'post',
      '/v1/checkout-sessions/{ref}/expire',
      `/v1/checkout-sessions/${session.id}/expire`,
      200,
      {}
    );
    await check('get', '/v1/balances', '/v1/balances', 200);
    await check('get', '/v1/balance-transactions', '/v1/balance-transactions', 200);
    await check('get', '/v1/holds', '/v1/holds', 200);
    const events = await check('get', '/v1/events', '/v1/events', 200);
    expect((events.items as unknown[]).length).toBeGreaterThan(0);
    await check('get', '/v1/events/{ref}', `/v1/events/${events.items[0].id}`, 200);
    const receiver = await startReceiver();
    try {
      const endpoint = await check('post', '/v1/webhook-endpoints', '/v1/webhook-endpoints', 201, {
        url: receiver.url,
        enabledEvents: ['*'],
      });
      await check('get', '/v1/webhook-endpoints', '/v1/webhook-endpoints', 200);
      await check(
        'get',
        '/v1/webhook-endpoints/{ref}',
        `/v1/webhook-endpoints/${endpoint.id}`,
        200
      );
      await check(
        'patch',
        '/v1/webhook-endpoints/{ref}',
        `/v1/webhook-endpoints/${endpoint.id}`,
        200,
        { description: 'contract' }
      );
      await check(
        'post',
        '/v1/webhook-endpoints/{ref}/rotate-secret',
        `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`,
        200,
        {}
      );
      await check(
        'delete',
        '/v1/webhook-endpoints/{ref}',
        `/v1/webhook-endpoints/${endpoint.id}`,
        200
      );
    } finally {
      await receiver.close();
    }
  });

  it('and so do the errors: 400, 401, 403, 404, 409 and 429, each with a documented code', async () => {
    const envelope = ajv.getSchema('api#/components/schemas/ErrorEnvelope') as ValidateFunction;
    const noScope = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['events:read'],
    });
    const cases: Array<
      [string, () => Promise<{ statusCode: number; json: () => Json }>, number, string]
    > = [
      ['validation', () => key.client.get('/v1/payments?limit=0'), 400, 'VALIDATION_FAILED'],
      [
        'missing idempotency key',
        () =>
          key.client.post('/v1/payments', {
            amountMinor: '1000',
            currency: 'UGX',
            paymentMethod: { msisdn: '+256700000021' },
          }),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      ],
      [
        'no key',
        () =>
          new (key.client.constructor as typeof import('../support/identity').Client)(ctx.app).get(
            '/v1/payments'
          ),
        401,
        'UNAUTHORIZED',
      ],
      ['wrong scope', () => noScope.client.get('/v1/payments'), 403, 'FORBIDDEN'],
      [
        'unknown payment',
        () => key.client.get('/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC'),
        404,
        'NOT_FOUND',
      ],
      [
        'signature required',
        () => key.client.get('/v1/ping', { 'x-mulapay-timestamp': '1' }),
        401,
        'SIGNATURE_REQUIRED',
      ],
    ];
    for (const [label, send, status, code] of cases) {
      const res = await send();
      expect(res.statusCode, label).toBe(status);
      expect(res.json().error.code, label).toBe(code);
      expectValid(envelope, res.json(), label);
      const op = operations().find((o) => o.path === '/v1/payments' && o.method === 'get') as {
        op: Json;
      };
      const documented = Object.values(op.op.responses as Json).flatMap(
        (r: Json) => (r['x-error-codes'] as string[] | undefined) ?? []
      );
      if (label !== 'missing idempotency key' && label !== 'unknown payment')
        expect(documented, label).toContain(code);
    }
    // 409: the same idempotency key with another body; 429: the second request of a 1-per-minute key.
    const body = {
      amountMinor: '3000',
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000022' },
    };
    await key.client.post('/v1/payments', body, { 'idempotency-key': 'contract-409' });
    const reused = await key.client.post(
      '/v1/payments',
      { ...body, amountMinor: '3001' },
      { 'idempotency-key': 'contract-409' }
    );
    expect(reused.statusCode).toBe(409);
    expectValid(envelope, reused.json(), '409');
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // 429: a context whose key may read once a minute.
    const tight = await startDeveloperContext({
      RATE_LIMIT_READ_PER_MIN: '1',
      RATE_LIMIT_WRITE_PER_MIN: '1',
    });
    try {
      const owner = await createMerchant(tight, { label: 'contract-429' });
      const limited = await issueKey(tight, owner.owner, {
        environment: 'test',
        scopes: ['events:read'],
      });
      expect((await limited.client.get('/v1/events')).statusCode).toBe(200);
      const refused = await limited.client.get('/v1/events');
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('RATE_LIMITED');
      expectValid(envelope, refused.json(), '429');
      expect(refused.headers['retry-after']).toBeDefined();
    } finally {
      await tight.close();
    }
  });
});

describe('the committed documents are the ones the code generates', () => {
  const dir = join(__dirname, '../../docs/openapi');
  const update = process.env.OPENAPI_UPDATE === '1';

  it.each(['public', 'dashboard', 'admin'] as const)('docs/openapi/%s.json', (surface) => {
    const generated = `${JSON.stringify(docs[surface], null, 2)}\n`;
    const file = join(dir, `${surface}.json`);
    if (update) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, generated);
    }
    expect(
      JSON.parse(readFileSync(file, 'utf8')),
      'run OPENAPI_UPDATE=1 npx vitest run --project integration test/integration/api-contract.int-spec.ts to regenerate'
    ).toEqual(JSON.parse(generated));
  });
});
