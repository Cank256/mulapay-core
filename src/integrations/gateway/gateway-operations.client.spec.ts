import { describe, expect, it } from 'vitest';
import { balanceToMinor, parseOperation } from './gateway-operations.client';

const op = {
  providerId: 'airtel',
  operationType: 'disbursement',
  referenceId: 'ref-1',
  externalId: 'po_1',
  status: 'successful',
  amount: '1000.0000',
  currency: 'UGX',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:01:00.000Z',
};

describe('gateway operation parsing', () => {
  it('maps a well-formed operation', () => {
    expect(parseOperation(op)).toMatchObject({
      externalId: 'po_1',
      status: 'successful',
      amount: '1000.0000',
      referenceId: 'ref-1',
    });
    expect(parseOperation({ ...op, referenceId: null })?.referenceId).toBeNull();
  });

  it('refuses anything that is not an operation core understands', () => {
    for (const bad of [
      null,
      'x',
      [],
      { ...op, status: 'weird' },
      { ...op, operationType: 'transfer' },
      { ...op, externalId: '' },
      { ...op, amount: undefined },
      { ...op, createdAt: 'not a date' },
    ]) {
      expect(parseOperation(bad)).toBeUndefined();
    }
  });
});

describe('gateway balances', () => {
  it('converts to minor units exactly, and zero is a balance', () => {
    expect(balanceToMinor('1000.0000', 'UGX')).toBe(1000n);
    expect(balanceToMinor('10.5000', 'KES')).toBe(1050n);
    expect(balanceToMinor('0.0000', 'UGX')).toBe(0n);
    expect(balanceToMinor('0', 'KES')).toBe(0n);
  });
  it('refuses a balance that cannot be represented', () => {
    expect(() => balanceToMinor('10.123', 'UGX')).toThrow();
    expect(() => balanceToMinor('abc', 'UGX')).toThrow();
    expect(() => balanceToMinor('5', 'XXX')).toThrow();
  });
});
