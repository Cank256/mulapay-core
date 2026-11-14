import type { Clock } from '../../src/common/clock/clock';

/** Deterministic clock for tests. Time only moves when the test moves it. */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2025-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceBy(ms: number): void {
    this.current += ms;
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }
}
