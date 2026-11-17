import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../../common/ids/ids';
import {
  IDEMPOTENCY_GRACE_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  PARTITION_MIN_MONTHS_AHEAD,
  PARTITION_MONTHS_AHEAD,
  idempotencyPurgeCutoff,
  outboxPurgeCutoff,
  uuidTimeBound,
} from './retention-policy';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;

describe('retention policy', () => {
  it('keeps an idempotency row for its 24 hours plus the grace window', () => {
    expect(idempotencyPurgeCutoff(NOW).getTime()).toBe(
      NOW.getTime() - IDEMPOTENCY_GRACE_DAYS * DAY
    );
    // The grace must be longer than the spec 8.2 replay window, or a replay could lose its row.
    expect(IDEMPOTENCY_GRACE_DAYS * DAY).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('keeps published outbox rows for two weeks', () => {
    expect(outboxPurgeCutoff(NOW).getTime()).toBe(
      NOW.getTime() - OUTBOX_PUBLISHED_RETENTION_DAYS * DAY
    );
  });

  it('bounds a v7 uuid range by time', () => {
    const bound = uuidTimeBound(new Date('2026-06-01T00:00:00.000Z'));
    expect(bound).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-0000-0000-000000000000$/);
    // A v7 id made at the same millisecond sorts at or above the bound; one made earlier sorts below.
    const sameMs = uuidv7(new Date('2026-06-01T00:00:00.000Z'));
    const earlier = uuidv7(new Date('2026-05-31T23:59:59.999Z'));
    expect(sameMs >= bound).toBe(true);
    expect(earlier < bound).toBe(true);
    expect(uuidTimeBound(new Date(0))).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('creates three months ahead and alerts before the last one is used', () => {
    expect(PARTITION_MONTHS_AHEAD).toBe(3);
    expect(PARTITION_MIN_MONTHS_AHEAD).toBeLessThan(PARTITION_MONTHS_AHEAD);
  });
});
