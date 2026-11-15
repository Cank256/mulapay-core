/**
 * Completes the generated `/v1` OpenAPI document (spec 6.11, 7.1, 11, Phase 5). Nest and Zod
 * give every route its request and response schemas; this adds what is the same for all
 * of them or comes from decorators, so each operation states:
 *
 *  - authentication (`bearer` API key) and the scope it needs (`x-required-scopes`);
 *  - every error it can return, from the error catalogue, with an example envelope;
 *  - idempotency (the `Idempotency-Key` header is documented by `@Idempotent`; here it is
 *    flagged `x-idempotent` and its error codes added);
 *  - the webhook events it causes (`x-webhook-events`);
 *  - request and response examples: hand-written (`@ApiExample`) or generated from the schema;
 *  - the rate limit headers.
 *
 * The document also describes request signing, rate limits, webhooks (`x-webhooks`) and the
 * sandbox. `test/integration/api-contract.int-spec.ts` validates the result.
 */
import type { OpenAPIObject } from '@nestjs/swagger';
import { ERROR_CATALOGUE, errorDocUrl, renderMessage, type ErrorCode } from '../errors/catalogue';
import { errorEnvelopeSchema } from '../errors/envelope';
import { MERCHANT_EVENT_TYPES } from '../../modules/events/domain/event-types';
import { RETRY_DELAYS_SECONDS } from '../../modules/webhooks/domain/retry-schedule';
import { toOpenApiSchema } from '../http/json-schema';
import { exampleFromSchema } from './schema-example';

type Json = Record<string, unknown>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const WRITE = new Set(['post', 'put', 'patch', 'delete']);
const SIGNATURE_CODES: ErrorCode[] = [
  'SIGNATURE_REQUIRED',
  'SIGNATURE_INVALID',
  'SIGNATURE_TIMESTAMP_INVALID',
  'SIGNATURE_REPLAYED',
  'SIGNING_SECRET_MISSING',
];
const IDEMPOTENCY_CODES: ErrorCode[] = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_IN_PROGRESS',
];

const RATE_LIMIT_HEADERS: Json = {
  'X-RateLimit-Limit': {
    description: 'Requests allowed in the current window for the limit that applies.',
    schema: { type: 'integer' },
  },
  'X-RateLimit-Remaining': {
    description: 'Requests left in the current window.',
    schema: { type: 'integer' },
  },
  'X-RateLimit-Reset': {
    description: 'Unix time (seconds) at which the window next has room.',
    schema: { type: 'integer' },
  },
  'X-Request-Id': {
    description: 'The request id. Quote it when contacting support.',
    schema: { type: 'string' },
  },
};

const DESCRIPTION = `
Server-to-server API for merchants. Browsers are not supported and no CORS origin is allowed.

## Authentication
Send a secret API key as \`Authorization: Bearer mp_{live|test}_{keyId}_{secret}\`. A \`test\` key
works in the sandbox and never moves money; a \`live\` key moves real money. Each key carries
scopes (for example \`payments:write\`); a route needs its scope, and a key without it gets 403.
A key may have an IP allowlist; a request from another address is refused with 401.

## Request signing
Optional per key, and **mandatory for \`payouts:write\` on live keys**. Send
\`X-MulaPay-Timestamp: <unix seconds>\` and \`X-MulaPay-Signature: v1=<hex hmac-sha256>\` where the
HMAC key is the key's signing secret (shown once, with the key) and the signed string is
\`timestamp + "." + METHOD + "." + path + "." + sha256(rawBody)\`. \`path\` is the request target as
sent (path and query string). A timestamp more than 300 seconds from the server clock is refused,
and a signature is accepted once.

## Idempotency
Routes that create a resource or move money require an \`Idempotency-Key\` header (1 to 255
printable characters). Repeating a request with the same key and body within 24 hours returns the
first response with \`Idempotency-Replayed: true\`; the same key with another body is a 409.

## Rate limits
Per key: 100 writes and 600 reads a minute by default, plus a burst bucket. Every response carries
\`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\`; a 429 adds \`Retry-After\`.

## Errors
Failures are \`{ "success": false, "error": { code, message, details?, requestId, docUrl } }\`. The
\`code\` is stable; the \`message\` is for people.

## Sandbox
Payments made with a test key resolve on their own: from \`metadata.simulate\` (\`succeed\`, \`fail\`,
\`timeout\`, \`expire\`, \`pending_then_succeed\`), otherwise from the last two digits of the amount in
minor units (\`01\` fail, \`02\` timeout, \`03\` expire, \`04\` pending_then_succeed, anything else
succeed). The same events and webhooks fire as for live payments.
`.trim();

