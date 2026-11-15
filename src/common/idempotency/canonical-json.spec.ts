import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('serialises the same data identically whatever the key order', () => {
    const a = { b: 1, a: { d: [1, 2, { z: true, y: null }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2, { y: null, z: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2,{"y":null,"z":true}]},"b":1}');
  });

  it('keeps array order, which is significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes values that look alike', () => {
    const forms = [
      { a: '1' },
      { a: 1 },
      { a: true },
      { a: null },
      { a: [] },
      { a: {} },
      { a: 'true' },
      { a: 1.5 },
      { a: '' },
    ];
    expect(new Set(forms.map(canonicalJson)).size).toBe(forms.length);
  });

  it('drops undefined properties like JSON.stringify and nulls undefined array items', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('escapes strings and keys exactly as JSON does', () => {
    expect(canonicalJson({ 'k"ey': 'line\nbreak "quoted" \u2028 \\' })).toBe(
      JSON.stringify({ 'k"ey': 'line\nbreak "quoted" \u2028 \\' })
    );
  });

  it('serialises scalars', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1.25)).toBe('-1.25');
    expect(canonicalJson('')).toBe('""');
  });

  it('refuses what JSON cannot carry', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('x'))).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it('sorts keys by code unit, not by locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, '\u00e4': 4 })).toBe('{"B":2,"a":3,"b":1,"\u00e4":4}');
  });
});
