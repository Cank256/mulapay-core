/**
 * What data the retention jobs may remove, and when (spec 11, "Data retention").
 *
 * The periods for partitioned tables live in `core.partition_policies` (a migration changes
 * them, and a CHECK constraint limits them to the tables the specification lists). The two
 * non-partitioned clean-ups are defined here. Both only ever touch rows that have no further
 * business meaning:
 *
 *  - `idempotency_keys`: the key is valid for 24 hours (spec 8.2). A row is removed only
 *    `IDEMPOTENCY_GRACE_DAYS` after it expired. Until then it keeps blocking reuse of the key, as
 *    it does today, so deleting changes nothing a caller can observe inside the grace window.
 *  - `outbox`: a row that was published is a finished announcement. Rows that were never published
 *    (including ones that ran out of attempts, which are an operational alert) are never deleted.
 *    Every producer writes a one-shot dedupe key in the transaction that made the change, so a
 *    key does not come back after `OUTBOX_PUBLISHED_RETENTION_DAYS`.
 *
 * Financial records, transactions, journals and audit logs have no retention here by design:
 * spec 11 keeps them for seven years and "never deleted by a job".
 */
export const IDEMPOTENCY_GRACE_DAYS = 7;
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 14;
/** Rows deleted per statement, so one run never holds locks for long (spec 9.2 rule 9). */
export const PURGE_BATCH_SIZE = 1000;
/** A run stops after this many batches; the next run continues. Bounds one run's duration. */
export const PURGE_MAX_BATCHES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which an idempotency row (by `expires_at`) may be removed. */
export function idempotencyPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_GRACE_DAYS * DAY_MS);
}

/** The instant before which a published outbox row (by `published_at`) may be removed. */
export function outboxPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - OUTBOX_PUBLISHED_RETENTION_DAYS * DAY_MS);
}

/**
 * The smallest UUID whose UUID v7 time prefix is `at` (48-bit millisecond timestamp, rest zero).
 * Outbox ids are v7 (`uuidv7(now)` at insert), so `id < uuidTimeBound(cutoff)` is a range on the
 * primary key. That lets the purge find old rows without a second index on a high-write table
 * (the plan is in docs/query-plans/phase9.txt).
 */
export function uuidTimeBound(at: Date): string {
  const hex = at.getTime().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/** Months of partitions kept ahead of the current one (spec 5.1: "the next three months"). */
export const PARTITION_MONTHS_AHEAD = 3;

/** Alert when fewer months than this remain ahead: the next run has missed or failed. */
export const PARTITION_MIN_MONTHS_AHEAD = 2;