function errorExample(code: ErrorCode): Json {
  const definition = ERROR_CATALOGUE[code];
  return {
    summary: code,
    value: {
      success: false,
      error: {
        code,
        message: renderMessage(definition.message),
        requestId: '0b3a5c0e-7f55-4c3e-9d8e-2f6d1c1a9a10',
        docUrl: errorDocUrl(code),
      },
    },
  };
}

function jsonContent(operationPart: unknown): Json | undefined {
  const content = (operationPart as { content?: Record<string, Json> } | undefined)?.content;
  return content?.['application/json'];
}

/** The status codes and codes an operation can fail with. */
function errorsFor(
  operation: Json,
  method: string,
  path: string,
  scope: string | undefined
): Map<number, Set<ErrorCode>> {
  const result = new Map<number, Set<ErrorCode>>();
  const add = (code: ErrorCode) => {
    const status = ERROR_CATALOGUE[code].httpStatus;
    result.set(status, (result.get(status) ?? new Set()).add(code));
  };
  const parameters = (operation.parameters ?? []) as Array<{ in: string; name: string }>;
  const idempotent = parameters.some((p) => p.in === 'header' && p.name === 'Idempotency-Key');
  add('UNAUTHORIZED');
  for (const code of SIGNATURE_CODES) add(code);
  add('RATE_LIMITED');
  add('INTERNAL_ERROR');
  add('SERVICE_UNAVAILABLE');
  if (scope) add('FORBIDDEN');
  if (WRITE.has(method)) add('MERCHANT_CLOSED');
  if (path.includes('{')) add('NOT_FOUND');
  if (operation.requestBody || parameters.some((p) => p.in === 'query')) add('VALIDATION_FAILED');
  if (parameters.some((p) => p.name === 'cursor')) add('INVALID_CURSOR');
  if (idempotent) for (const code of IDEMPOTENCY_CODES) add(code);
  for (const code of (operation['x-error-codes'] ?? []) as ErrorCode[]) add(code);
  return result;
}

function descriptionOf(operation: Json): string {
  return typeof operation.description === 'string' ? operation.description : '';
}

function describeEvents(events: string[]): string {
  return `\n\n**Webhook events:** ${events.map((e) => `\`${e}\``).join(', ')}. See the webhooks section for delivery, signing and retries.`;
}

function enrichOperation(doc: OpenAPIObject, path: string, method: string, operation: Json): void {
  const scope = operation['x-required-permission'] as string | undefined;
  operation.security = [{ bearer: [] }];
  if (scope) operation['x-required-scopes'] = [scope];
  delete operation['x-required-permission'];
  const parameters = (operation.parameters ?? []) as Array<{ in: string; name: string }>;
  operation['x-idempotent'] = parameters.some(
    (p) => p.in === 'header' && p.name === 'Idempotency-Key'
  );
  if (WRITE.has(method)) {
    operation.parameters = [
      ...parameters,
      { $ref: '#/components/parameters/RequestTimestamp' },
      { $ref: '#/components/parameters/RequestSignature' },
    ];
  }
  if (scope) {
    operation.description = `${descriptionOf(operation)}\n\nRequires scope \`${scope}\`.`.trim();
  }
  const events = (operation['x-webhook-events'] ?? []) as string[];
  if (events.length > 0) {
    operation.description = `${descriptionOf(operation)}${describeEvents(events)}`;
  }

  const responses = (operation.responses ?? {}) as Record<string, Json>;
  const examples = (operation['x-examples'] ?? {}) as { request?: unknown; response?: unknown };
  const errors = errorsFor(operation, method, path, scope);
  for (const [status, codes] of errors) {
    responses[String(status)] = {
      description: `Error: ${[...codes].join(', ')}`,
      headers: status === 429 ? { 'Retry-After': { schema: { type: 'integer' } } } : undefined,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
          examples: Object.fromEntries([...codes].map((code) => [code, errorExample(code)])),
        },
      },
      'x-error-codes': [...codes],
    };
  }
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith('2')) continue;
    response.headers = { ...(response.headers as Json | undefined), ...RATE_LIMIT_HEADERS };
    const content = jsonContent(response);
    if (content && content.example === undefined) {
      content.example = successExample(doc, content, examples.response);
    }
  }
  operation.responses = responses;

  const body = jsonContent(operation.requestBody);
  if (body && body.example === undefined) {
    body.example =
      examples.request ?? exampleFromSchema(doc as unknown as Json, body.schema as Json);
  }
  for (const parameter of (operation.parameters ?? []) as Json[]) {
    if (parameter.example === undefined && parameter.schema && !parameter.$ref) {
      parameter.example = exampleFromSchema(doc as unknown as Json, parameter.schema as Json);
    }
  }
  delete operation['x-error-codes'];
  delete operation['x-webhook-events'];
  delete operation['x-examples'];
  if (events.length > 0) operation['x-webhook-events'] = events;
}

