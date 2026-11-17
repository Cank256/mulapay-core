/**
 * Gateway contract tests (P3-05): every status code from spec 3.5 against a mock gateway
 * speaking the real response shapes from `provider_gateway`. Asserts that 504 is never
 * retried and that `externalId` is stable across retry attempts.
 *
 * The fake gateway (`test/support/fake-gateway-ops.ts`) implements the real schema from
 * `provider_gateway/src/schemas/payment.ts` and `routes/transaction.ts`, so this test
 * exercises the client against shapes core will actually see.
 */
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayOperationsClient } from '../../src/integrations/gateway/gateway-operations.client';
import type { RedisCircuitBreaker } from '../../src/integrations/gateway/circuit-breaker';
import type { DisbursementRequest } from '../../src/integrations/gateway/gateway-operations.port';
import {
  FAKE_GATEWAY_KEY,
  startFakeGatewayOps,
  type FakeGatewayOps,
} from '../support/fake-gateway-ops';
import { testConfig } from '../support/test-env';

let gateway: FakeGatewayOps;

beforeAll(async () => {
  gateway = await startFakeGatewayOps();
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.disbursement = { kind: 'accept' };
  gateway.lookupStatus = undefined;
  gateway.listFails = false;
  gateway.disbursementCalls.length = 0;
  gateway.operations.clear();
});

function client(): GatewayOperationsClient {
  const noopBreaker = {
    allow: async () => true,
    record: async () => 'closed' as const,
    mode: async () => 'closed' as const,
  } as unknown as RedisCircuitBreaker;

  const noopRecorder = {
    record: async () => {},
  };

  return new GatewayOperationsClient(
    testConfig({
      GATEWAY_BASE_URL: gateway.baseUrl,
      GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
      GATEWAY_TIMEOUT_MS: '5000',
      GATEWAY_MAX_RETRIES: '2', // Test retries
    }),
    pino({ level: 'silent' }),
    noopBreaker,
    noopRecorder as any
  );
}

const request: DisbursementRequest = {
  environment: 'live',
  providerId: 'airtel',
  externalId: 'po_01CONTRACT_TEST_ID_0001',
  amountMinor: 100_000n,
  currency: 'TZS',
  payee: { partyIdType: 'MSISDN', partyId: '+255700000001' },
  metadata: { merchantId: 'mch_test', environment: 'live', coreTransactionId: 'txn_test_1' },
};

describe('gateway contract: disbursement responses (spec 3.5)', () => {
  it('201: accepted with referenceId and status', async () => {
    gateway.disbursement = { kind: 'accept', status: 'pending' };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'accepted',
      duplicate: false,
      status: 'pending',
    });
    expect(result.kind === 'accepted' && result.referenceId).toBeTruthy();
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('200: duplicate externalId returns existing operation', async () => {
    gateway.disbursement = { kind: 'accept', status: 'pending' };
    await client().submitDisbursement(request);
    // Second call with same externalId
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'accepted',
      duplicate: true,
      status: 'pending',
    });
    expect(gateway.disbursementCalls).toHaveLength(2);
  });

  it('400: validation failure is rejected, not retried', async () => {
    gateway.disbursement = { kind: 'status', code: 400 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'validation',
      httpStatus: 400,
    });
    expect(gateway.disbursementCalls).toHaveLength(1); // Not retried
  });

  it('401: unauthorized is rejected, not retried', async () => {
    gateway.disbursement = { kind: 'status', code: 401 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'unauthorized',
      httpStatus: 401,
    });
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('403: forbidden is rejected, not retried', async () => {
    gateway.disbursement = { kind: 'status', code: 403 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'unauthorized',
      httpStatus: 403,
    });
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('404: provider not found is rejected, not retried', async () => {
    gateway.disbursement = { kind: 'status', code: 404 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'provider_unavailable',
      httpStatus: 404,
    });
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('409: conflict is rejected, not retried', async () => {
    gateway.disbursement = { kind: 'status', code: 409 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'conflict',
      httpStatus: 409,
    });
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('429: rate limited returns retryAfterMs', async () => {
    gateway.disbursement = { kind: 'status', code: 429 };
    const result = await client().submitDisbursement(request);
    expect(result).toEqual({
      kind: 'rate_limited',
      retryAfterMs: null,
    });
    // 429 is retried by the client
    expect(gateway.disbursementCalls.length).toBeGreaterThan(1);
  });

  it('504: gateway timeout is ambiguous and NEVER retried (spec 3.5)', async () => {
    gateway.disbursement = { kind: 'gateway_timeout' };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'ambiguous',
      httpStatus: 504,
    });
    expect(result.kind === 'ambiguous' && result.referenceId).toBeTruthy();
    // Critical assertion: 504 is never retried
    expect(gateway.disbursementCalls).toHaveLength(1);
  });

  it('500: server error is ambiguous and retried', async () => {
    gateway.disbursement = { kind: 'status', code: 500 };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'ambiguous',
      httpStatus: 500,
    });
    // 5xx is retried
    expect(gateway.disbursementCalls.length).toBeGreaterThan(1);
  });

  it('502: bad gateway is ambiguous and retried', async () => {
    gateway.disbursement = { kind: 'status', code: 502 };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'ambiguous',
      httpStatus: 502,
    });
    expect(gateway.disbursementCalls.length).toBeGreaterThan(1);
  });

  it('503: service unavailable is ambiguous and retried', async () => {
    gateway.disbursement = { kind: 'status', code: 503 };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'ambiguous',
      httpStatus: 503,
    });
    expect(gateway.disbursementCalls.length).toBeGreaterThan(1);
  });

  it('dropped connection is ambiguous', async () => {
    gateway.disbursement = { kind: 'drop' };
    const result = await client().submitDisbursement(request);
    expect(result).toMatchObject({
      kind: 'ambiguous',
      referenceId: null,
      httpStatus: null,
    });
  });
});

