import { describe, expect, it } from 'vitest';
import { applyDelta, postedBalance } from './posted-balance';

describe('postedBalance (spec 6.7)', () => {
  it('is debits minus credits on debit-normal accounts', () => {
    expect(postedBalance('debit', 700n, 200n)).toBe(500n);
    expect(postedBalance('debit', 200n, 700n)).toBe(-500n);
  });

  it('is credits minus debits on credit-normal accounts', () => {
    expect(postedBalance('credit', 200n, 700n)).toBe(500n);
    expect(postedBalance('credit', 700n, 200n)).toBe(-500n);
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 2n ** 62n;
    expect(postedBalance('credit', 1n, big + 1n)).toBe(big);
  });
});

describe('applyDelta', () => {
  it('adds to both totals, so a reversal grows the other side instead of subtracting', () => {
    const posted = applyDelta({ debits: 0n, credits: 0n }, { debits: 0n, credits: 1_000n });
    const reversed = applyDelta(posted, { debits: 1_000n, credits: 0n });
    expect(reversed).toEqual({ debits: 1_000n, credits: 1_000n });
    expect(postedBalance('credit', reversed.debits, reversed.credits)).toBe(0n);
  });
});
