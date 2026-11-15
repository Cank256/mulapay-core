import { describe, expect, it } from 'vitest';
import { outboxBackoffSeconds } from './outbox-dispatcher';

describe('outboxBackoffSeconds', () => {
  it('doubles from 2 seconds and is capped at 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(outboxBackoffSeconds)).toEqual([
      2, 4, 8, 16, 32, 64, 128, 256, 300, 300,
    ]);
  });
  it('never returns less than the base for a claim count of zero', () => {
    expect(outboxBackoffSeconds(0)).toBe(2);
  });
});
