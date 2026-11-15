/**
 * Builds an example value from a JSON Schema (OpenAPI 3.0 flavour), for operations whose
 * author wrote no example. The result satisfies the schema by construction: it uses the
 * first enum member, the minimum of a range, a pattern-matching candidate, and so on. The
 * contract test validates every example against its schema, so a schema this cannot satisfy
 * fails the build rather than documenting an invalid request.
 */
type Json = Record<string, unknown>;

const PATTERN_CANDIDATES = [
  '10000',
  '1',
  '0',
  '2025-01-01T00:00:00.000Z',
  '2025-01-01',
  '+256700000000',
  'abc',
  'A',
];

const FORMAT_EXAMPLES: Readonly<Record<string, string>> = {
  'date-time': '2025-01-01T00:00:00.000Z',
  date: '2025-01-01',
  uri: 'https://example.com',
  url: 'https://example.com',
  email: 'merchant@example.com',
  uuid: '0190a7c0-0000-7000-8000-000000000000',
};

function resolveRef(root: Json, ref: string): Json {
  let node: unknown = root;
  for (const part of ref.replace(/^#\//, '').split('/')) node = (node as Json)[part];
  return node as Json;
}

function stringExample(schema: Json): string {
  const format = typeof schema.format === 'string' ? FORMAT_EXAMPLES[schema.format] : undefined;
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern, 'u') : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const fits = (value: string) => (!pattern || pattern.test(value)) && value.length >= minLength;
  const candidates = [
    ...(format ? [format] : []),
    ...(pattern ? PATTERN_CANDIDATES : []),
    'string',
  ];
  const matching = candidates.find(fits);
  if (matching !== undefined) return matching;
  return pattern ? 'string' : 'a'.repeat(Math.max(minLength, 1));
}

export function exampleFromSchema(root: Json, schema: Json, depth = 0): unknown {
  if (typeof schema.$ref === 'string') {
    return exampleFromSchema(root, resolveRef(root, schema.$ref), depth);
  }
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...(schema.allOf as Json[]).map((s) => exampleFromSchema(root, s, depth))
    );
  }
  const variants = (schema.oneOf ?? schema.anyOf) as Json[] | undefined;
  if (variants?.length) {
    const preferred = variants.find((v) => v.type !== 'null') ?? variants[0];
    return exampleFromSchema(root, preferred as Json, depth);
  }
  switch (schema.type) {
    case 'string':
      return stringExample(schema);
    case 'integer':
    case 'number': {
      // OpenAPI 3.0 writes an exclusive bound as `minimum` plus `exclusiveMinimum: true`;
      // JSON Schema 2019+ writes it as the number itself.
      if (typeof schema.minimum === 'number') {
        return schema.exclusiveMinimum === true ? schema.minimum + 1 : schema.minimum;
      }
      if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
      return typeof schema.maximum === 'number' ? Math.min(0, schema.maximum) : 0;
    }
    case 'boolean':
      return true;
    case 'array': {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
      if (depth > 5 || !schema.items) return [];
      const item = exampleFromSchema(root, schema.items as Json, depth + 1);
      return min > 0 || depth <= 2 ? [item] : [];
    }
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      const entries = Object.entries(properties).map(
        ([name, property]) => [name, exampleFromSchema(root, property, depth + 1)] as const
      );
      return Object.fromEntries(entries);
    }
    default:
      return null;
  }
}