/** A whole success body: the example `data`, or one generated from the response schema. */
function successExample(doc: OpenAPIObject, content: Json, data: unknown): unknown {
  const generated = exampleFromSchema(doc as unknown as Json, content.schema as Json) as Json;
  return data === undefined ? generated : { ...generated, data };
}

function webhookSection(): Json {
  return {
    description:
      'MulaPay POSTs each event to the endpoints registered through `/v1/webhook-endpoints`. ' +
      'Respond 2xx within 10 seconds. Anything else is retried at ' +
      `${RETRY_DELAYS_SECONDS.map((s) => `${s}s`).join(', ')} (with jitter); after 50 consecutive ` +
      'failures an endpoint is disabled and a `webhook_endpoint.auto_disabled` event is created. ' +
      'Delivery is at least once and not ordered: deduplicate on `MulaPay-Event-Id`. ' +
      'Redirects are not followed and only public https addresses are contacted.',
    eventTypes: MERCHANT_EVENT_TYPES,
    headers: {
      'MulaPay-Signature':
        't=<unix seconds>,v1=<hex HMAC-SHA256 of "t.payload" with the endpoint secret>. ' +
        'During a secret rotation there are two v1 entries. Reject a timestamp more than 300 ' +
        'seconds old, and compare in constant time.',
      'MulaPay-Event-Id': 'Stable id of the event; the same on retries and replays.',
      'MulaPay-Event-Type': 'The event type.',
      'MulaPay-Delivery-Id': 'The delivery this attempt belongs to.',
      'MulaPay-Delivery-Attempt': 'Attempt number, from 1.',
    },
    payload: { $ref: '#/components/schemas/MerchantEvent' },
  };
}

/** Adds the shared parts and completes every `/v1` operation. Mutates and returns `doc`. */
export function enrichPublicDocument(doc: OpenAPIObject, merchantEventSchema: Json): OpenAPIObject {
  doc.info.description = DESCRIPTION;
  const components = (doc.components ??= {}) as Json;
  components.securitySchemes = {
    bearer: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'mp_{live|test}_{keyId}_{secret}',
      description: 'A secret API key. Test keys use the sandbox; live keys move money.',
    },
  };
  components.parameters = {
    RequestTimestamp: {
      name: 'X-MulaPay-Timestamp',
      in: 'header',
      required: false,
      description: 'Unix seconds. Required with a signature; within 300 seconds of server time.',
      schema: { type: 'string', pattern: '^[0-9]{1,12}$' },
      example: '1735689600',
    },
    RequestSignature: {
      name: 'X-MulaPay-Signature',
      in: 'header',
      required: false,
      description:
        '`v1=` and the hex HMAC-SHA256 of the signing string. Mandatory for payouts:write on live keys.',
      schema: { type: 'string', pattern: '^v1=[0-9a-f]{64}$' },
      example: `v1=${'0'.repeat(64)}`,
    },
  };
  const schemas = (components.schemas ??= {}) as Json;
  schemas.ErrorEnvelope = toOpenApiSchema(errorEnvelopeSchema);
  schemas.MerchantEvent = merchantEventSchema;
  doc['x-webhooks' as keyof OpenAPIObject] = webhookSection() as never;

  for (const [path, item] of Object.entries(doc.paths)) {
    if (path.startsWith('/v1/health')) continue;
    for (const method of METHODS) {
      const operation = (item as Json)[method] as Json | undefined;
      if (operation) enrichOperation(doc, path, method, operation);
    }
  }
  return doc;
}
