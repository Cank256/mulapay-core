/**
 * Recognises Postgres errors that application services translate into catalogue errors.
 * Drizzle wraps driver errors, so the `cause` chain is followed.
 */
interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function findPgError(error: unknown, depth = 0): PgErrorLike | undefined {
  if (typeof error !== 'object' || error === null || depth > 4) return undefined;
  const candidate = error as PgErrorLike;
  if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
  return findPgError(candidate.cause, depth + 1);
}

/** True for a unique violation (23505), optionally on a specific constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = findPgError(error);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

/** True for `lock_not_available` (55P03): a lock wait ran past `lock_timeout`. */
export function isLockNotAvailable(error: unknown): boolean {
  return findPgError(error)?.code === '55P03';
}
