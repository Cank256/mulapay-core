/**
 * The `created_at` window of a list over a partitioned table (spec 9.2 rule 6): the planner
 * can only prune partitions if the query carries a range, so a list always has one. It
 * defaults to the last 90 days and may span at most 366.
 */
import { AppError } from '../errors/app-error';

const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 366;

export interface Window {
  readonly from: Date;
  readonly to: Date;
}

/** Fills in the defaults and refuses an inverted or over-long window with a 400. */
export function resolveWindow(range: { from?: Date; to?: Date }, now: Date): Window {
  const to = range.to ?? now;
  const from = range.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() > to.getTime() || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new AppError('VALIDATION_FAILED', {
      details: {
        fields: [
          {
            path: 'from',
            code: 'invalid_range',
            message: `window must be 0 to ${MAX_WINDOW_DAYS} days`,
          },
        ],
      },
    });
  }
  return { from, to };
}
