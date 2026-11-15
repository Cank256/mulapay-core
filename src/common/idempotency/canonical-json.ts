/**
 * Canonical JSON for request fingerprints (spec 8.2): the same data always serialises to
 * the same string, whatever order the client wrote the keys in. Object keys are sorted by
 * code unit, arrays keep their order, and there is no insignificant whitespace. `undefined`
 * properties are dropped, as `JSON.stringify` does.
 *
 * Only plain JSON values are accepted (the body has already been through the JSON parser),
 * so a function, symbol, bigint or non-finite number is a programming error and throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}
