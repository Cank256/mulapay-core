import { describe, expect, it } from 'vitest';
import { matchStatement, type CoreCandidate, type StatementRowInput } from './statement-matching';

const t = (iso: string) => new Date(iso);
const row = (
  rowNo: number,
  providerRef: string,
  amountMinor: bigint,
  at = '2025-03-01T10:00:00Z'
): StatementRowInput => ({
  rowNo,
  providerRef,
  amountMinor,
  currency: 'UGX',
  occurredAt: t(at),
});
const core = (
  id: string,
  providerTransactionId: string | null,
  amountMinor: bigint,
  at = '2025-03-01T10:00:30Z'
): CoreCandidate => ({
  id,
  ref: `txn_${id}`,
  providerTransactionId,
  amountMinor,
  currency: 'UGX',
  completedAt: t(at),
});
const opts = { windowMs: 3_600_000, previouslyMatchedRefs: new Set<string>() };

describe('statement matching', () => {
  it('matches on provider reference first', () => {
    const r = matchStatement([row(1, 'P1', 500n)], [core('a', 'P1', 500n)], opts);
    expect(r.rows[0]).toMatchObject({ status: 'matched_reference', transactionId: 'a' });
    expect(r.unmatchedCore).toEqual([]);
  });

  it('flags a reference match whose amount differs as a mismatch, and uses the transaction up', () => {
    const r = matchStatement([row(1, 'P1', 500n)], [core('a', 'P1', 400n)], opts);
    expect(r.rows[0]).toMatchObject({
      status: 'mismatch',
      transactionId: 'a',
      note: 'amount_or_currency_differs',
    });
    expect(r.unmatchedCore).toEqual([]);
  });

  it('falls back to amount, currency and the date window', () => {
    const r = matchStatement([row(1, 'X', 700n)], [core('a', null, 700n)], opts);
    expect(r.rows[0]).toMatchObject({ status: 'matched_amount', transactionId: 'a' });
  });

  it('does not match outside the window, on another amount, or a transaction that has its own reference', () => {
    const late = core('a', null, 700n, '2025-03-01T13:00:00Z');
    const other = core('b', null, 701n);
    const owned = core('c', 'OTHER', 700n);
    const r = matchStatement([row(1, 'X', 700n)], [late, other, owned], opts);
    expect(r.rows[0]?.status).toBe('unmatched');
    expect(r.unmatchedCore.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('picks the closest transaction and never matches one transaction twice', () => {
    const near = core('near', null, 700n, '2025-03-01T10:00:10Z');
    const far = core('far', null, 700n, '2025-03-01T10:20:00Z');
    const r = matchStatement([row(1, 'A', 700n), row(2, 'B', 700n)], [far, near], opts);
    expect(r.rows.map((x) => [x.status, x.transactionId])).toEqual([
      ['matched_amount', 'near'],
      ['matched_amount', 'far'],
    ]);
    const third = matchStatement(
      [row(1, 'A', 700n), row(2, 'B', 700n), row(3, 'C', 700n)],
      [far, near],
      opts
    );
    expect(third.rows[2]?.status).toBe('unmatched');
  });

  it('marks a repeated or previously matched reference as a duplicate that matches nothing', () => {
    const r = matchStatement(
      [row(1, 'P1', 500n), row(2, 'P1', 500n), row(3, 'OLD', 500n)],
      [core('a', 'P1', 500n)],
      { ...opts, previouslyMatchedRefs: new Set(['OLD']) }
    );
    expect(r.rows.map((x) => x.status)).toEqual(['matched_reference', 'duplicate', 'duplicate']);
    expect(r.rows[1]?.note).toBe('repeated_in_statement');
    expect(r.rows[2]?.note).toBe('matched_by_earlier_statement');
  });

  it('reports core transactions the statement does not contain', () => {
    const r = matchStatement(
      [row(1, 'P1', 500n)],
      [core('a', 'P1', 500n), core('z', 'P9', 900n)],
      opts
    );
    expect(r.unmatchedCore.map((c) => c.id)).toEqual(['z']);
  });

  it('breaks time ties by transaction ref, deterministically', () => {
    const a = core('b', null, 5n, '2025-03-01T10:00:00Z');
    const b = core('a', null, 5n, '2025-03-01T10:00:00Z');
    const r = matchStatement([row(1, 'X', 5n)], [a, b], opts);
    expect(r.rows[0]?.transactionId).toBe('a');
  });
});
