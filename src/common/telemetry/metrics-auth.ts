import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Checks `Authorization: Bearer <token>` against METRICS_TOKEN in constant time.
 * Both sides are hashed first so the comparison does not leak the token length.
 */
export function isAuthorizedMetricsRequest(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}
