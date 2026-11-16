import { describe, expect, it } from 'vitest';
import { dayWindow, monthWindow } from './precheck.service';

describe('volume counter windows', () => {
  it('start at midnight and the first of the month, in UTC', () => {
    const at = new Date('2025-03-31T23:59:59.999Z');
    expect(dayWindow(at)).toEqual({ key: '20250331', start: new Date('2025-03-31T00:00:00.000Z') });
    expect(monthWindow(at)).toEqual({ key: '202503', start: new Date('2025-03-01T00:00:00.000Z') });
  });

  it('roll over at the boundary and across a year', () => {
    expect(dayWindow(new Date('2025-04-01T00:00:00.000Z')).key).toBe('20250401');
    expect(monthWindow(new Date('2025-04-01T00:00:00.000Z')).key).toBe('202504');
    expect(monthWindow(new Date('2026-01-01T00:00:00.000Z')).key).toBe('202601');
    expect(monthWindow(new Date('2025-12-31T23:59:59.999Z')).key).toBe('202512');
  });
});
