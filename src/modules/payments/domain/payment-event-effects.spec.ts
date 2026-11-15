import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import {
  addsInformation,
  changeFor,
  verifyEvent,
  type TransactionFacts,
} from './payment-event-effects';
import type { PaymentEventInput, PaymentSignal } from './payment-event';

const NOW = new Date('2025-06-01T12:00:00Z');
const OP = '0190e8a0-7c11-7aaa-8bbb-0123456789ab';

const facts = (overrides: Partial<TransactionFacts> = {}): TransactionFacts => ({
  amountMinor: 10_000n,
  currency: 'UGX',
  provider: null,
  gatewayOperationId: null,
  gatewayReferenceId: null,
  providerTransactionId: null,
  initiatedAt: null,
  outcomeUnknown: false,
  ...overrides,
});

const event = (
  signal: PaymentSignal,
  identifiers: PaymentEventInput['identifiers'] = undefined
): PaymentEventInput => ({
  eventKey: 'evt-1',
  source: 'gateway_event',
  occurredAt: NOW,
  signal,
  identifiers,
});

describe('verifyEvent', () => {
  it('accepts a success that matches the payment, or says nothing about the amount', () => {
    expect(verifyEvent(facts(), event({ kind: 'succeeded' }))).toBeNull();
    expect(
      verifyEvent(facts(), event({ kind: 'succeeded', amountMinor: 10_000n, currency: 'UGX' }))
    ).toBeNull();
  });

  it('refuses a success with another amount or currency', () => {
    expect(verifyEvent(facts(), event({ kind: 'succeeded', amountMinor: 9_999n }))).toBe(
      'amount_mismatch'
    );
    expect(verifyEvent(facts(), event({ kind: 'succeeded', amountMinor: 10_001n }))).toBe(
      'amount_mismatch'
    );
    expect(verifyEvent(facts(), event({ kind: 'succeeded', currency: 'KES' }))).toBe(
      'currency_mismatch'
    );
  });

  it('does not check amounts on events that carry none', () => {
    expect(verifyEvent(facts(), event({ kind: 'failed', failureCode: 'declined' }))).toBeNull();
  });

  it('refuses another provider than the recorded one, and accepts the same or a first one', () => {
    expect(
      verifyEvent(facts({ provider: 'mtn' }), event({ kind: 'succeeded' }, { provider: 'airtel' }))
    ).toBe('provider_mismatch');
    expect(
      verifyEvent(facts({ provider: 'mtn' }), event({ kind: 'succeeded' }, { provider: 'mtn' }))
    ).toBeNull();
    expect(verifyEvent(facts(), event({ kind: 'succeeded' }, { provider: 'airtel' }))).toBeNull();
  });

  it('refuses a different gateway identifier than the recorded one, and accepts a repeat or a first', () => {
    const recorded = facts({
      gatewayOperationId: OP,
      gatewayReferenceId: 'ref-1',
      providerTransactionId: 'ptx-1',
    });
    const signal: PaymentSignal = { kind: 'processing', outcomeUnknown: false };
    for (const identifiers of [
      { operationId: '0190e8a0-7c11-7aaa-8bbb-ffffffffffff' },
      { referenceId: 'ref-2' },
      { providerTransactionId: 'ptx-2' },
    ]) {
      expect(verifyEvent(recorded, event(signal, identifiers))).toBe('identifier_conflict');
    }
    expect(
      verifyEvent(
        recorded,
        event(signal, { operationId: OP, referenceId: 'ref-1', providerTransactionId: 'ptx-1' })
      )
    ).toBeNull();
    expect(verifyEvent(facts(), event(signal, { referenceId: 'ref-1' }))).toBeNull();
  });
});

