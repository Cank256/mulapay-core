import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  chainHash,
  changedFields,
  GENESIS_HASH,
  toJsonValue,
  verifyBatch,
  type ChainedFields,
  type ChainedRow,
  type JsonValue,
} from './audit-chain';

function fields(seq: number, overrides: Partial<ChainedFields> = {}): ChainedFields {
  return {
    seq,
    actorType: 'user',
    actorId: 'usr_1',
    actorLabel: 'Ada',
    merchantId: null,
    action: 'merchant.updated',
    resourceType: 'merchant',
    resourceId: 'mch_1',
    before: { status: 'draft' },
    after: { status: 'active' },
    changedFields: ['status'],
    ip: '10.0.0.1',
    userAgent: 'test',
    requestId: 'req-1',
    traceId: null,
    surface: 'admin',
    outcome: 'success',
    createdAt: new Date(`2025-01-01T00:00:0${seq}.000Z`),
    ...overrides,
  };
}

function chain(count: number): ChainedRow[] {
  const rows: ChainedRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= count; seq++) {
    const f = fields(seq);
    const hash = chainHash(prev, f);
    rows.push({ ...f, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

const start = { lastSeq: 0, lastHash: GENESIS_HASH };

describe('canonical JSON', () => {
  it('sorts keys at every depth and normalises like a jsonb round trip', () => {
    const value = toJsonValue({
      b: 1,
      a: { d: new Date(0), c: 10n },
      skip: undefined,
      list: [undefined, 'x'],
    });
    expect(canonicalJson(value as JsonValue)).toBe(
      '{"a":{"c":"10","d":"1970-01-01T00:00:00.000Z"},"b":1,"list":[null,"x"]}'
    );
    expect(toJsonValue(() => 1)).toBeUndefined();
    expect(() => toJsonValue(Number.NaN)).toThrow(/finite/);
  });

  it('hashes reordered jsonb objects identically', () => {
    const a = fields(1, { after: { x: 1, y: { b: 2, a: 1 } } });
    const b = fields(1, { after: { y: { a: 1, b: 2 }, x: 1 } });
    expect(chainHash(GENESIS_HASH, a)).toBe(chainHash(GENESIS_HASH, b));
  });

  it('ignores properties that are not hashed (prevHash, hash)', () => {
    const [row] = chain(1);
    expect(row && chainHash(GENESIS_HASH, row)).toBe(row?.hash);
  });
});

describe('verifyBatch', () => {
  it('accepts an intact chain and returns the new cursor', () => {
    const rows = chain(3);
    const result = verifyBatch(start, rows);
    expect(result).toEqual({ ok: true, cursor: { lastSeq: 3, lastHash: rows[2]?.hash } });
  });

  it('detects an edited row', () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, after: { status: 'closed' } };
    expect(verifyBatch(start, rows)).toEqual({
      ok: false,
      break: { seq: 2, reason: 'hash_mismatch' },
    });
  });

  it('detects a deleted row as a gap', () => {
    const rows = chain(3);
    expect(verifyBatch(start, [rows[0]!, rows[2]!])).toEqual({
      ok: false,
      break: { seq: 3, reason: 'sequence_gap' },
    });
  });

  it('detects a re-linked row', () => {
    const rows = chain(2);
    rows[1] = { ...rows[1]!, prevHash: GENESIS_HASH };
    expect(verifyBatch(start, rows)).toEqual({
      ok: false,
      break: { seq: 2, reason: 'prev_hash_mismatch' },
    });
  });
});

describe('changedFields', () => {
  it('lists keys whose values differ, sorted', () => {
    expect(
      changedFields({ a: 1, b: { x: 1 }, c: 'same' }, { a: 2, b: { x: 1 }, c: 'same', d: true })
    ).toEqual(['a', 'd']);
    expect(changedFields(null, { z: 1, y: 2 })).toEqual(['y', 'z']);
    expect(changedFields(undefined, undefined)).toEqual([]);
  });
});
