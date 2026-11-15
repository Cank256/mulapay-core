import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor, filterFingerprint, pageQuerySchema, toPage } from './cursor';

describe('cursor pagination', () => {
  const createdAt = new Date('2025-02-01T10:00:00.000Z');

  it('round-trips a key under the same filters', () => {
    const f = filterFingerprint({ status: 'active' });
    const cursor = encodeCursor({ createdAt, id: 'mch_X' }, f);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, f)).toEqual({ createdAt, id: 'mch_X' });
  });

  it('fingerprints ignore undefined filters and key order', () => {
    expect(filterFingerprint({ a: 1, b: undefined, c: 'x' })).toBe(
      filterFingerprint({ c: 'x', a: 1 })
    );
    expect(filterFingerprint({ a: 1 })).not.toBe(filterFingerprint({ a: 2 }));
  });

  it('rejects a cursor from other filters, garbage and malformed payloads', () => {
    const cursor = encodeCursor(
      { createdAt, id: 'mch_X' },
      filterFingerprint({ status: 'active' })
    );
    const other = filterFingerprint({ status: 'closed' });
    const expectInvalid = (value: string, f: string) =>
      expect(() => decodeCursor(value, f)).toThrow(
        expect.objectContaining({ code: 'INVALID_CURSOR' })
      );
    expectInvalid(cursor, other);
    expectInvalid('%%%not-base64', other);
    expectInvalid(Buffer.from('not json').toString('base64url'), other);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expectInvalid(b64({ k: ['x', 'y'], d: 'asc', f: other }), other);
    expectInvalid(b64({ k: ['not-a-date', 'y'], d: 'desc', f: other }), other);
  });

  it('builds pages from limit + 1 rows', () => {
    const rows = [1, 2, 3].map((n) => ({ n, createdAt, ref: `r${n}` }));
    const keyOf = (r: (typeof rows)[number]) => ({ createdAt: r.createdAt, id: r.ref });
    const page = toPage(rows, 2, 'f', keyOf);
    expect(page.items.map((r) => r.n)).toEqual([1, 2]);
    expect(decodeCursor(page.nextCursor ?? '', 'f').id).toBe('r2');
    expect(toPage(rows, 3, 'f', keyOf).nextCursor).toBeNull();
    expect(toPage([], 3, 'f', keyOf)).toEqual({ items: [], nextCursor: null });
  });

  it('bounds limit and defaults it to 25', () => {
    const schema = z.object(pageQuerySchema(100));
    expect(schema.parse({}).limit).toBe(25);
    expect(schema.parse({ limit: '50' }).limit).toBe(50);
    expect(schema.safeParse({ limit: '101' }).success).toBe(false);
    expect(schema.safeParse({ limit: '0' }).success).toBe(false);
  });
});
