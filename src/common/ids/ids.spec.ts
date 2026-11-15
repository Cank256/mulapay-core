import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isPublicId, publicId, ulid, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7, variant 10 UUIDs carrying the timestamp', () => {
    const at = new Date('2025-03-04T05:06:07.890Z');
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBe(at.getTime());
  });

  it('sorts by creation time and does not repeat', () => {
    const a = uuidv7(new Date(1000));
    const b = uuidv7(new Date(2000));
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});

describe('ulid and public ids', () => {
  it('is 26 Crockford base32 characters with a sortable time prefix', () => {
    const early = ulid(new Date(1_000_000));
    const late = ulid(new Date(2_000_000));
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true);
  });

  it('prefixes each kind and validates the kind', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = publicId(kind);
      expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
      expect(isPublicId(kind, id)).toBe(true);
    }
    expect(isPublicId('merchant', publicId('user'))).toBe(false);
    expect(isPublicId('merchant', 'mch_not-a-ulid')).toBe(false);
  });

  it('is random beyond the time prefix (not enumerable)', () => {
    const at = new Date();
    const ids = new Set(Array.from({ length: 500 }, () => publicId('merchant', at)));
    expect(ids.size).toBe(500);
  });
});