describe('changeFor', () => {
  it('stamps initiation when the payment first reaches a provider, and keeps it after', () => {
    expect(
      changeFor(facts(), event({ kind: 'processing', outcomeUnknown: false }), 'processing', NOW)
        .initiatedAt
    ).toEqual(NOW);
    expect(
      changeFor(facts(), event({ kind: 'requires_action' }), 'requires_action', NOW).initiatedAt
    ).toEqual(NOW);
    const earlier = new Date('2025-06-01T11:00:00Z');
    expect(
      changeFor(
        facts({ initiatedAt: earlier }),
        event({ kind: 'processing', outcomeUnknown: false }),
        'processing',
        NOW
      ).initiatedAt
    ).toEqual(earlier);
    expect(
      changeFor(facts(), event({ kind: 'cancelled' }), 'cancelled', NOW).initiatedAt
    ).toBeNull();
  });

  it('sets the outcome flag only for processing', () => {
    const unknown = event({ kind: 'processing', outcomeUnknown: true });
    expect(changeFor(facts(), unknown, 'processing', NOW).outcomeUnknown).toBe(true);
    expect(
      changeFor(
        facts({ outcomeUnknown: true }),
        event({ kind: 'failed', failureCode: 'declined' }),
        'failed',
        NOW
      ).outcomeUnknown
    ).toBe(false);
    expect(
      changeFor(
        facts({ outcomeUnknown: true }),
        event({ kind: 'succeeded' }, { provider: 'mtn' }),
        'succeeded',
        NOW
      ).outcomeUnknown
    ).toBe(false);
  });

  it('stamps completion only for terminal statuses', () => {
    expect(
      changeFor(facts(), event({ kind: 'processing', outcomeUnknown: false }), 'processing', NOW)
        .completedAt
    ).toBeUndefined();
    for (const signal of [
      { kind: 'failed', failureCode: 'declined' },
      { kind: 'cancelled' },
      { kind: 'expired' },
    ] as PaymentSignal[]) {
      expect(changeFor(facts(), event(signal), signal.kind as 'failed', NOW).completedAt).toEqual(
        NOW
      );
    }
  });

  it('keeps identifiers already recorded and takes new ones from the event', () => {
    const change = changeFor(
      facts({ provider: 'mtn', gatewayReferenceId: 'ref-1' }),
      event(
        { kind: 'processing', outcomeUnknown: false },
        { provider: 'mtn', referenceId: 'ref-1', operationId: OP }
      ),
      'processing',
      NOW
    );
    expect(change).toMatchObject({
      provider: 'mtn',
      gatewayReferenceId: 'ref-1',
      gatewayOperationId: OP,
    });
  });

  it('records the failure code and reason of an unsuccessful ending', () => {
    expect(
      changeFor(
        facts(),
        event({ kind: 'failed', failureCode: 'declined', failureReason: 'No funds' }),
        'failed',
        NOW
      )
    ).toMatchObject({ failureCode: 'declined', failureReason: 'No funds' });
    expect(changeFor(facts(), event({ kind: 'expired' }), 'expired', NOW)).toMatchObject({
      failureCode: null,
      failureReason: null,
    });
  });

  it('sets fee and net on success, and defaults the fee to zero', () => {
    const base = event({ kind: 'succeeded' }, { provider: 'mtn' });
    expect(changeFor(facts(), base, 'succeeded', NOW)).toMatchObject({
      feeMinor: 0n,
      netMinor: 10_000n,
    });
    expect(
      changeFor(
        facts(),
        event({ kind: 'succeeded', feeMinor: 250n }, { provider: 'mtn' }),
        'succeeded',
        NOW
      )
    ).toMatchObject({ feeMinor: 250n, netMinor: 9_750n });
  });

  it('refuses a success with no known provider', () => {
    expect(() => changeFor(facts(), event({ kind: 'succeeded' }), 'succeeded', NOW)).toThrow(
      AppError
    );
    try {
      changeFor(facts(), event({ kind: 'succeeded' }), 'succeeded', NOW);
    } catch (error) {
      expect((error as AppError).details).toEqual({ reason: 'provider_required' });
    }
    expect(
      changeFor(facts({ provider: 'mtn' }), event({ kind: 'succeeded' }), 'succeeded', NOW).provider
    ).toBe('mtn');
  });
});

describe('addsInformation', () => {
  const same = (f: TransactionFacts) =>
    changeFor(
      f,
      event({ kind: 'processing', outcomeUnknown: f.outcomeUnknown }),
      'processing',
      NOW
    );

  it('is false for an event that repeats what is recorded', () => {
    const f = facts({ provider: 'mtn', initiatedAt: NOW });
    expect(addsInformation(f, same(f))).toBe(false);
  });

  it('is true when the flag, the provider, an identifier or the first initiation changes', () => {
    const f = facts({ provider: 'mtn', initiatedAt: NOW });
    expect(addsInformation(f, { ...same(f), outcomeUnknown: true })).toBe(true);
    expect(addsInformation(f, { ...same(f), gatewayOperationId: OP })).toBe(true);
    expect(addsInformation(f, { ...same(f), gatewayReferenceId: 'r' })).toBe(true);
    expect(addsInformation(f, { ...same(f), providerTransactionId: 'p' })).toBe(true);
    expect(addsInformation(facts(), same(facts()))).toBe(true); // first initiation
    expect(
      addsInformation(facts({ initiatedAt: NOW }), {
        ...same(facts({ initiatedAt: NOW })),
        provider: 'airtel',
      })
    ).toBe(true);
  });
});
