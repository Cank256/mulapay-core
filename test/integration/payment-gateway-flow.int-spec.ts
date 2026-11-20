/**
 * Payment gateway flow integration tests (P4-08/P4-09): end-to-end verification of the
 * payment → gateway submission → event handling → ledger posting cycle.
 *
 * Tests the complete flow:
 *  1. Payment creation with gateway submission
 *  2. Gateway responses (accepted/rejected/ambiguous/rate_limited)
 *  3. Event handlers processing gateway callbacks
 *  4. Ledger posting for successful payments
 *  5. Idempotency across the full cycle
 *  6. Edge cases (routing failures, duplicate events, late arrivals)
 *
 * Uses a fake gateway (test/support/fake-gateway-ops.ts) to simulate the Provider Gateway
 * without requiring the actual service.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import { PaymentGatewaySubmitter } from '../../src/modules/payments/payment-gateway-submitter.service';
import { PaymentLifecycleService } from '../../src/modules/payments/payment-lifecycle.service';
import { PaymentsRepository } from '../../src/modules/payments/payments.repository';
import { BalancesRepository } from '../../src/modules/balances/balances.repository';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { DB_RW } from '../../src/common/db/tokens';
import { uuidv7, ulid } from '../../src/common/ids/ids';
import {
  FAKE_GATEWAY_KEY,
  startFakeGatewayOps,
  type FakeGatewayOps,
} from '../support/fake-gateway-ops';
import {
  createTestMerchant,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

describe('Payment Gateway Flow (P4-08/P4-09 integration)', () => {
  let ctx: PaymentsContext;
  let gateway: FakeGatewayOps;
  let merchant: TestMerchant;
  let submitter: PaymentGatewaySubmitter;
  let lifecycle: PaymentLifecycleService;
  let paymentsRepo: PaymentsRepository;
  let balancesRepo: BalancesRepository;
  let uow: UnitOfWork;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    gateway = await startFakeGatewayOps();

    ctx = await startPaymentsContext({
      GATEWAY_BASE_URL: gateway.baseUrl,
      GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
      GATEWAY_TIMEOUT_MS: '5000',
      GATEWAY_MAX_RETRIES: '2',
    });

    merchant = await createTestMerchant(ctx, { active: true, label: 'gateway-flow' });

    submitter = ctx.app.get(PaymentGatewaySubmitter, { strict: false });
    lifecycle = ctx.lifecycle;
    paymentsRepo = ctx.paymentsRepository;
    balancesRepo = ctx.app.get(BalancesRepository, { strict: false });
    uow = ctx.unitOfWork;
    db = ctx.app.get(DB_RW, { strict: false });
  });

  afterAll(async () => {
    await gateway?.close();
    await ctx?.close();
  });

  beforeEach(() => {
    gateway.disbursement = { kind: 'accept' };
    gateway.lookupStatus = undefined;
    gateway.listFails = false;
    gateway.disbursementCalls.length = 0;
    gateway.operations.clear();
  });

  /** Create a minimal payment+transaction record for submission tests. */
  async function createTestPayment(
    transactionId: string,
    paymentId: string,
    paymentRef: string,
    gatewayExternalId: string,
    amountMinor: bigint
  ): Promise<void> {
    await db.execute(drizzleSql`
      INSERT INTO core.transactions (
        id, ref, merchant_id, environment, type, status,
        amount_minor, fee_minor, net_minor, currency, channel,
        gateway_external_id, metadata, created_at, updated_at
      ) VALUES (
        ${transactionId},
        ${'txn_' + transactionId.slice(0, 12)},
        ${merchant.id},
        'live',
        'payment',
        'created',
        ${amountMinor},
        0,
        ${amountMinor},
        'UGX',
        'mobile_money',
        ${gatewayExternalId},
        '{}'::jsonb,
        now(),
        now()
      )
    `);

    await db.execute(drizzleSql`
      INSERT INTO core.payments (
        id, transaction_id, ref, status, amount_minor, currency,
        msisdn_encrypted, created_at
      ) VALUES (
        ${paymentId},
        ${transactionId},
        ${paymentRef},
        'created',
        ${amountMinor},
        'UGX',
        'encrypted_+256700000001',
        now()
      )
    `);
  }

  describe('happy path: payment → gateway → success → ledger', () => {
    it('should complete full flow from creation to ledger posting', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 50000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      // Gateway accepts the submission
      gateway.disbursement = { kind: 'accept', status: 'pending' };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      // Payment should move to processing
      const scope = merchant.scope('live');
      const detail = await paymentsRepo.findDetailByRef(scope, paymentRef);
      expect(detail?.payment.status).toBe('processing');
      expect(detail?.transaction.outcomeUnknown).toBe(false);

      // Apply a success event
      const referenceId = `MTN-REF-${uuidv7().slice(0, 8)}`;
      const result = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey: `gateway:success:${referenceId}`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: {
            kind: 'succeeded',
            amountMinor,
            currency: 'UGX',
          },
          identifiers: {
            provider: 'mtn',
            referenceId,
          },
        })
      );

      expect(result.result).toBe('applied');

      // Verify ledger entry was created
      const entries = await db.execute(drizzleSql`
        SELECT e.id, e.balanced
        FROM core.journal_entries e
        WHERE e.transaction_id = ${transactionId}
        ORDER BY e.created_at DESC
        LIMIT 1
      `);
      expect(entries.rows).toHaveLength(1);
      expect(entries.rows[0].balanced).toBe(true);
    });
  });

  describe('gateway rejection scenarios', () => {
    it('should handle gateway validation rejection (400)', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 10000n);

      // Gateway rejects with 400
      gateway.disbursement = { kind: 'status', code: 400 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 10000n,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await paymentsRepo.findDetailByRef(scope, paymentRef);
      expect(detail?.payment.status).toBe('failed');

      // No ledger entry should exist
      const entries = await db.execute(drizzleSql`
        SELECT COUNT(*) as count FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('0');
    });

    it('should handle gateway unauthorized rejection (401)', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 15000n);

      gateway.disbursement = { kind: 'status', code: 401 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 15000n,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await paymentsRepo.findDetailByRef(scope, paymentRef);
      expect(detail?.payment.status).toBe('failed');
    });
  });

  describe('ambiguous outcomes and chase resolution', () => {
    it('should mark payment as outcome_unknown on gateway timeout (504)', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 25000n);

      // Gateway times out
      gateway.disbursement = { kind: 'gateway_timeout' };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 25000n,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await paymentsRepo.findDetailByRef(scope, paymentRef);
      expect(detail?.payment.status).toBe('processing');
      expect(detail?.transaction.outcomeUnknown).toBe(true);
    });

    it('should handle 5xx server error as ambiguous', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, 30000n);

      gateway.disbursement = { kind: 'status', code: 500 };

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor: 30000n,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await paymentsRepo.findDetailByRef(scope, paymentRef);
      // Ambiguous outcomes stay in processing
      expect(detail?.payment.status).toBe('processing');
    });
  });

  describe('idempotency', () => {
    it('should handle duplicate success events idempotently', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 40000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      const referenceId = `MTN-REF-${uuidv7().slice(0, 8)}`;
      const eventKey = `gateway:success:${referenceId}`;

      // First success event
      const result1 = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'succeeded', amountMinor, currency: 'UGX' },
          identifiers: { provider: 'mtn', referenceId },
        })
      );
      expect(result1.result).toBe('applied');

      // Duplicate event with same eventKey
      const result2 = await uow.run((tx) =>
        lifecycle.apply(tx, paymentId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'succeeded', amountMinor, currency: 'UGX' },
          identifiers: { provider: 'mtn', referenceId },
        })
      );
      expect(result2.result).toBe('duplicate');

      // Only one ledger entry should exist
      const entries = await db.execute(drizzleSql`
        SELECT COUNT(*) as count FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('1');
    });

    it('should handle duplicate gateway submissions idempotently', async () => {
      const paymentId = uuidv7();
      const paymentRef = `pay_${ulid()}`;
      const transactionId = uuidv7();
      const gatewayExternalId = `${paymentRef}_ext`;
      const amountMinor = 80000n;

      await createTestPayment(transactionId, paymentId, paymentRef, gatewayExternalId, amountMinor);

      gateway.disbursement = { kind: 'accept', status: 'pending' };

      // Submit twice with same external ID
      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      await submitter.submit({
        paymentId,
        paymentRef,
        gatewayExternalId,
        amountMinor,
        currency: 'UGX',
        msisdnEnc: 'encrypted_+256700000001',
        channel: 'mobile_money' as const,
        merchantId: merchant.id,
        environment: 'live',
      });

      // Two gateway calls made but one operation (idempotency by externalId)
      expect(gateway.disbursementCalls).toHaveLength(2);
      expect(gateway.operations.size).toBe(1);
    });
  });
});
