/**
 * SQL for newest-first keyset pages over `(created_at, ref)` (spec 8.6, 9.2).
 *
 * Two details decide whether Postgres reads one page or the whole window (see
 * docs/query-plans/phase4.txt):
 *
 *  - The indexes are `created_at DESC NULLS LAST, ref DESC NULLS LAST`. A plain `ORDER BY ...
 *    DESC` means `NULLS FIRST`, which does not match, so the planner reads every row in the
 *    window and sorts. `newestFirst` spells out `NULLS LAST` so an ordered index scan, and
 *    across partitions a Merge Append that stops at the LIMIT, can be used.
 *  - The cursor condition is a range on `created_at` plus a residual test on `ref`. The same
 *    condition written as one OR, or as a row comparison, makes the planner sort instead.
 */
import { lt, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { CursorKey } from './cursor';

/** `ORDER BY` terms for newest first, matching the `DESC NULLS LAST` indexes. */
export function newestFirst(createdAt: AnyColumn, ref: AnyColumn): SQL[] {
  return [sql`${createdAt} desc nulls last`, sql`${ref} desc nulls last`];
}

/**
 * Rows strictly after `cursor` in newest-first order: older, or the same time and a smaller
 * ref. `created_at <= cursor` is the range the index can use; the residual then only has to
 * exclude the rows at the cursor's own time whose ref is not smaller.
 */
export function olderThan(createdAt: AnyColumn, ref: AnyColumn, cursor: CursorKey): SQL[] {
  const residual = or(lt(createdAt, cursor.createdAt), lt(ref, cursor.id));
  return [lte(createdAt, cursor.createdAt), ...(residual ? [residual] : [])];
}
