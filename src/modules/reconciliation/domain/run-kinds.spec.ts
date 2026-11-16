import { describe, expect, it } from 'vitest';
import { LOSS_WRITEOFF_ACCOUNT, isWriteOffSource } from './resolution';
import {
  bucketStart,
  isRunKind,
  manualRunKey,
  scheduledRunKey,
  scopeKeyOf,
  scopeRecord,
} from './run-kinds';
import { defaultSeverity, isOpenStatus } from './exception-kinds';
import { toJsonObject } from '../exception-recorder';

describe('run keys', () => {
  const scope = { environment: 'live' as const };
  it('puts every instant of a bucket in the same run', () => {
    const a = scheduledRunKey('gateway_gap', new Date('2025-03-01T10:00:01Z'), scope, 300);
    const b = scheduledRunKey('gateway_gap', new Date('2025-03-01T10:04:59Z'), scope, 300);
    const c = scheduledRunKey('gateway_gap', new Date('2025-03-01T10:05:00Z'), scope, 300);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('buckets integrity by hour and the proof by UTC day', () => {
    expect(scheduledRunKey('ledger_integrity', new Date('2025-03-01T10:59:00Z'), scope, 300)).toBe(
      scheduledRunKey('ledger_integrity', new Date('2025-03-01T10:01:00Z'), scope, 300)
    );
    expect(
      scheduledRunKey('balance_proof', new Date('2025-03-01T23:59:00Z'), scope, 300)
    ).toContain('2025-03-01');
  });
  it('keys a statement run by the statement and separates scopes', () => {
    expect(
      scheduledRunKey('provider_statement', new Date(), { ...scope, statement: 'pst_1' }, 0)
    ).toBe('statement:pst_1');
    expect(scopeKeyOf(scope)).not.toBe(scopeKeyOf({ ...scope, currency: 'UGX' }));
    expect(scopeRecord({ ...scope, currency: 'UGX' })).toEqual({
      environment: 'live',
      currency: 'UGX',
    });
    expect(manualRunKey('balance_proof', 'k')).toBe('manual:balance_proof:k');
    expect(bucketStart(new Date('2025-03-01T10:07:00Z'), 300).toISOString()).toBe(
      '2025-03-01T10:05:00.000Z'
    );
    expect(isRunKind('gateway_gap')).toBe(true);
    expect(isRunKind('nope')).toBe(false);
  });
});

describe('write-off sources and exception helpers', () => {
  it('allows platform asset accounts and refuses merchant liabilities', () => {
    for (const ok of [
      '1000:provider_clearing:mtn',
      '1010:provider_float:airtel',
      '9000:suspense',
      '1100:bank:main_ug',
    ]) {
      expect(isWriteOffSource(ok), ok).toBe(true);
    }
    for (const bad of [
      '2000:merchant_payable:mch_01JBX7ABCDEFGHJKMNPQRSTVWX',
      '2010:merchant_reserve:mch_01JBX7ABCDEFGHJKMNPQRSTVWX',
      '4000:fee_revenue',
      LOSS_WRITEOFF_ACCOUNT,
      'garbage',
    ]) {
      expect(isWriteOffSource(bad), bad).toBe(false);
    }
  });
  it('knows severities and open statuses', () => {
    expect(defaultSeverity('ledger_unbalanced_entry')).toBe('critical');
    expect(isOpenStatus('investigating')).toBe(true);
    expect(isOpenStatus('written_off')).toBe(false);
  });
  it('makes exception payloads JSON-safe', () => {
    expect(
      toJsonObject({
        a: 1n,
        b: new Date('2025-01-01T00:00:00Z'),
        c: undefined,
        d: [2n],
        e: { f: 3n },
      })
    ).toEqual({
      a: '1',
      b: '2025-01-01T00:00:00.000Z',
      d: ['2'],
      e: { f: '3' },
    });
  });
});
