import { describe, expect, it } from 'vitest';
import { computeSettlement, reserveWithheld, type SettlementInputs } from './settlement-calc';

const base: SettlementInputs = {
  grossMinor: 1_000_000n,
  refundMinor: 0n,
  feeMinor: 0n,
  reserveBps: 0,
  reserveDueMinor: 0n,
  disputeHoldMinor: 0n,
  amlHoldMinor: 0n,
  availablePayableMinor: 1_000_000n,
  minPayoutMinor: 10_000n,
};

describe('settlement payable', () => {
  it('is gross less refunds, fees, reserve and holds', () => {
    const d = computeSettlement({
      ...base,
      refundMinor: 100_000n,
      feeMinor: 20_000n,
      reserveBps: 500,
      disputeHoldMinor: 30_000n,
      amlHoldMinor: 10_000n,
    });
    expect(d.kind).toBe('settle');
    expect(d.amounts).toMatchObject({
      reserveMinor: 50_000n,
      payableDrawMinor: 790_000n,
      netMinor: 790_000n,
      shortfallMinor: 0n,
    });
  });

  it('releases earlier reserve into the payout and keeps net = draw + release', () => {
    const d = computeSettlement({ ...base, reserveDueMinor: 25_000n });
    expect(d.amounts.netMinor).toBe(d.amounts.payableDrawMinor + 25_000n);
    expect(d.amounts.reserveReleaseMinor).toBe(25_000n);
  });

  it('rounds the reserve down to a whole minor unit', () => {
    expect(reserveWithheld(999n, 1)).toBe(0n);
    expect(reserveWithheld(10_001n, 1)).toBe(1n);
    expect(reserveWithheld(1_000_000n, 10_000)).toBe(1_000_000n);
  });

  it('rolls a dust amount over instead of creating a payout', () => {
    const d = computeSettlement({ ...base, grossMinor: 9_999n, availablePayableMinor: 9_999n });
    expect(d.kind).toBe('roll_over');
    expect(d.amounts.netMinor).toBe(9_999n);
    const exact = computeSettlement({
      ...base,
      grossMinor: 10_000n,
      availablePayableMinor: 10_000n,
    });
    expect(exact.kind).toBe('settle');
  });

  it('settles nothing when nothing was earned', () => {
    expect(computeSettlement({ ...base, grossMinor: 0n }).kind).toBe('nothing');
  });

  it('pays nothing from payable when refunds exceed receipts', () => {
    const d = computeSettlement({ ...base, grossMinor: 100n, refundMinor: 500n });
    expect(d.kind).toBe('nothing');
    expect(d.amounts.payableDrawMinor).toBe(0n);
  });

  it('never draws more than the available payable and reports the shortfall', () => {
    const d = computeSettlement({ ...base, availablePayableMinor: 400_000n });
    expect(d.amounts.payableDrawMinor).toBe(400_000n);
    expect(d.amounts.shortfallMinor).toBe(600_000n);
  });

  it('never withholds more reserve than is available', () => {
    const d = computeSettlement({ ...base, reserveBps: 5_000, availablePayableMinor: 100_000n });
    expect(d.amounts.reserveMinor).toBe(100_000n);
    expect(d.amounts.payableDrawMinor).toBe(0n);
    expect(d.amounts.reserveMinor + d.amounts.payableDrawMinor).toBeLessThanOrEqual(100_000n);
  });

  it('treats a negative available balance as zero', () => {
    const d = computeSettlement({ ...base, availablePayableMinor: -5n });
    expect(d.amounts.payableDrawMinor).toBe(0n);
  });

  it('refuses negative inputs and a bad reserve rate', () => {
    expect(() => computeSettlement({ ...base, grossMinor: -1n })).toThrow(RangeError);
    expect(() => computeSettlement({ ...base, reserveBps: 10_001 })).toThrow(RangeError);
    expect(() => computeSettlement({ ...base, reserveBps: 1.5 })).toThrow(RangeError);
  });

  it('is exact beyond 2^53 (bigint, no floating point)', () => {
    const big = 9_007_199_254_740_993n;
    const d = computeSettlement({ ...base, grossMinor: big, availablePayableMinor: big });
    expect(d.amounts.netMinor).toBe(big);
  });
});
