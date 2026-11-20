/**
 * Unit tests for PaymentGatewaySubmitter: MSISDN decryption and gateway submission.
 *
 * Tests cover:
 *  - Successful MSISDN decryption before gateway submission
 *  - Decryption failure handling (marks payment as failed)
 *  - Invalid MSISDN after decryption (marks payment as failed)
 *  - Missing MSISDN handling
 *  - Integration with routing and lifecycle services
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentGatewaySubmitter } from './payment-gateway-submitter.service';
import { RoutingService } from '../operations/routing/routing.service';
import type { GatewayOperationsPort } from '../../integrations/gateway/gateway-operations.port';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentsRepository } from './payments.repository';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { Logger } from 'pino';

describe('PaymentGatewaySubmitter', () => {
  let submitter: PaymentGatewaySubmitter;
  let routing: RoutingService;
  let gateway: GatewayOperationsPort;
  let lifecycle: PaymentLifecycleService;
  let payments: PaymentsRepository;
  let unitOfWork: UnitOfWork;
  let encryption: FieldEncryption;
  let logger: Logger;

  beforeEach(() => {
    routing = {
      selectProvider: vi.fn(),
    } as any;

    gateway = {
      submitCollection: vi.fn(),
    } as any;

    lifecycle = {
      apply: vi.fn(),
    } as any;

    payments = {} as any;

    unitOfWork = {
      run: vi.fn((fn) => fn({})),
    } as any;

    encryption = {
      decrypt: vi.fn(),
      encrypt: vi.fn(),
      available: true,
    } as any;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;

    submitter = new PaymentGatewaySubmitter(
      routing,
      gateway,
      lifecycle,
      payments,
      unitOfWork,
      encryption,
      { now: () => new Date('2026-01-01T00:00:00Z') } satisfies import('../../common/clock/clock').Clock,
      logger
    );
  });

  describe('MSISDN decryption', () => {
    const validInput = {
      paymentId: 'pay_123',
      paymentRef: 'pay_ref_123',
      gatewayExternalId: 'ext_123',
      amountMinor: 10000n,
      currency: 'TZS',
      merchantId: 'merchant_123',
      environment: 'live' as const,
      channel: 'mobile_money' as const,
    };

    it('should decrypt MSISDN before gateway submission', async () => {
      // Setup
      const encryptedMsisdn = 'v1.abc123.iv.tag.ciphertext';
      const decryptedMsisdn = '+255700123456';

      vi.mocked(encryption.decrypt).mockReturnValue(decryptedMsisdn);
      vi.mocked(routing.selectProvider).mockResolvedValue({
        provider: 'airtel',
        ruleRef: 'rule_001',
        reason: 'matched',
      });
      vi.mocked(gateway.submitCollection).mockResolvedValue({
        kind: 'accepted',
        referenceId: 'ref_123',
        duplicate: false,
        status: 'pending',
      });

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: encryptedMsisdn,
      });

      // Verify decryption was called with correct context
      expect(encryption.decrypt).toHaveBeenCalledWith(
        encryptedMsisdn,
        `payments.msisdn:${validInput.paymentRef}`
      );

      // Verify gateway was called with decrypted MSISDN
      expect(gateway.submitCollection).toHaveBeenCalledWith(
        expect.objectContaining({
          payer: {
            partyIdType: 'MSISDN',
            partyId: decryptedMsisdn,
          },
        })
      );
    });

    it('should mark payment as failed if decryption fails', async () => {
      // Setup
      const encryptedMsisdn = 'v1.bad.iv.tag.ciphertext';
      vi.mocked(encryption.decrypt).mockImplementation(() => {
        throw new Error('decryption failed');
      });

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: encryptedMsisdn,
      });

      // Verify payment was marked as failed
      expect(lifecycle.apply).toHaveBeenCalledWith(
        {},
        validInput.paymentId,
        expect.objectContaining({
          eventKey: 'decryption:failed',
          signal: expect.objectContaining({
            kind: 'failed',
            failureCode: 'msisdn_decryption_failed',
          }),
        })
      );

      // Verify gateway was never called
      expect(gateway.submitCollection).not.toHaveBeenCalled();

      // Verify error was logged
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentRef: validInput.paymentRef,
        }),
        'failed to decrypt or validate MSISDN'
      );
    });

    it('should mark payment as failed if decrypted MSISDN is invalid', async () => {
      // Setup
      const encryptedMsisdn = 'v1.abc123.iv.tag.ciphertext';
      const invalidMsisdn = 'not-a-valid-number!!!';

      vi.mocked(encryption.decrypt).mockReturnValue(invalidMsisdn);

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: encryptedMsisdn,
      });

      // Verify payment was marked as failed
      expect(lifecycle.apply).toHaveBeenCalledWith(
        {},
        validInput.paymentId,
        expect.objectContaining({
          eventKey: 'decryption:failed',
          signal: expect.objectContaining({
            kind: 'failed',
            failureCode: 'msisdn_decryption_failed',
          }),
        })
      );

      // Verify gateway was never called
      expect(gateway.submitCollection).not.toHaveBeenCalled();
    });

    it('should handle missing MSISDN (undefined msisdnEnc)', async () => {
      // Routing succeeds, but no MSISDN means mobile_money submission is refused.
      vi.mocked(routing.selectProvider).mockResolvedValue({
        provider: 'airtel',
        ruleRef: 'rule_001',
        reason: 'matched',
      });

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: undefined,
      });

      // Verify decryption was never called
      expect(encryption.decrypt).not.toHaveBeenCalled();

      // Verify payment was marked as failed — MSISDN is required for mobile_money
      expect(lifecycle.apply).toHaveBeenCalledWith(
        {},
        validInput.paymentId,
        expect.objectContaining({
          eventKey: 'validation:missing_msisdn',
          signal: expect.objectContaining({
            kind: 'failed',
            failureCode: 'missing_payment_method',
          }),
        })
      );

      // Verify gateway was never called
      expect(gateway.submitCollection).not.toHaveBeenCalled();
    });

    it('should handle null msisdnEnc', async () => {
      // Routing succeeds, but no MSISDN means mobile_money submission is refused.
      vi.mocked(routing.selectProvider).mockResolvedValue({
        provider: 'airtel',
        ruleRef: 'rule_001',
        reason: 'matched',
      });

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: null,
      });

      // Verify decryption was never called
      expect(encryption.decrypt).not.toHaveBeenCalled();

      // Verify payment was marked as failed — MSISDN is required for mobile_money
      expect(lifecycle.apply).toHaveBeenCalledWith(
        {},
        validInput.paymentId,
        expect.objectContaining({
          eventKey: 'validation:missing_msisdn',
          signal: expect.objectContaining({
            kind: 'failed',
            failureCode: 'missing_payment_method',
          }),
        })
      );

      // Verify gateway was never called
      expect(gateway.submitCollection).not.toHaveBeenCalled();
    });

    it('should never log decrypted MSISDN', async () => {
      // Setup
      const encryptedMsisdn = 'v1.abc123.iv.tag.ciphertext';
      const decryptedMsisdn = '+255700123456';

      vi.mocked(encryption.decrypt).mockReturnValue(decryptedMsisdn);
      vi.mocked(routing.selectProvider).mockResolvedValue({
        provider: 'airtel',
        ruleRef: 'rule_001',
        reason: 'matched',
      });
      vi.mocked(gateway.submitCollection).mockResolvedValue({
        kind: 'accepted',
        referenceId: 'ref_123',
        duplicate: false,
        status: 'pending',
      });

      // Execute
      await submitter.submit({
        ...validInput,
        msisdnEnc: encryptedMsisdn,
      });

      // Verify logger was never called with the decrypted MSISDN
      const allLogCalls = [
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
        ...vi.mocked(logger.error).mock.calls,
      ];

      for (const call of allLogCalls) {
        const callString = JSON.stringify(call);
        expect(callString).not.toContain(decryptedMsisdn);
        expect(callString).not.toContain('255700123456');
      }
    });
  });

  describe('routing and gateway integration', () => {
    it('should handle routing failure', async () => {
      // Setup
      const input = {
        paymentId: 'pay_123',
        paymentRef: 'pay_ref_123',
        gatewayExternalId: 'ext_123',
        amountMinor: 10000n,
        currency: 'TZS',
        merchantId: 'merchant_123',
        environment: 'live' as const,
        channel: 'mobile_money' as const,
        msisdnEnc: undefined,
      };

      vi.mocked(routing.selectProvider).mockRejectedValue(new Error('No route available'));

      // Execute
      await submitter.submit(input);

      // Verify payment was marked as failed
      expect(lifecycle.apply).toHaveBeenCalledWith(
        {},
        input.paymentId,
        expect.objectContaining({
          eventKey: 'routing:no_route',
          signal: expect.objectContaining({
            kind: 'failed',
            failureCode: 'no_route_available',
          }),
        })
      );

      // Verify gateway was never called
      expect(gateway.submitCollection).not.toHaveBeenCalled();
    });
  });
});
