import { describe, expect, it } from 'vitest';
import { csvCell, csvHeader, csvRow, jsonRow, type Column } from './report-format';
import {
  MERCHANT_TYPES,
  MERCHANT_SCOPED_TYPES,
  PLATFORM_TYPES,
  REPORT_TYPES,
  isProblem,
  periodWindow,
  resolveParams,
} from './report-params';

describe('CSV encoding', () => {
  it('quotes commas, quotes and line breaks, and doubles quotes', () => {
    expect(csvCell('a,b', 'text')).toBe('"a,b"');
    expect(csvCell('say "hi"', 'text')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines', 'text')).toBe('"two\nlines"');
    expect(csvCell(null, 'text')).toBe('');
  });

  it('defuses a text cell that a spreadsheet would run as a formula, but not a negative number', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(bad, 'text').replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('-1500', 'number')).toBe('-1500');
    expect(csvCell('plain', 'text')).toBe('plain');
  });

  it('writes a header and rows in column order, ending lines with CRLF', () => {
    const columns: Column[] = [
      { label: 'ref', kind: 'text' },
      { label: 'amount', kind: 'number' },
    ];
    expect(csvHeader(columns)).toBe('ref,amount\r\n');
    expect(csvRow(columns, ['txn_1', '-5'])).toBe('txn_1,-5\r\n');
    expect(csvRow(columns, ['txn_2', null])).toBe('txn_2,\r\n');
  });

  it('writes JSON rows that join into one valid array', () => {
    const columns: Column[] = [{ label: 'a', kind: 'text' }];
    const body = `[\n${jsonRow(columns, ['x'], true)}${jsonRow(columns, [null], false)}\n]\n`;
    expect(JSON.parse(body)).toEqual([{ a: 'x' }, { a: null }]);
  });
});

describe('report parameters', () => {
  const now = new Date('2025-06-15T12:00:00Z');

  it('defaults to the last 30 days and stores the window as dates', () => {
    const r = resolveParams('transactions', {}, now);
    expect(isProblem(r)).toBe(false);
    if (isProblem(r)) return;
    expect(r.params.to).toBe(now.toISOString());
    expect(r.params.from).toBe('2025-05-16T12:00:00.000Z');
  });

  it('refuses a window over 366 days, an inverted one, and unknown parameters', () => {
    expect(
      resolveParams(
        'transactions',
        { from: '2023-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
        now
      )
    ).toEqual({ kind: 'window', maxDays: 366 });
    expect(
      resolveParams(
        'transactions',
        { from: '2025-02-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
        now
      )
    ).toEqual({ kind: 'window', maxDays: 366 });
    expect(resolveParams('transactions', { sneaky: 1 }, now)).toMatchObject({ kind: 'invalid' });
    expect(
      resolveParams(
        'audit_trail',
        { from: '2025-01-01T00:00:00Z', to: '2025-06-01T00:00:00Z' },
        now
      )
    ).toEqual({ kind: 'window', maxDays: 92 });
  });

  it('needs the parameters a type cannot do without', () => {
    expect(resolveParams('balance_statement', {}, now)).toMatchObject({ kind: 'invalid' });
    expect(resolveParams('settlement_statement', {}, now)).toMatchObject({ kind: 'invalid' });
    expect(resolveParams('kyc_status', {}, now)).toMatchObject({
      params: {},
      from: null,
      to: null,
    });
  });

  it('splits the thirteen types between merchants and the platform', () => {
    expect(REPORT_TYPES).toHaveLength(13);
    expect(MERCHANT_TYPES.length + PLATFORM_TYPES.length).toBe(13);
    for (const t of MERCHANT_SCOPED_TYPES) expect(MERCHANT_TYPES).toContain(t);
    for (const t of PLATFORM_TYPES) expect(MERCHANT_TYPES).not.toContain(t);
  });
});

describe('scheduled windows', () => {
  it('covers the whole UTC day, Monday to Sunday week, or calendar month before the due time', () => {
    const due = new Date('2025-06-18T06:00:00Z'); // a Wednesday
    expect(periodWindow('previous_day', due)).toEqual({
      from: new Date('2025-06-17T00:00:00Z'),
      to: new Date('2025-06-18T00:00:00Z'),
    });
    expect(periodWindow('previous_week', due)).toEqual({
      from: new Date('2025-06-09T00:00:00Z'),
      to: new Date('2025-06-16T00:00:00Z'),
    });
    expect(periodWindow('previous_month', due)).toEqual({
      from: new Date('2025-05-01T00:00:00Z'),
      to: new Date('2025-06-01T00:00:00Z'),
    });
    // A Sunday belongs to the week that ends with it; the week before is the previous Monday to Sunday.
    expect(periodWindow('previous_week', new Date('2025-06-22T06:00:00Z')).to).toEqual(
      new Date('2025-06-16T00:00:00Z')
    );
    expect(periodWindow('previous_month', new Date('2025-01-05T00:00:00Z')).from).toEqual(
      new Date('2024-12-01T00:00:00Z')
    );
  });
});
