import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import {
  isPaymentProvider,
  signalTarget,
  validatePaymentEvent,
  type PaymentEventInput,
} from './payment-event';

const base: PaymentEventInput = {
  eventKey: 'evt_01',
  source: 'gateway_event',
  occurredAt: new Date('2025-01-01T00:00:00Z'),
  signal: { kind: 'processing', outcomeUnknown: false },
};

function reasonOf(event: PaymentEventInput): string | undefined {
  try {
    validatePaymentEvent(event);
  } catch (error) {
    if (error instanceof AppError) return error.details?.reason as string;
    throw error;
  }
  return undefined;
}

describe('signalTarget', () => {
  it('maps each signal to the status of the same name', () => {
    expect(signalTarget({ kind: 'requires_action' })).toBe('requires_action');
    expect(signalTarget({ kind: 'processing', outcomeUnknown: true })).toBe('processing');
    expect(signalTarget({ kind: 'succeeded' })).toBe('succeeded');
    expect(signalTarget({ kind: 'failed', failureCode: 'declined' })).toBe('failed');
    expect(signalTarget({ kind: 'cancelled' })).toBe('cancelled');
    expect(signalTarget({ kind: 'expired' })).toBe('expired');
  });
});

describe('validatePaymentEvent', () => {
  it('accepts well-formed events', () => {
    expect(reasonOf(base)).toBeUndefined();
    expect(reasonOf({ ...base, signal: { kind: 'requires_action' } })).toBeUndefined();
    expect(
      reasonOf({
        ...base,
        signal: {
          kind: 'succeeded',
          amountMinor: 1000n,
          currency: 'UGX',
          feeMinor: 0n,
          providerFeeMinor: 10n,
        },
        identifiers: {
          provider: 'mtn',
          operationId: '0190e8a0-7c11-7aaa-8bbb-0123456789ab',
          referenceId: 'ref-1',
          providerTransactionId: 'ptx_1',
        },
      })
    ).toBeUndefined();
    expect(
      reasonOf({
        ...base,
        signal: { kind: 'failed', failureCode: 'insufficient_funds', failureReason: 'No funds' },
      })
    ).toBeUndefined();
    expect(reasonOf({ ...base, signal: { kind: 'cancelled' } })).toBeUndefined();
    expect(
      reasonOf({ ...base, signal: { kind: 'expired', failureCode: 'timeout' } })
    ).toBeUndefined();
  });

  it('refuses a malformed event key, source or time', () => {
    expect(reasonOf({ ...base, eventKey: '' })).toBe('event_key');
    expect(reasonOf({ ...base, eventKey: 'has space' })).toBe('event_key');
    expect(reasonOf({ ...base, eventKey: 'x'.repeat(97) })).toBe('event_key');
    expect(reasonOf({ ...base, eventKey: 'x'.repeat(96) })).toBeUndefined();
    expect(reasonOf({ ...base, source: 'webhook' as never })).toBe('source');
    expect(reasonOf({ ...base, occurredAt: new Date('nope') })).toBe('occurred_at');
  });

  it('refuses malformed gateway identifiers', () => {
    expect(reasonOf({ ...base, identifiers: { provider: 'stripe' as never } })).toBe('provider');
    expect(reasonOf({ ...base, identifiers: { operationId: 'not-a-uuid' } })).toBe('operation_id');
    expect(reasonOf({ ...base, identifiers: { referenceId: 'a b' } })).toBe('reference_id');
    expect(reasonOf({ ...base, identifiers: { providerTransactionId: '' } })).toBe(
      'provider_transaction_id'
    );
  });

  it('refuses a malformed failure code or reason', () => {
    expect(reasonOf({ ...base, signal: { kind: 'failed', failureCode: 'Bad Code' } })).toBe(
      'failure_code'
    );
    expect(
      reasonOf({ ...base, signal: { kind: 'cancelled', failureReason: 'no code given' } })
    ).toBe('failure_reason_without_code');
    expect(
      reasonOf({
        ...base,
        signal: { kind: 'expired', failureCode: 'timeout', failureReason: 'x'.repeat(501) },
      })
    ).toBe('failure_reason');
  });

  it('refuses a malformed success amount, currency or fee', () => {
    expect(reasonOf({ ...base, signal: { kind: 'succeeded', amountMinor: 0n } })).toBe('amount');
    expect(reasonOf({ ...base, signal: { kind: 'succeeded', currency: 'XXX' } })).toBe('currency');
    expect(reasonOf({ ...base, signal: { kind: 'succeeded', feeMinor: -1n } })).toBe('fee');
    expect(reasonOf({ ...base, signal: { kind: 'succeeded', providerFeeMinor: -1n } })).toBe('fee');
  });

  it('knows the providers', () => {
    expect(isPaymentProvider('mtn')).toBe(true);
    expect(isPaymentProvider('stripe')).toBe(false);
  });
});
