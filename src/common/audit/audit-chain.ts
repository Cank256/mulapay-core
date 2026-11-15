/**
 * Audit hash chain (spec section 6.14): `hash = sha256(prev_hash || canonical(row))`.
 *
 * Pure functions, so chain construction and verification are unit-tested without a
 * database. `canonical` is JSON with object keys sorted at every depth; values are first
 * normalised to what a `jsonb` round trip returns (dates as ISO strings, bigints as
 * strings, undefined dropped), so a row read back from Postgres hashes identically.
 */
import { sha256Hex } from '../crypto/crypto';

export const GENESIS_HASH = '0'.repeat(64);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Normalises a value to plain JSON. Throws on non-finite numbers. */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('audit values must be finite numbers');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item) ?? null);
  const out: Record<string, JsonValue> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const normalised = toJsonValue(inner);
    if (normalised !== undefined) out[key] = normalised;
  }
  return out;
}

/** JSON with keys sorted recursively. Input must already be normalised. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`;
}

/** The fields covered by the hash: every column except `prev_hash` and `hash`. */
export interface ChainedFields {
  readonly seq: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorLabel: string | null;
  readonly merchantId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly surface: string | null;
  readonly outcome: string;
  readonly createdAt: Date;
}

/** Picks exactly the hashed fields, so extra properties on `row` never change the hash. */
export function chainHash(prevHash: string, row: ChainedFields): string {
  const covered = {
    seq: row.seq,
    actorType: row.actorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    merchantId: row.merchantId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: row.before,
    after: row.after,
    changedFields: [...row.changedFields],
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    traceId: row.traceId,
    surface: row.surface,
    outcome: row.outcome,
    createdAt: row.createdAt,
  };
  return sha256Hex(prevHash + canonicalJson(toJsonValue(covered) as JsonValue));
}

export interface ChainedRow extends ChainedFields {
  readonly prevHash: string;
  readonly hash: string;
}

export interface ChainBreak {
  readonly seq: number;
  readonly reason: 'sequence_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch';
}

export interface ChainCursor {
  readonly lastSeq: number;
  readonly lastHash: string;
}

/**
 * Checks `rows` (ascending seq) continue the chain from `cursor`. Returns the first break,
 * or the new cursor when the batch is intact.
 */
export function verifyBatch(
  cursor: ChainCursor,
  rows: readonly ChainedRow[]
): { ok: true; cursor: ChainCursor } | { ok: false; break: ChainBreak } {
  let { lastSeq, lastHash } = cursor;
  for (const row of rows) {
    if (row.seq !== lastSeq + 1)
      return { ok: false, break: { seq: row.seq, reason: 'sequence_gap' } };
    if (row.prevHash !== lastHash) {
      return { ok: false, break: { seq: row.seq, reason: 'prev_hash_mismatch' } };
    }
    if (chainHash(row.prevHash, row) !== row.hash) {
      return { ok: false, break: { seq: row.seq, reason: 'hash_mismatch' } };
    }
    lastSeq = row.seq;
    lastHash = row.hash;
  }
  return { ok: true, cursor: { lastSeq, lastHash } };
}

/** Field names whose values differ between `before` and `after`, sorted. */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = toJsonValue(before?.[key]);
    const b = toJsonValue(after?.[key]);
    const left = a === undefined ? undefined : canonicalJson(a);
    const right = b === undefined ? undefined : canonicalJson(b);
    if (left !== right) changed.push(key);
  }
  return changed.sort();
}
