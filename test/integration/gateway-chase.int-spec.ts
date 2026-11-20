/**
 * Integration test for the gateway chase job (P4-10): verifies that stuck transactions in
 * processing state are queried via the gateway client and resolved when terminal statuses
 * are returned.
 *
 * Uses a mock gateway client to simulate provider responses without hitting the real gateway.
 * Tests idempotency, terminal state guards, and proper handling of ambiguous outcomes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { uuidv7 } from '../../src/common/ids/ids';
import { transactions } from '../../src/db/schema';
import type {
  GatewayOperationsPort,
  OperationLookup,
  DisbursementResult,
  CollectionResult,
  OperationPage,
  GatewayBalance,
} from '../../src/integrations/gateway/gateway-operations.port';
import { CHASE_JOB, GatewayChaseProcessor } from '../../src/jobs/gateway-chase.processor';
import { DB_RW } from '../../src/common/db/tokens';
import { startContext } from '../support/identity';
import type { TestContext } from '../support/identity';
import { FixedClock } from '../support/fixed-clock';
import type { Executor } from '../../src/common/db/database.types';

describe('GatewayChaseProcessor (integration)', () => {
  let ctx: TestContext;
  let processor: GatewayChaseProcessor;
  let mockGateway: MockGatewayClient;
  let clock: FixedClock;
  let db: Executor;

  beforeAll(async () => {
    ctx = await startContext();
    db = ctx.app.get<Executor>(DB_RW, { strict: false });

    clock = new FixedClock(new Date('2024-01-15T10:00:00Z'));
    mockGateway = new MockGatewayClient();

    // Build processor with all dependencies from the app container
    processor = new GatewayChaseProcessor(
      db,
      mockGateway,
      ctx.app.get('UnitOfWork', { strict: false }),
      ctx.app.get('TransactionsRepository', { strict: false }),
      ctx.app.get('PaymentsRepository', { strict: false }),
      ctx.app.get('PayoutsRepository', { strict: false }),
      ctx.app.get('RefundsRepository', { strict: false }),
      ctx.app.get('PaymentLifecycleService', { strict: false }),
      ctx.app.get('PayoutLifecycleService', { strict: false }),
      ctx.app.get('RefundLifecycleService', { strict: false }),
      ctx.app.get('ReconciliationExceptionRecorder', { strict: false }),
      ctx.app.get('PinoLogger', { strict: false }) ?? {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      clock,
      ctx.config
    );
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await db.delete(transactions);
    mockGateway.reset();
  });

  describe('chase logic', () => {
    it('should find and resolve stuck transactions with successful status', async () => {
      // Create a transaction stuck in processing (6 minutes ago)
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');
      const txn = await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_test123',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      // Mock gateway returns successful
      mockGateway.addOperation('pay_test123', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: 'MTN-REF-123',
          externalId: 'pay_test123',
          status: 'successful',
          amount: '10000',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: new Date('2024-01-15T09:58:00Z'),
        },
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(1);
      expect(result.resolved).toBe(1);
      expect(result.stillPending).toBe(0);
      expect(result.notFound).toBe(0);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.id} = ${txn.id}`);

      expect(updated?.status).toBe('succeeded');
      expect(updated?.gatewayReferenceId).toBe('MTN-REF-123');
      expect(updated?.outcomeUnknown).toBe(false);
    });

    it('should handle transactions with outcome_unknown flag', async () => {
      const oneMinuteAgo = new Date('2024-01-15T09:59:00Z');
      const txn = await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_ambiguous',
        outcomeUnknown: true,
        initiatedAt: oneMinuteAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_ambiguous', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: 'MTN-REF-456',
          externalId: 'pay_ambiguous',
          status: 'failed',
          amount: '5000',
          currency: 'UGX',
          createdAt: oneMinuteAgo,
          updatedAt: clock.now(),
        },
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(1);
      expect(result.resolved).toBe(1);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.id} = ${txn.id}`);

      expect(updated?.status).toBe('failed');
      expect(updated?.outcomeUnknown).toBe(false);
    });

    it('should skip transactions still pending at provider', async () => {
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_pending',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_pending', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: null,
          externalId: 'pay_pending',
          status: 'pending',
          amount: '7500',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: clock.now(),
        },
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(1);
      expect(result.resolved).toBe(0);
      expect(result.stillPending).toBe(1);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_pending'`);

      expect(updated?.status).toBe('processing');
    });

    it('should handle not found operations', async () => {
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_notfound',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_notfound', { kind: 'not_found' });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(1);
      expect(result.resolved).toBe(0);
      expect(result.notFound).toBe(1);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_notfound'`);

      expect(updated?.status).toBe('processing');
    });

    it('should handle gateway unavailable gracefully', async () => {
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_unavailable',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_unavailable', {
        kind: 'unavailable',
        reason: 'gateway_timeout',
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(1);
      expect(result.resolved).toBe(0);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_unavailable'`);

      expect(updated?.status).toBe('processing');
    });

    it('should not change already-terminal transactions', async () => {
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');
      const completedAt = new Date('2024-01-15T09:56:00Z');
      const txn = await insertTransaction({
        status: 'succeeded',
        gatewayExternalId: 'pay_terminal',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_terminal', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: 'MTN-REF-789',
          externalId: 'pay_terminal',
          status: 'successful',
          amount: '10000',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: completedAt,
        },
      });

      const job = createMockJob(CHASE_JOB);
      await processor.process(job);

      const [updated] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.id} = ${txn.id}`);

      expect(updated?.status).toBe('succeeded');
      expect(updated?.completedAt).toEqual(completedAt);
    });

    it('should not chase transactions without gateway_external_id', async () => {
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: null,
        outcomeUnknown: false,
        initiatedAt: new Date('2024-01-15T09:54:00Z'),
        completedAt: null,
        type: 'payment',
        provider: null,
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(0);
    });

    it('should not chase recent transactions without outcome_unknown', async () => {
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_recent',
        outcomeUnknown: false,
        initiatedAt: new Date('2024-01-15T09:59:00Z'),
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(0);
    });

    it('should handle multiple stuck transactions in a batch', async () => {
      const sixMinutesAgo = new Date('2024-01-15T09:54:00Z');

      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_batch1',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_batch2',
        outcomeUnknown: true,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'airtel_ug',
      });
      await insertTransaction({
        status: 'processing',
        gatewayExternalId: 'pay_batch3',
        outcomeUnknown: false,
        initiatedAt: sixMinutesAgo,
        completedAt: null,
        type: 'payment',
        provider: 'mtn_momo_ug',
      });

      mockGateway.addOperation('pay_batch1', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: 'REF1',
          externalId: 'pay_batch1',
          status: 'successful',
          amount: '1000',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: clock.now(),
        },
      });
      mockGateway.addOperation('pay_batch2', {
        kind: 'found',
        operation: {
          providerId: 'airtel_ug',
          operationType: 'collection',
          referenceId: 'REF2',
          externalId: 'pay_batch2',
          status: 'failed',
          amount: '2000',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: clock.now(),
        },
      });
      mockGateway.addOperation('pay_batch3', {
        kind: 'found',
        operation: {
          providerId: 'mtn_momo_ug',
          operationType: 'collection',
          referenceId: 'REF3',
          externalId: 'pay_batch3',
          status: 'expired',
          amount: '3000',
          currency: 'UGX',
          createdAt: sixMinutesAgo,
          updatedAt: clock.now(),
        },
      });

      const job = createMockJob(CHASE_JOB);
      const result = await processor.process(job);

      expect(result.checked).toBe(3);
      expect(result.resolved).toBe(3);

      const [txn1] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_batch1'`);
      expect(txn1?.status).toBe('succeeded');

      const [txn2] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_batch2'`);
      expect(txn2?.status).toBe('failed');

      const [txn3] = await db
        .select()
        .from(transactions)
        .where(sql`${transactions.gatewayExternalId} = 'pay_batch3'`);
      expect(txn3?.status).toBe('expired');
    });
  });

  async function insertTransaction(partial: {
    status: string;
    gatewayExternalId: string | null;
    outcomeUnknown: boolean;
    initiatedAt: Date | null;
    completedAt: Date | null;
    type: string;
    provider: string | null;
  }) {
    const id = uuidv7(clock.now());
    const createdAt = partial.initiatedAt ?? clock.now();
    const [row] = await db
      .insert(transactions)
      .values({
        id,
        ref: `txn_${id.slice(0, 12)}`,
        merchantId: 'merchant-test',
        environment: 'test',
        type: partial.type as 'payment' | 'payout' | 'refund',
        status: partial.status,
        amountMinor: 10000n,
        feeMinor: 0n,
        netMinor: 10000n,
        currency: 'UGX',
        channel: 'mobile_money',
        metadata: {},
        gatewayExternalId: partial.gatewayExternalId,
        provider: partial.provider,
        outcomeUnknown: partial.outcomeUnknown,
        initiatedAt: partial.initiatedAt,
        completedAt: partial.completedAt,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    return row!;
  }

  function createMockJob(name: string): Job {
    return {
      name,
      data: {},
      id: '1',
      attemptsMade: 0,
    } as Job;
  }
});

/**
 * Mock gateway client for testing. Stores predefined responses keyed by external_id.
 */
class MockGatewayClient implements GatewayOperationsPort {
  private operations = new Map<string, OperationLookup>();

  addOperation(externalId: string, result: OperationLookup): void {
    this.operations.set(externalId, result);
  }

  reset(): void {
    this.operations.clear();
  }

  async findByExternalId(externalId: string): Promise<OperationLookup> {
    const result = this.operations.get(externalId);
    return result ?? { kind: 'not_found' };
  }

  async submitCollection(): Promise<CollectionResult> {
    throw new Error('submitCollection not implemented in MockGatewayClient');
  }

  async submitDisbursement(): Promise<DisbursementResult> {
    throw new Error('submitDisbursement not implemented in MockGatewayClient');
  }

  async listOperations(): Promise<OperationPage> {
    throw new Error('listOperations not implemented in MockGatewayClient');
  }

  async getBalance(): Promise<GatewayBalance> {
    throw new Error('getBalance not implemented in MockGatewayClient');
  }
}
