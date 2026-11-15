/**
 * Amounts in minor units (spec section 2: `bigint` minor units in the ledger, never a
 * float). Postgres stores them as `bigint`, so the largest representable amount is
 * 2^63 - 1. Decimal strings exist only at the API and gateway edges, which convert with
 * the exponents in currency-codes.ts.
 */

/** Largest value of a Postgres `bigint`. */
export const MAX_MINOR = 9_223_372_036_854_775_807n;

/** True for a bigint in 1..MAX_MINOR. Numbers, strings and floats are rejected. */
export function isPositiveMinor(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= MAX_MINOR;
}

export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
