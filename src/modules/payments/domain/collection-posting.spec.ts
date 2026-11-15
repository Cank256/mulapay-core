import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { validatePosting } from '../../ledger/domain/posting';
import { collectionPostingLines } from './collection-posting';

const MERCHANT_REF = 'mch_01JBX7ABCDEFGHJKMNPQRSTVWX';

function build(gross: bigint, fee = 0n, providerFee = 0n) {
  return collectionPostingLines({
    provider: 'mtn',
    merchantRef: MERCHANT_REF,
    grossMinor: gross,
    feeMinor: fee,
    providerFeeMinor: providerFee,
  });
}

function totals(lines: ReturnType<typeof build>) {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    if (l.direction === 'debit') debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  return { debit, credit };
}

function validate(lines: ReturnType<typeof build>) {
  return validatePosting({
    idempotencyKey: 'a'.repeat(64),
    environment: 'test',
    currency: 'UGX',
    source: 'payment',
    sourceId: 'evt_1',
    description: 'Collection succeeded',
    lines,
    createdBy: { type: 'system', id: 'payments' },
  });
}

describe('collectionPostingLines', () => {
  it('posts clearing against merchant payable when there are no fees', () => {
    const lines = build(10_000n);
    expect(lines).toEqual([
      { accountCode: '1000:provider_clearing:mtn', direction: 'debit', amountMinor: 10_000n },
      {
        accountCode: `2000:merchant_payable:${MERCHANT_REF}`,
        direction: 'credit',
        amountMinor: 10_000n,
      },
    ]);
    expect(validate(lines).totalMinor).toBe(10_000n);
  });

  it('adds the MulaPay fee and the provider fee lines of spec 5.5', () => {
    const lines = build(10_000n, 150n, 70n);
    expect(lines).toEqual([
      { accountCode: '1000:provider_clearing:mtn', direction: 'debit', amountMinor: 10_000n },
      {
        accountCode: `2000:merchant_payable:${MERCHANT_REF}`,
        direction: 'credit',
        amountMinor: 10_000n,
      },
      {
        accountCode: `2000:merchant_payable:${MERCHANT_REF}`,
        direction: 'debit',
        amountMinor: 150n,
      },
      { accountCode: '4000:fee_revenue', direction: 'credit', amountMinor: 150n },
      { accountCode: '5000:provider_fee_expense', direction: 'debit', amountMinor: 70n },
      { accountCode: '1000:provider_clearing:mtn', direction: 'credit', amountMinor: 70n },
    ]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(credit);
    expect(validate(lines).totalMinor).toBe(debit);
  });

  it('always balances', () => {
    for (const [g, f, p] of [
      [1n, 0n, 0n],
      [1n, 1n, 1n],
      [999_999n, 12_345n, 678n],
      [99_999_999_999n, 99_999_999_999n, 0n],
    ] as const) {
      const { debit, credit } = totals(build(g, f, p));
      expect(debit, `${g}/${f}/${p}`).toBe(credit);
    }
  });

  it('refuses amounts and fees the ledger could not post', () => {
    const reason = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        if (error instanceof AppError) return error.details?.reason;
        throw error;
      }
      return undefined;
    };
    expect(reason(() => build(0n))).toBe('amount_must_be_positive');
    expect(reason(() => build(100n, -1n))).toBe('fee');
    expect(reason(() => build(100n, 0n, -1n))).toBe('fee');
    expect(reason(() => build(100n, 101n))).toBe('fee_exceeds_amount');
    expect(reason(() => build(100n, 0n, 101n))).toBe('provider_fee_exceeds_amount');
  });
});
