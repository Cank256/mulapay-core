import { describe, expect, it } from 'vitest';
import { exampleFromSchema } from './schema-example';

const root = {
  components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
};

describe('exampleFromSchema', () => {
  it('uses an explicit example, enum, const and the first union member', () => {
    expect(exampleFromSchema(root, { type: 'string', example: 'x' })).toBe('x');
    expect(exampleFromSchema(root, { enum: ['b', 'a'] })).toBe('b');
    expect(exampleFromSchema(root, { const: 5 })).toBe(5);
    expect(exampleFromSchema(root, { anyOf: [{ type: 'null' }, { type: 'integer' }] })).toBe(0);
    expect(exampleFromSchema(root, { oneOf: [{ type: 'boolean' }] })).toBe(true);
  });
  it('honours ranges, formats and patterns', () => {
    expect(exampleFromSchema(root, { type: 'integer', minimum: 3 })).toBe(3);
    expect(exampleFromSchema(root, { type: 'number', exclusiveMinimum: 0 })).toBe(1);
    expect(exampleFromSchema(root, { type: 'integer', maximum: -4 })).toBe(-4);
    expect(exampleFromSchema(root, { type: 'string', format: 'date-time' })).toBe(
      '2025-01-01T00:00:00.000Z'
    );
    expect(exampleFromSchema(root, { type: 'string', format: 'uri' })).toBe('https://example.com');
    expect(exampleFromSchema(root, { type: 'string', pattern: '^[1-9][0-9]*$' })).toBe('10000');
    expect(exampleFromSchema(root, { type: 'string', minLength: 40 })).toHaveLength(40);
    expect(exampleFromSchema(root, { type: 'string', pattern: '^zzz$' })).toBe('string');
  });
  it('builds objects and arrays, resolving references and merging allOf', () => {
    expect(exampleFromSchema(root, { $ref: '#/components/schemas/Item' })).toEqual({
      id: 'string',
    });
    expect(
      exampleFromSchema(root, { type: 'array', items: { $ref: '#/components/schemas/Item' } })
    ).toEqual([{ id: 'string' }]);
    expect(
      exampleFromSchema(root, {
        allOf: [
          { type: 'object', properties: { a: { type: 'boolean' } } },
          { type: 'object', properties: { b: { type: 'integer' } } },
        ],
      })
    ).toEqual({ a: true, b: 0 });
    expect(
      exampleFromSchema(root, { type: 'array', items: { type: 'string' }, minItems: 2 })
    ).toHaveLength(1);
  });
  it('stops at depth and for unknown types', () => {
    const deep = {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    };
    expect(JSON.stringify(exampleFromSchema(root, deep)).length).toBeLessThan(80);
    expect(exampleFromSchema(root, {})).toBeNull();
  });
});
