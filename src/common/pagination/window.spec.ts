import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, resolveWindow } from './window';

const NOW = new Date('2025-06-01T00:00:00Z');
const DAY = 86_400_000;

describe('resolveWindow', () => {
  it('defaults to the last 90 days ending now', () => {
    const w = resolveWindow({}, NOW);
    expect(w.to).toEqual(NOW);
    expect(NOW.getTime() - w.from.getTime()).toBe(DEFAULT_WINDOW_DAYS * DAY);
  });

  it('measures the default from an explicit end', () => {
    const to = new Date('2025-03-01T00:00:00Z');
    expect(resolveWindow({ to }, NOW).from.getTime()).toBe(to.getTime() - 90 * DAY);
  });

  it('accepts an explicit window up to 366 days', () => {
    const from = new Date(NOW.getTime() - MAX_WINDOW_DAYS * DAY);
    expect(resolveWindow({ from, to: NOW }, NOW)).toEqual({ from, to: NOW });
  });

  it('refuses an inverted window and one longer than 366 days with a 400', () => {
    for (const range of [
      { from: new Date(NOW.getTime() + DAY), to: NOW },
      { from: new Date(NOW.getTime() - (MAX_WINDOW_DAYS + 1) * DAY), to: NOW },
    ]) {
      try {
        resolveWindow(range, NOW);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('VALIDATION_FAILED');
      }
    }
  });
});
