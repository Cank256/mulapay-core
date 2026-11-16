import { describe, expect, it } from 'vitest';
import { settlementPostings } from './settlement-posting';

const MERCHANT = 'mch_01JBX7ABCDEFGHJKMNPQRSTVWX';
const sum = (lines: readonly { direction: string; amountMinor: bigint }[], d: string) =>
  lines.filter((l) => l.direction === d).reduce((s, l) => s + l.amountMinor, 0n);

function balanced(lines: readonly { direction: string; amountMinor: bigint }[]) {
  expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
}

describe('settlement postings', () => {
  it('matches spec 5.5 when nothing is released: DR payable N+V, CR reserve V, CR in transit N', () => {
    const p = settlementPostings({
      merchantRef: MERCHANT,
      provider: 'mtn',
      payableDrawMinor: 900n,
      reserveWithheldMinor: 100n,
      reserveReleasedMinor: 0n,
    });
    expect(p.released).toEqual([
      { accountCode: `2000:merchant_payable:${MERCHANT}`, direction: 'debit', amountMinor: 1000n },
      { accountCode: `2010:merchant_reserve:${MERCHANT}`, direction: 'credit', amountMinor: 100n },
      { accountCode: '1200:settlement_in_transit', direction: 'credit', amountMinor: 900n },
    ]);
    expect(p.confirmed).toEqual([
      { accountCode: '1200:settlement_in_transit', direction: 'debit', amountMinor: 900n },
      { accountCode: '1010:provider_float:mtn', direction: 'credit', amountMinor: 900n },
    ]);
    balanced(p.released);
    balanced(p.confirmed);
  });

  it('balances for every mix of withheld and released reserve', () => {
    for (const [draw, v, r] of [
      [500n, 0n, 0n],
      [500n, 50n, 0n],
      [500n, 0n, 70n],
      [500n, 50n, 70n],
      [500n, 70n, 50n],
      [500n, 60n, 60n],
      [0n, 0n, 80n],
      [0n, 30n, 80n],
    ] as const) {
      const p = settlementPostings({
        merchantRef: MERCHANT,
        provider: 'airtel',
        payableDrawMinor: draw,
        reserveWithheldMinor: v,
        reserveReleasedMinor: r,
      });
      balanced(p.released);
      balanced(p.confirmed);
      expect(p.netMinor).toBe(draw + r);
      expect(p.released.every((l) => l.amountMinor > 0n)).toBe(true);
    }
  });

  it('uses one reserve line, a debit when more is released than withheld', () => {
    const p = settlementPostings({
      merchantRef: MERCHANT,
      provider: 'mtn',
      payableDrawMinor: 0n,
      reserveWithheldMinor: 30n,
      reserveReleasedMinor: 80n,
    });
    expect(p.released.filter((l) => l.accountCode.startsWith('2010'))).toEqual([
      { accountCode: `2010:merchant_reserve:${MERCHANT}`, direction: 'debit', amountMinor: 50n },
    ]);
  });

  it('refuses a posting with no net amount or a negative part', () => {
    const input = {
      merchantRef: MERCHANT,
      provider: 'mtn' as const,
      payableDrawMinor: 0n,
      reserveWithheldMinor: 5n,
      reserveReleasedMinor: 0n,
    };
    expect(() => settlementPostings(input)).toThrow(RangeError);
    expect(() => settlementPostings({ ...input, payableDrawMinor: -1n })).toThrow(RangeError);
  });
});
