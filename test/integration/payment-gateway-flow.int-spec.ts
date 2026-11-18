/**
 * Payment gateway flow integration tests (P4-08/P4-09): end-to-end verification of the
 * payment → gateway submission → event handling → ledger posting cycle.
 *
 * Tests the complete flow:
 *  1. Payment creation with gateway submission
 *  2. Gateway responses (accepted/rejected/ambiguous/rate_limited)
 *  3. Event handlers processing gateway callbacks
 *  4. Ledger posting for successful payments
 *  5. Balance updates after posting
 *  6. Idempotency across the full cycle
 *  7. Edge cases (routing failures, duplicate events, late arrivals)
 *
 * Uses a fake gateway (test/support/fake-gateway-ops.ts) to simulate the Provider Gateway
 * without requiring the actual service. All HTTP communication is real through the gateway
 * client, exercising retries, circuit breakers, and error handling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as sqlTag } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PaymentGatewaySubmitter } from '../../src/modules/payments/payment-gateway-submitter.service';
import { PaymentLifecycleService } from '../../src/modules/payments/payment-lifecycle.service';
import { PaymentsRepository } from '../../src/modules/payments/payments.repository';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { DB_RW } from '../../src/common/db/tokens';
import type { PaymentEventInput } from '../../src/modules/payments/domain/payment-event';
import { FAKE_GATEWAY_KEY, startFakeGatewayOps, type FakeGatewayOps } from '../support/fake-gateway-ops';
import {
  createTestMerchant,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';
import { uuidv7, ulid } from '../../src/common/ids/ids';

describe('Payment Gateway Flow (P4-08/P4-09 integration)', () => {
  let ctx: PaymentsContext;
  let gateway: FakeGatewayOps;
  let merchant: TestMerchant;
  let submitter: PaymentGatewaySubmitter;
  let lifecycle: PaymentLifecycleService;
  let paymentsRepo: PaymentsRepository;
  let balancesService: BalancesService;
  let uow: UnitOfWork;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    gateway = await startFakeGatewayOps();

    // Start context with gateway URL
    ctx = await startPaymentsContext({
      GATEWAY_BASE_URL: gateway.baseUrl,
      GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
      GATEWAY_TIMEOUT_MS: '5000',
      GATEWAY_MAX_RETRIES: '2',
    });

    merchant = await createTestMerchant(ctx, { active: true, label: 'gateway-flow' });

    // Get services
    submitter = ctx.app.get(PaymentGatewaySubmitter, { strict: false });
    lifecycle = ctx.lifecycle;
    paymentsRepo = ctx.paymentsRepository;
    balancesRepo = ctx.app.get(BalancesRepository, { strict: false });
    uow = ctx.unitOfWork;
  });

  afterAll(async () => {
    await gateway?.close();
    await ctx?.close();
  });

  beforeEach(() => {
    // Reset gateway state
    gateway.disbursement = { kind: 'accept' };
    gateway.lookupStatus = undefined;
    gateway.listFails = false;
    gateway.disbursementCalls.length = 0;
    gateway.operations.clear();
  });

  describe('happy path: payment → gateway → success → ledger', () => {
    it('should complete full flow from creation to ledger posting', async () => {
      // 1. Create payment (simulating what PaymentCreator does)
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 50000n;

      await ctx.db.execute(sql`
        INSERT INTO core.transactions (
          id, ref, merchant_id, environment, type, status,
          amount_minor, fee_minor, net_minor, currency, channel,
          gateway_external_id, metadata, created_at, updated_at
        ) VALUES (
          ${transactionId}, 'txn_test_001', ${merchant.id}, 'live', 'payment', 'created',
          ${amountMinor}, 0, ${amountMinor}, 'TZS', 'mobile_money',
          ${gatewayExternalId}, '{}'::jsonb, now(), now()
        )
      `);

      await ctx.db.execute(sql`
        INSERT INTO core.payments (
          id, transaction_id, ref, status, amount_minor, currency,
          msisdn_encrypted, created_at
        ) VALUES (
          ${paymentId}, ${transactionId}, ${paymentRef}, 'created', ${amountMinor}, 'TZS',
          'encrypted_+255700000001', now()
        )
      `);

      // 2. Submit to gateway (gateway accepts)
      gateway.disbursement = { kind: 'accept', status: 'pending' };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Verify payment moved to processing
      let payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('processing');
      expect(payment?.outcomeUnknown).toBe(false);

      // 3. Simulate gateway event: collection.successful
      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_gateway_123';
      
      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:successful`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      // 4. Verify payment succeeded
      payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('succeeded');
      expect(payment?.completedAt).toBeTruthy();

      // 5. Verify ledger entry created
      const entries = await ctx.db.execute(sql`
        SELECT e.id, e.entry_ref, e.debit_total, e.credit_total, e.balanced
        FROM core.journal_entries e
        JOIN core.journal_entry_keys k ON k.entry_id = e.id AND k.entry_created_at = e.created_at
        WHERE k.entry_ref LIKE 'coll:%'
        ORDER BY e.created_at DESC
        LIMIT 1
      `);

      expect(entries.rows).toHaveLength(1);
      const entry = entries.rows[0];
      expect(entry.balanced).toBe(true);
      expect(entry.debit_total).toBe(amountMinor.toString());
      expect(entry.credit_total).toBe(amountMinor.toString());

      // 6. Verify balance updated (merchant payable should increase)
      const balance = await balancesRepo.get(merchant.id, 'TZS');
      expect(balance).toBeTruthy();
      expect(balance!.availableMinor).toBeGreaterThanOrEqual(amountMinor);
    });
  });

  describe('gateway rejection scenarios', () => {
    it('should handle gateway validation rejection (400)', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      // Create payment
      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 10000n);

      // Gateway rejects with 400
      gateway.disbursement = { kind: 'status', code: 400 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 10000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Verify payment failed immediately
      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('failed');
      expect(payment?.failureCode).toContain('gateway_');

      // No ledger entry should exist
      const entries = await ctx.db.execute(sql`
        SELECT COUNT(*) as count
        FROM core.journal_entries e
        WHERE e.transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('0');
    });

    it('should handle routing failure (no provider available)', async () => {
      // This test would require RoutingService to be implemented
      // For now, we simulate by submitting without routing
      // TODO: Implement when RoutingService exists
    });

    it('should handle gateway unauthorized rejection (401)', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 15000n);

      gateway.disbursement = { kind: 'status', code: 401 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 15000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('failed');
      expect(payment?.failureCode).toBe('gateway_unauthorized');
    });
  });

  describe('ambiguous outcomes and chase resolution', () => {
    it('should mark payment as outcome_unknown on gateway timeout (504)', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 25000n);

      // Gateway times out (504)
      gateway.disbursement = { kind: 'gateway_timeout' };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 25000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Payment should be in processing with outcome_unknown
      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('processing');
      expect(payment?.outcomeUnknown).toBe(true);

      // Transaction should reflect the same state
      const [txn] = await ctx.db.execute(sql`
        SELECT status, outcome_unknown
        FROM core.transactions
        WHERE id = ${transactionId}
      `);
      expect(txn.rows[0].status).toBe('processing');
      expect(txn.rows[0].outcome_unknown).toBe(true);
    });

    it('should handle 5xx server error as ambiguous', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 30000n);

      // Gateway returns 500
      gateway.disbursement = { kind: 'status', code: 500 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 30000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('processing');
      expect(payment?.outcomeUnknown).toBe(true);
    });

    it('should resolve ambiguous payment via chase job', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 35000n);

      // Initial ambiguous response
      gateway.disbursement = { kind: 'gateway_timeout' };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 35000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Payment is outcome_unknown
      let payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.outcomeUnknown).toBe(true);

      // Chase job finds it succeeded
      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_chase_123';
      gateway.setStatus(gatewayExternalId, 'disbursement', 'successful');

      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `chase:${referenceId}:successful`,
          source: 'job',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor: 35000n,
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      // Payment should now be succeeded
      payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('succeeded');
      expect(payment?.outcomeUnknown).toBe(false);
    });
  });

  describe('rate limiting handling', () => {
    it('should mark payment as outcome_unknown on rate limit (429)', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 20000n);

      // Gateway rate limits
      gateway.disbursement = { kind: 'status', code: 429 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 20000n,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Should be outcome_unknown (will retry later)
      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('processing');
      expect(payment?.outcomeUnknown).toBe(true);
    });
  });

  describe('event idempotency', () => {
    it('should handle duplicate successful events without side effects', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 40000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      // Submit and accept
      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_idem_123';
      const eventKey = `gateway:event:${referenceId}:successful`;

      // First event
      const result1 = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      expect(result1.outcome).toBe('applied');

      // Duplicate event (same eventKey)
      const result2 = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      expect(result2.outcome).toBe('duplicate');

      // Only one ledger entry should exist
      const entries = await ctx.db.execute(sql`
        SELECT COUNT(*) as count
        FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('1');
    });

    it('should reject events with mismatched amounts', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 45000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_mismatch_123';

      // Event with wrong amount
      const result = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:successful`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor: 99999n, // Wrong amount
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toContain('amount');

      // Payment should not succeed
      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).not.toBe('succeeded');
    });

    it('should reject events with mismatched currency', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 50000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_curr_123';

      // Event with wrong currency
      const result = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:successful`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'UGX', // Wrong currency
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toContain('currency');
    });
  });

  describe('terminal state protection', () => {
    it('should not change payment once succeeded', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 55000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      // Submit and succeed
      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_term_123';

      // First: succeed
      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:successful`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'TZS',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      const payment1 = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment1?.status).toBe('succeeded');
      const completedAt = payment1!.completedAt;

      // Try to fail it (should be rejected)
      const result = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:failed`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'provider_error',
            failureReason: 'Late failure',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toContain('terminal');

      // Payment should still be succeeded with same completedAt
      const payment2 = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment2?.status).toBe('succeeded');
      expect(payment2?.completedAt).toEqual(completedAt);
    });
  });

  describe('late event handling', () => {
    it('should handle events arriving out of order', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 60000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_late_123';

      // Late failed event arrives before processing event
      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:failed`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'insufficient_funds',
            failureReason: 'Payer has insufficient balance',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      // Payment should be failed
      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('failed');
      expect(payment?.failureCode).toBe('insufficient_funds');
    });
  });

  describe('different terminal statuses', () => {
    it('should handle failed payment correctly', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 65000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_fail_123';

      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:failed`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'failed',
            failureCode: 'transaction_declined',
            failureReason: 'Transaction declined by provider',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('failed');
      expect(payment?.failureCode).toBe('transaction_declined');
      expect(payment?.completedAt).toBeTruthy();

      // No ledger entry for failed payments
      const entries = await ctx.db.execute(sql`
        SELECT COUNT(*) as count
        FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('0');
    });

    it('should handle expired payment correctly', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 70000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_exp_123';

      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:expired`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'expired',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('expired');
      expect(payment?.completedAt).toBeTruthy();
    });

    it('should handle cancelled payment correctly', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 75000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = gateway.operations.values().next().value?.referenceId ?? 'ref_cancel_123';

      await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:event:${referenceId}:cancelled`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'cancelled',
          },
          identifiers: {
            provider: 'airtel',
            referenceId,
          },
        })
      );

      const payment = await paymentsRepo.findByRef(merchant.id, paymentRef);
      expect(payment?.status).toBe('cancelled');
      expect(payment?.completedAt).toBeTruthy();
    });
  });

  describe('gateway duplicate detection', () => {
    it('should detect when gateway already has the operation', async () => {
      const paymentId = generateUUIDv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = generateUUIDv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 80000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      // First submission
      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Second submission with same external ID (gateway returns 200 instead of 201)
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'TZS',
        msisdn: '+255700000001',
        merchantId: merchant.id,
        environment: 'live',
      });

      // Should only create one operation at gateway
      expect(gateway.disbursementCalls).toHaveLength(2); // Two calls made
      expect(gateway.operations.size).toBe(1); // But only one operation exists
    });
  });

  // Helper function to create test payment records
  async function createTestPayment(
    transactionId: string,
    paymentId: string,
    paymentRef: string,
    gatewayExternalId: string,
    amountMinor: bigint
  ): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO core.transactions (
        id, ref, merchant_id, environment, type, status,
        amount_minor, fee_minor, net_minor, currency, channel,
        gateway_external_id, metadata, created_at, updated_at
      ) VALUES (
        ${transactionId}, 'txn_${transactionId.slice(0, 12)}', ${merchant.id}, 'live', 'payment', 'created',
        ${amountMinor}, 0, ${amountMinor}, 'TZS', 'mobile_money',
        ${gatewayExternalId}, '{}'::jsonb, now(), now()
      )
    `);

    await ctx.db.execute(sql`
      INSERT INTO core.payments (
        id, transaction_id, ref, status, amount_minor, currency,
        msisdn_encrypted, created_at
      ) VALUES (
        ${paymentId}, ${transactionId}, ${paymentRef}, 'created', ${amountMinor}, 'TZS',
        'encrypted_+255700000001', now()
      )
    `);
  }
});