describe('externalId stability across retries', () => {
  it('retries on 5xx carry the same externalId and amount', async () => {
    gateway.disbursement = { kind: 'status', code: 500 };
    await client().submitDisbursement(request);

    const calls = gateway.disbursementCalls;
    expect(calls.length).toBeGreaterThan(1);

    // All calls have the same externalId
    const externalIds = new Set(calls.map((c) => c.externalId));
    expect(externalIds.size).toBe(1);
    expect(externalIds.has(request.externalId)).toBe(true);

    // All calls have the same amount
    const amounts = new Set(calls.map((c) => c.amount));
    expect(amounts.size).toBe(1);
  });

  it('retries on transport error carry the same externalId', async () => {
    // First drop, then succeed
    gateway.disbursement = { kind: 'drop' };
    const wrappedClient = client();

    // Make two calls: first will be dropped, second will succeed
    await wrappedClient.submitDisbursement(request).catch(() => {});

    gateway.disbursement = { kind: 'accept' };
    await wrappedClient.submitDisbursement(request);

    // Both should have the same externalId
    const externalIds = gateway.disbursementCalls.map((c) => c.externalId);
    expect(externalIds.every((id) => id === request.externalId)).toBe(true);
  });
});

describe('lookups and queries', () => {
  it('findByExternalId: 404 means not found', async () => {
    const result = await client().findByExternalId('po_nonexistent');
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('findByExternalId: 200 returns the operation', async () => {
    // Create an operation first
    gateway.addOperation({
      externalId: 'po_lookup_test',
      operationType: 'disbursement',
      status: 'successful',
    });

    const result = await client().findByExternalId('po_lookup_test');
    expect(result).toMatchObject({
      kind: 'found',
      operation: {
        externalId: 'po_lookup_test',
        status: 'successful',
      },
    });
  });

  it('findByExternalId: 5xx is unavailable', async () => {
    gateway.lookupStatus = 503;
    const result = await client().findByExternalId('po_any');
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'http_503',
    });
  });

  it('listOperations: returns paginated operations', async () => {
    gateway.addOperation({ externalId: 'po_1', operationType: 'disbursement' });
    gateway.addOperation({ externalId: 'po_2', operationType: 'disbursement' });

    const result = await client().listOperations({ limit: 10, offset: 0 });
    expect(result).toMatchObject({
      kind: 'ok',
      total: 2,
    });
    expect(result.kind === 'ok' && result.operations).toHaveLength(2);
  });

  it('listOperations: 5xx is unavailable', async () => {
    gateway.listFails = true;
    const result = await client().listOperations({ limit: 10, offset: 0 });
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'http_503',
    });
  });

  it('getBalance: returns balance in minor units', async () => {
    gateway.setBalance('airtel', 'disbursement', 'TZS', '5000000');
    const result = await client().getBalance('airtel', 'disbursement', 'TZS');
    expect(result).toMatchObject({
      kind: 'ok',
      availableMinor: 500_000_000n, // 5M TZS = 500M cents
      currency: 'TZS',
    });
  });

  it('getBalance: currency mismatch is unavailable', async () => {
    gateway.setBalance('airtel', 'disbursement', 'UGX', '1000000');
    const result = await client().getBalance('airtel', 'disbursement', 'TZS');
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'currency_or_shape_mismatch',
    });
  });

  it('getBalance: 5xx is unavailable', async () => {
    // Don't set a balance, so gateway returns 503
    const result = await client().getBalance('airtel', 'disbursement', 'TZS');
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'http_503',
    });
  });
});

describe('terminal status handling', () => {
  it('accepts operations with terminal statuses', async () => {
    for (const status of ['successful', 'failed', 'expired', 'cancelled'] as const) {
      gateway.operations.clear();
      gateway.disbursement = { kind: 'accept', status };

      const result = await client().submitDisbursement({
        ...request,
        externalId: `po_terminal_${status}`,
      });

      expect(result).toMatchObject({
        kind: 'accepted',
        status,
      });
    }
  });
});
