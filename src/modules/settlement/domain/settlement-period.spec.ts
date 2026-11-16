import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { latestCutoff, settlementPeriodEnd } from './settlement-period';

const kampala = { cutoffTime: '00:00', timezone: 'Africa/Kampala', delayDays: 1 };

describe('settlement periods', () => {
  it('finds the latest cutoff at or before the instant', () => {
    // 2025-03-10 02:00 in Kampala (UTC+3) is 2025-03-09 23:00Z; local cutoff 00:00 is 2025-03-09 21:00Z.
    expect(latestCutoff(new Date('2025-03-09T23:00:00Z'), kampala).toISOString()).toBe(
      '2025-03-09T21:00:00.000Z'
    );
    // Just before the cutoff, the previous day's cutoff applies.
    expect(latestCutoff(new Date('2025-03-09T20:59:59Z'), kampala).toISOString()).toBe(
      '2025-03-08T21:00:00.000Z'
    );
    // Exactly on the cutoff counts.
    expect(latestCutoff(new Date('2025-03-09T21:00:00Z'), kampala).toISOString()).toBe(
      '2025-03-09T21:00:00.000Z'
    );
  });

  it('subtracts the delay in calendar days', () => {
    expect(settlementPeriodEnd(new Date('2025-03-09T23:00:00Z'), kampala).toISOString()).toBe(
      '2025-03-08T21:00:00.000Z'
    );
    expect(
      settlementPeriodEnd(new Date('2025-03-09T23:00:00Z'), {
        ...kampala,
        delayDays: 0,
      }).toISOString()
    ).toBe('2025-03-09T21:00:00.000Z');
  });

  it('gives the same period end for every instant between two cutoffs', () => {
    const a = settlementPeriodEnd(new Date('2025-03-09T21:00:01Z'), kampala);
    const b = settlementPeriodEnd(new Date('2025-03-10T20:59:59Z'), kampala);
    expect(a.getTime()).toBe(b.getTime());
  });

  it('keeps the wall-clock cutoff across a daylight-saving change', () => {
    const ny = { cutoffTime: '17:30', timezone: 'America/New_York', delayDays: 1 };
    // 2025-03-09 is the spring-forward day: the cutoff 17:30 local is 21:30Z (EDT) afterwards,
    // and the day before it was 22:30Z (EST).
    expect(latestCutoff(new Date('2025-03-09T22:00:00Z'), ny).toISOString()).toBe(
      '2025-03-09T21:30:00.000Z'
    );
    expect(settlementPeriodEnd(new Date('2025-03-09T22:00:00Z'), ny).toISOString()).toBe(
      '2025-03-08T22:30:00.000Z'
    );
  });

  it('refuses an invalid rule', () => {
    for (const rule of [
      { ...kampala, cutoffTime: '24:00' },
      { ...kampala, timezone: 'Mars/Olympus' },
      { ...kampala, delayDays: -1 },
      { ...kampala, delayDays: 1.5 },
    ]) {
      expect(() => latestCutoff(new Date(), rule)).toThrow(AppError);
    }
  });
});
