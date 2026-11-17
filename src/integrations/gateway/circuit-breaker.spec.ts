import { describe, expect, it } from 'vitest';
import {
  CLOSED,
  admit,
  nextBreakerState,
  type BreakerConfig,
  type BreakerState,
} from './circuit-breaker';

const config: BreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  resetMs: 15_000,
  closeAfterSuccesses: 3,
};

function failures(count: number, start = 0, stepMs = 1000): BreakerState {
  let state: BreakerState = CLOSED;
  for (let i = 0; i < count; i += 1) {
    state = nextBreakerState(state, 'failure', start + i * stepMs, config);
  }
  return state;
}

describe('nextBreakerState (spec 6.2)', () => {
  it('counts consecutive failures and opens on the fifth', () => {
    expect(failures(4).mode).toBe('closed');
    expect(failures(4).failures).toBe(4);
    const open = failures(5);
    expect(open).toMatchObject({ mode: 'open', failures: 5, openedAt: 4000 });
  });

  it('a success while closed clears the run, and is a no-op with no failures', () => {
    const after = nextBreakerState(failures(3), 'success', 5000, config);
    expect(after).toEqual(CLOSED);
    expect(nextBreakerState(CLOSED, 'success', 1, config)).toBe(CLOSED);
  });

  it('starts a new window when the last failure is older than the window', () => {
    const state = failures(4);
    const later = nextBreakerState(state, 'failure', 31_000 + 4000, config);
    expect(later).toMatchObject({ mode: 'closed', failures: 1, windowStartedAt: 35_000 });
  });

  it('keeps counting inside the window and uses the window start, not the last failure', () => {
    // Failures at 0, 10, 20, 29 and 30 seconds all fall inside the first 30 s window.
    let state: BreakerState = CLOSED;
    for (const at of [0, 10_000, 20_000, 29_000, 30_000]) {
      state = nextBreakerState(state, 'failure', at, config);
    }
    expect(state.mode).toBe('open');
  });

  it('ignores outcomes while open (they belong to calls that started before it opened)', () => {
    const open = failures(5);
    expect(nextBreakerState(open, 'success', 9000, config)).toBe(open);
    expect(nextBreakerState(open, 'failure', 9000, config)).toBe(open);
  });

  it('half-open: three successes close it, a failure reopens it', () => {
    const half: BreakerState = { ...failures(5), mode: 'half_open', successes: 0 };
    const one = nextBreakerState(half, 'success', 20_000, config);
    const two = nextBreakerState(one, 'success', 20_100, config);
    expect(two).toMatchObject({ mode: 'half_open', successes: 2 });
    expect(nextBreakerState(two, 'success', 20_200, config)).toEqual(CLOSED);
    const reopened = nextBreakerState(two, 'failure', 20_300, config);
    expect(reopened).toMatchObject({ mode: 'open', openedAt: 20_300 });
  });

  it('respects a lower or higher configured threshold', () => {
    const strict: BreakerConfig = { ...config, failureThreshold: 1 };
    expect(nextBreakerState(CLOSED, 'failure', 0, strict).mode).toBe('open');
    const lax: BreakerConfig = { ...config, failureThreshold: 50 };
    let state: BreakerState = CLOSED;
    for (let i = 0; i < 49; i += 1) state = nextBreakerState(state, 'failure', i, lax);
    expect(state.mode).toBe('closed');
  });
});

describe('admit', () => {
  it('always lets calls through while closed or half-open', () => {
    expect(admit(CLOSED, 0, config)).toEqual({ allowed: true, next: CLOSED });
    const half: BreakerState = { ...CLOSED, mode: 'half_open' };
    expect(admit(half, 0, config).allowed).toBe(true);
  });

  it('refuses while open until the reset time, then half-opens with a clean success count', () => {
    const open = failures(5);
    expect(admit(open, open.openedAt + 14_999, config)).toEqual({ allowed: false, next: open });
    const probe = admit(open, open.openedAt + 15_000, config);
    expect(probe.allowed).toBe(true);
    expect(probe.next).toMatchObject({ mode: 'half_open', successes: 0 });
  });
});
