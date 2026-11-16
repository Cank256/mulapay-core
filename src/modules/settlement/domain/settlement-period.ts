/**
 * Settlement period calculation (spec 6.9). Pure.
 *
 * A cycle has a daily cutoff (`HH:MM` wall-clock time in an IANA time zone) and a delay in
 * days. For a run at instant `asOf`:
 *
 *   cutoff     = the latest cutoff instant at or before `asOf`
 *   period end = the cutoff `delayDays` calendar days earlier (same wall-clock time)
 *
 * A payment completed before the period end is eligible. The period start of a merchant's
 * batch is the end of its previous live batch (see `SettlementBatchService`), so periods
 * never overlap and never leave a gap.
 *
 * Wall-clock arithmetic is done on calendar dates in the zone, so a daylight-saving change
 * moves the instant, not the local time.
 */
import { AppError } from '../../../common/errors/app-error';

const MINUTE_MS = 60_000;

export interface CutoffRule {
  /** `HH:MM`, 24-hour. */
  readonly cutoffTime: string;
  /** IANA zone, for example `Africa/Kampala`. */
  readonly timezone: string;
  readonly delayDays: number;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timezone` from UTC at `instant`, in minutes (positive east of Greenwich). */
function offsetMinutes(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE_MS);
}

function localDateOf(instant: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The UTC instant at which the wall clock in `timezone` reads `date` and `HH:MM`. */
function wallClockToInstant(date: LocalDate, cutoffTime: string, timezone: string): Date {
  const [hour, minute] = cutoffTime.split(':').map(Number) as [number, number];
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Two passes settle the offset across a daylight-saving boundary.
  let instant = naive - offsetMinutes(naive, timezone) * MINUTE_MS;
  instant = naive - offsetMinutes(instant, timezone) * MINUTE_MS;
  return new Date(instant);
}

function assertRule(rule: CutoffRule): void {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(rule.cutoffTime)) {
    throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'cutoffTime' } });
  }
  if (!isValidTimezone(rule.timezone)) {
    throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'timezone' } });
  }
  if (!Number.isInteger(rule.delayDays) || rule.delayDays < 0 || rule.delayDays > 90) {
    throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'delayDays' } });
  }
}

/** The latest cutoff instant at or before `asOf`. */
export function latestCutoff(asOf: Date, rule: CutoffRule): Date {
  assertRule(rule);
  const today = localDateOf(asOf, rule.timezone);
  const candidate = wallClockToInstant(today, rule.cutoffTime, rule.timezone);
  return candidate.getTime() <= asOf.getTime()
    ? candidate
    : wallClockToInstant(addDays(today, -1), rule.cutoffTime, rule.timezone);
}

/** The instant up to which payments are settled by a run at `asOf`. */
export function settlementPeriodEnd(asOf: Date, rule: CutoffRule): Date {
  assertRule(rule);
  const cutoff = latestCutoff(asOf, rule);
  const date = addDays(localDateOf(cutoff, rule.timezone), -rule.delayDays);
  return wallClockToInstant(date, rule.cutoffTime, rule.timezone);
}

/** The start of time for a merchant's first batch: every earlier payment is eligible. */
export const SETTLEMENT_EPOCH = new Date(0);
