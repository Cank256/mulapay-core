/**
 * Cursor pagination (spec section 8.6).
 *
 * The cursor is base64url JSON `{ k: [createdAt, id], d: 'desc', f: filterFingerprint }`.
 * A cursor issued under one set of filters is rejected under another with
 * `400 INVALID_CURSOR`. `OFFSET` is never used.
 */
import { z } from 'zod';
import { sha256Hex } from '../crypto/crypto';
import { AppError } from '../errors/app-error';

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
export const MAX_ADMIN_PAGE_LIMIT = 200;

export interface CursorKey {
  readonly createdAt: Date;
  readonly id: string;
}

const payloadSchema = z.strictObject({
  k: z.tuple([z.string(), z.string().min(1)]),
  d: z.literal('desc'),
  f: z.string(),
});

/** Stable fingerprint of the filters a list was requested with. */
export function filterFingerprint(filters: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256Hex(JSON.stringify(entries)).slice(0, 16);
}

export function encodeCursor(key: CursorKey, fingerprint: string): string {
  const payload = { k: [key.createdAt.toISOString(), key.id], d: 'desc', f: fingerprint };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, fingerprint: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('INVALID_CURSOR');
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success || result.data.f !== fingerprint) throw new AppError('INVALID_CURSOR');
  const createdAt = new Date(result.data.k[0]);
  if (Number.isNaN(createdAt.getTime())) throw new AppError('INVALID_CURSOR');
  return { createdAt, id: result.data.k[1] };
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Builds a page from `limit + 1` rows fetched in (created_at desc, key desc) order: the
 * extra row only signals that another page exists. `keyOf` returns the tie-breaking key,
 * which must be a public value (a `ref` or an audit `seq`), never an internal UUID.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  fingerprint: string,
  keyOf: (row: T) => CursorKey
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(keyOf(last), fingerprint) : null;
  return { items, nextCursor };
}

/** Query schema fragment shared by list endpoints. */
export function pageQuerySchema(maxLimit: number) {
  return {
    limit: z.coerce.number().int().min(1).max(maxLimit).default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  };
}
