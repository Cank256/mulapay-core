/**
 * Webhook retry schedule (spec 6.11): attempts at 0 s, 30 s, 2 min, 10 min, 1 h, 6 h and
 * 24 h after the previous one (7 attempts), each delay jittered by up to 20% either way so
 * a receiver that comes back up is not hit by every queued delivery in the same second.
 * Pure: the random source is a parameter.
 */
export const RETRY_DELAYS_SECONDS = [0, 30, 120, 600, 3600, 21600, 86400] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length;
export const JITTER_RATIO = 0.2;
/** Consecutive failures after which an endpoint is disabled (spec 6.11). */
export const AUTO_DISABLE_AFTER_FAILURES = 50;
/** An attempt must answer 2xx within this long (spec 6.11). */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Milliseconds to wait before the next attempt, after `attemptsMade` attempts have failed,
 * or null when the schedule is used up. `random` returns a number in [0, 1).
 */
export function nextAttemptDelayMs(
  attemptsMade: number,
  random: () => number = Math.random
): number | null {
  const base = RETRY_DELAYS_SECONDS[attemptsMade];
  if (attemptsMade < 1 || base === undefined) return null;
  const jitter = 1 + (random() * 2 - 1) * JITTER_RATIO;
  return Math.round(base * 1000 * jitter);
}
