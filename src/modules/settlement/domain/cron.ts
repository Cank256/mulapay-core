/** Cron helpers for settlement cycle schedules (5 fields, evaluated in the cycle's zone). Pure. */
import { parseExpression } from 'cron-parser';

export function isValidCron(expression: string, timezone: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false;
  try {
    parseExpression(expression, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The first cron occurrence strictly after `after`. */
export function nextOccurrence(expression: string, timezone: string, after: Date): Date {
  return parseExpression(expression, { tz: timezone, currentDate: after }).next().toDate();
}

/** The latest cron occurrence strictly before `before`: the tick a run is attributed to. */
export function previousOccurrence(expression: string, timezone: string, before: Date): Date {
  return parseExpression(expression, { tz: timezone, currentDate: before }).prev().toDate();
}
