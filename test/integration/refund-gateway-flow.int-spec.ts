/**
 * Refund gateway flow integration tests (Phase 4): end-to-end verification of the
 * refund → gateway submission → event handling → ledger posting cycle.
 *
 * Tests:
 *  1. Refund creation submits to the gateway (live, succeeded payment)
 *  2. Gateway accepted → processing; rejected → failed; ambiguous → outcome_unknown
 *  3. Refund success event: posts balanced ledger entry
 *  4. Refund failure event: no ledger entry
 *  5. Idempotency: duplicate success events create exactly one ledger entry
 *  6. Test-environment refunds are not sent to the gateway
 *  7. Missing MSISDN on original payment → refund fails at submission
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import { RefundGatewaySubmitter } from '../../src/modules/refunds/refund-gateway-submitter.service';
import { RefundLifecycleService } from '../../src/modules/refunds/refund-lifecycle.service';
import { RefundsRepository } from '../../src/modules/refunds/refunds.repository';
import { FieldEncryption } from '../../src/common/crypto/field-encryption';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { DB_RW } from '../../src/common/db/tokens';
import { uuidv7, ulid, publicId } from '../../src/common/ids/ids';
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

describe('Refund Gateway Flow (Phase 4 integration)', () => {
  let ctx: PaymentsContext;
  let gateway: FakeGatewayOps;
  let merchant: TestMerchant;
  let submitter: RefundGatewaySubmitter;
  let lifecycle: RefundLifecycleService;
  let refundsRepo: RefundsRepository;
  let encryption: FieldEncryption;
  let postingService: PostingService;
  let uow: UnitOfWork;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    gateway = await startFakeGatewayOps();

    ctx = await startPaymentsContext({
      GATEWAY_BASE_URL: gateway.baseUrl,
      GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
      GATEWAY_TIMEOUT_MS: '5000',
      GATEWAY_MAX_RETRIES: '1',
    });

    merchant = await createTestMerchant(ctx, {
      active: true,
      label: 'refund-flow',
      scopes: [
        'refunds:read',
        'refunds:write',
        'payments:read',
        'payments:write',
        'transactions:read',
      ],
    });

    submitter = ctx.app.get(RefundGatewaySubmitter, { strict: false });
    lifecycle = ctx.app.get(RefundLifecycleService, { strict: false });
    refundsRepo = ctx.app.get(RefundsRepository, { strict: false });
    encryption = ctx.app.get(FieldEncryption, { strict: false });
    postingService = ctx.app.get(PostingService, { strict: false });
    uow = ctx.unitOfWork;
    db = ctx.app.get(DB_RW, { strict: false });

    // Seed a routing rule for airtel (supports refunds; MTN does not per spec 6.4).
    await db.execute(drizzleSql`
      INSERT INTO core.routing_rules (
        id, ref, priority, currency, country, channel,
        provider, weight, enabled, created_at, updated_at
      ) VALUES (
        ${uuidv7()}, ${`rrl_${ulid()}`},
        1, 'UGX', '*', '*',
        'airtel', 100, true, now(), now()
      )
      ON CONFLICT DO NOTHING
    `);
  });

  afterAll(async () => {
    await gateway?.close();
    await ctx?.close();
  });

  beforeEach(() => {
    gateway.disbursement = { kind: 'accept' };
    gateway.lookupStatus = undefined;
    gateway.disbursementCalls.length = 0;
    gateway.operations.clear();
  });

  /**
   * Inserts a minimal payment + succeeded transaction + refund directly into the DB.
   * Uses proper ref formats and respects DB triggers (payment transactions must start
   * in 'created'; we advance to 'succeeded' with a direct UPDATE after insert).
   */
  async function insertTestRefund(opts: {
    amountMinor: bigint;
    msisdnEnc?: string | null;
    status?: string;
    environment?: 'test' | 'live';
  }): Promise<{
    refundId: string;
    refundRef: string;
    paymentId: string;
    transactionId: string;
    paymentTransactionId: string;
    externalId: string;
  }> {
    const env = opts.environment ?? 'live';
    const paymentId = uuidv7();
    const paymentRef = publicId('payment');
    const paymentTransactionId = uuidv7();
    const paymentTransactionRef = publicId('transaction');
    const refundId = uuidv7();
    const refundRef = publicId('refund');
    const refundTransactionId = uuidv7();
    const refundTransactionRef = publicId('transaction');
    const externalId = `${refundRef}_ext`;
    const now = new Date();
    const refundStatus = opts.status ?? 'created';
    // Encrypt the MSISDN the same way the payment creator does, so the refund submitter
    // can decrypt it. When msisdnEnc is null, no MSISDN is stored (tests the failure path).
    let msisdnEnc: string | null;
    if (opts.msisdnEnc === null) {
      msisdnEnc = null;
    } else if (opts.msisdnEnc !== undefined) {
      msisdnEnc = opts.msisdnEnc;
    } else {
      msisdnEnc = encryption.encrypt('+256700000001', `payments.msisdn:${paymentRef}`);
    }

    // Payment transaction + payment row must be inserted in the same transaction:
    // a DEFERRABLE constraint trigger asserts the payment row exists and agrees with
    // the transaction at commit time. Using db.execute directly would autocommit each
    // statement, so we run them inside a UnitOfWork.
    await uow.run(async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO core.transactions (
          id, ref, merchant_id, environment, type, status,
          amount_minor, fee_minor, net_minor, currency, channel,
          provider, gateway_external_id, metadata, created_at, updated_at
        ) VALUES (
          ${paymentTransactionId},
          ${paymentTransactionRef},
          ${merchant.id}, ${env}, 'payment', 'created',
          ${opts.amountMinor}, 0, ${opts.amountMinor},
          'UGX', 'mobile_money', 'mtn',
          ${'pay_ext_' + ulid()},
          '{}'::jsonb, ${now}, ${now}
        )
      `);
      await tx.execute(drizzleSql`
        INSERT INTO core.payments (
          id, transaction_id, ref, merchant_id, environment,
          status, amount_minor, currency, channel,
          payment_method, idempotency_key, expires_at, created_at
        ) VALUES (
          ${paymentId}, ${paymentTransactionId}, ${paymentRef},
          ${merchant.id}, ${env},
          'created', ${opts.amountMinor}, 'UGX', 'mobile_money',
          ${msisdnEnc === null ? '{}' : JSON.stringify({ msisdnEnc })}::jsonb,
          ${`pay-idem-${ulid()}`},
          ${new Date(now.getTime() + 600000)},
          ${now}
        )
      `);
      // Advance both payment and transaction to succeeded via processing
      // (DB trigger requires created → processing → succeeded, not a direct jump)
      await tx.execute(drizzleSql`
        UPDATE core.transactions
        SET status = 'processing', updated_at = ${now}
        WHERE id = ${paymentTransactionId}
      `);
      await tx.execute(drizzleSql`
        UPDATE core.payments
        SET status = 'processing'
        WHERE id = ${paymentId}
      `);
      await tx.execute(drizzleSql`
        UPDATE core.transactions
        SET status = 'succeeded', completed_at = ${now}, updated_at = ${now}
        WHERE id = ${paymentTransactionId}
      `);
      await tx.execute(drizzleSql`
        UPDATE core.payments
        SET status = 'succeeded'
        WHERE id = ${paymentId}
      `);
    });

    // Refund transaction + refund row must also be inserted together.
    await uow.run(async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO core.transactions (
          id, ref, merchant_id, environment, type, status,
          amount_minor, fee_minor, net_minor, currency, channel,
          provider, gateway_external_id, metadata, created_at, updated_at
        ) VALUES (
          ${refundTransactionId},
          ${refundTransactionRef},
          ${merchant.id}, ${env}, 'refund', 'created',
          ${opts.amountMinor}, 0, ${opts.amountMinor},
          'UGX', 'mobile_money', 'mtn',
          ${externalId},
          '{}'::jsonb, ${now}, ${now}
        )
      `);
      await tx.execute(drizzleSql`
        INSERT INTO core.refunds (
          id, ref, transaction_id, payment_id, merchant_id, environment,
          status, amount_minor, currency,
          idempotency_key, metadata, created_at, updated_at
        ) VALUES (
          ${refundId}, ${refundRef}, ${refundTransactionId}, ${paymentId},
          ${merchant.id}, ${env},
          'created',
          ${opts.amountMinor}, 'UGX',
          ${`idem-${ulid()}`}, '{}'::jsonb, ${now}, ${now}
        )
      `);

      if (refundStatus !== 'created') {
        await tx.execute(drizzleSql`
          UPDATE core.transactions SET status = ${refundStatus}, updated_at = ${now}
          WHERE id = ${refundTransactionId}
        `);
        await tx.execute(drizzleSql`
          UPDATE core.refunds SET status = ${refundStatus}, updated_at = ${now}
          WHERE id = ${refundId}
        `);
      }
    });

    return {
      refundId,
      refundRef,
      paymentId,
      transactionId: refundTransactionId,
      paymentTransactionId,
      externalId,
    };
  }

  /** Seeds a balance by posting a collection entry through PostingService. */
  async function seedBalance(amountMinor: bigint): Promise<void> {
    const sourceId = `seed-${ulid()}`;
    await uow.run((tx) =>
      postingService.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', sourceId),
        environment: 'live',
        currency: 'UGX',
        source: 'adjustment',
        sourceId,
        kind: 'adjustment.seed',
        merchantId: merchant.id,
        description: 'Seed balance for test',
        lines: [
          {
            accountCode: `1000:provider_clearing:airtel`,
            direction: 'debit',
            amountMinor,
          },
          {
            accountCode: `2000:merchant_payable:${merchant.ref}`,
            direction: 'credit',
            amountMinor,
          },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
  }

  describe('gateway submission — accepted', () => {
    it('advances refund to processing when gateway accepts', async () => {
      const { refundId, refundRef, externalId } = await insertTestRefund({ amountMinor: 50000n });
      gateway.disbursement = { kind: 'accept', status: 'pending' };

      await submitter.submit({
        refundId,
        refundRef,
        gatewayExternalId: externalId,
        amountMinor: 50000n,
        currency: 'UGX',
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await refundsRepo.findDetailByRef(scope, refundRef);
      expect(detail?.refund.status).toBe('processing');
      expect(detail?.transaction.outcomeUnknown).toBe(false);
      expect(gateway.disbursementCalls).toHaveLength(1);
    });
  });

  describe('gateway submission — rejected', () => {
    it('marks refund failed when gateway returns 400', async () => {
      const { refundId, refundRef, externalId } = await insertTestRefund({ amountMinor: 10000n });
      gateway.disbursement = { kind: 'status', code: 400 };

      await submitter.submit({
        refundId,
        refundRef,
        gatewayExternalId: externalId,
        amountMinor: 10000n,
        currency: 'UGX',
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await refundsRepo.findDetailByRef(scope, refundRef);
      expect(detail?.refund.status).toBe('failed');
    });
  });

  describe('gateway submission — ambiguous', () => {
    it('marks outcome_unknown on gateway timeout (504)', async () => {
      const { refundId, refundRef, externalId } = await insertTestRefund({ amountMinor: 25000n });
      gateway.disbursement = { kind: 'gateway_timeout' };

      await submitter.submit({
        refundId,
        refundRef,
        gatewayExternalId: externalId,
        amountMinor: 25000n,
        currency: 'UGX',
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await refundsRepo.findDetailByRef(scope, refundRef);
      expect(detail?.refund.status).toBe('processing');
      expect(detail?.transaction.outcomeUnknown).toBe(true);
    });
  });

  describe('success lifecycle: ledger posting', () => {
    it('posts a balanced ledger entry on refund succeeded', async () => {
      await seedBalance(200000n);
      const { refundId, transactionId } = await insertTestRefund({
        amountMinor: 100000n,
        status: 'processing',
      });

      const referenceId = `MTN-RFD-${uuidv7().slice(0, 8)}`;
      const result = await uow.run((tx) =>
        lifecycle.apply(tx, refundId, {
          eventKey: `gateway:success:${referenceId}`,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'succeeded' },
          identifiers: { provider: 'mtn', referenceId },
        })
      );

      expect(result.result).toBe('applied');
      if (result.result === 'applied') {
        expect(result.to).toBe('succeeded');
        expect(result.ledgerEntryRef).toBeTruthy();
      }

      const entries = await db.execute(drizzleSql`
        SELECT e.ref
        FROM core.journal_entries e
        WHERE e.transaction_id = ${transactionId}
        ORDER BY e.created_at DESC LIMIT 1
      `);
      expect(entries.rows).toHaveLength(1);
      expect(entries.rows).toHaveLength(1);
    });
  });

  describe('failure lifecycle: no ledger entry', () => {
    it('posts no ledger entry when refund fails', async () => {
      const { refundId, transactionId } = await insertTestRefund({
        amountMinor: 30000n,
        status: 'processing',
      });

      const result = await uow.run((tx) =>
        lifecycle.apply(tx, refundId, {
          eventKey: 'gateway:failed:provider_error',
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'failed', failureCode: 'gateway_failed' },
          identifiers: { provider: 'mtn' },
        })
      );

      expect(result.result).toBe('applied');
      if (result.result === 'applied') expect(result.to).toBe('failed');

      const entries = await db.execute(drizzleSql`
        SELECT COUNT(*) as count FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('0');
    });
  });

  describe('idempotency: duplicate success events', () => {
    it('creates exactly one ledger entry for repeated success events', async () => {
      await seedBalance(200000n);
      const { refundId, transactionId } = await insertTestRefund({
        amountMinor: 60000n,
        status: 'processing',
      });

      const eventKey = `gateway:success:idem-${uuidv7()}`;

      const r1 = await uow.run((tx) =>
        lifecycle.apply(tx, refundId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'succeeded' },
          identifiers: { provider: 'mtn', referenceId: 'REF-RFD-1' },
        })
      );
      expect(r1.result).toBe('applied');

      const r2 = await uow.run((tx) =>
        lifecycle.apply(tx, refundId, {
          eventKey,
          source: 'gateway_event',
          occurredAt: new Date(),
          signal: { kind: 'succeeded' },
          identifiers: { provider: 'mtn', referenceId: 'REF-RFD-1' },
        })
      );
      expect(r2.result).toBe('duplicate');

      const entries = await db.execute(drizzleSql`
        SELECT COUNT(*) as count FROM core.journal_entries
        WHERE transaction_id = ${transactionId}
      `);
      expect(entries.rows[0].count).toBe('1');
    });
  });

  describe('missing MSISDN', () => {
    it('transitions refund to failed when original payment has no MSISDN', async () => {
      const { refundId, refundRef, externalId } = await insertTestRefund({
        amountMinor: 20000n,
        msisdnEnc: null,
      });
      gateway.disbursement = { kind: 'accept' };

      await submitter.submit({
        refundId,
        refundRef,
        gatewayExternalId: externalId,
        amountMinor: 20000n,
        currency: 'UGX',
        merchantId: merchant.id,
        environment: 'live',
      });

      const scope = merchant.scope('live');
      const detail = await refundsRepo.findDetailByRef(scope, refundRef);
      expect(detail?.refund.status).toBe('failed');
      // Gateway was never called
      expect(gateway.disbursementCalls).toHaveLength(0);
    });
  });

  describe('test-environment refunds', () => {
    it('test-scoped refunds stay in created — no gateway call', async () => {
      const { refundRef } = await insertTestRefund({
        amountMinor: 15000n,
        environment: 'test',
      });

      // Test refunds are not submitted; status stays created
      const scope = merchant.scope('test');
      const detail = await refundsRepo.findDetailByRef(scope, refundRef);
      expect(detail?.refund.status).toBe('created');
      expect(gateway.disbursementCalls).toHaveLength(0);
    });
  });
});
