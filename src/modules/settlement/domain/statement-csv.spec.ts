import { describe, expect, it } from 'vitest';
import { csvCell, toStatementCsv } from './statement-csv';
import { isValidCron, nextOccurrence, previousOccurrence } from './cron';

describe('statement csv', () => {
  it('quotes every cell and doubles quotes', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
  });
  it('neutralises spreadsheet formulas', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) {
      expect(csvCell(bad)).toBe(`"'${bad}"`);
    }
  });
  it('writes the header, totals and one row per item', () => {
    const csv = toStatementCsv({
      settlement: 'stl_1',
      currency: 'UGX',
      periodStart: 'a',
      periodEnd: 'b',
      totals: { net_minor: '10' },
      rows: [
        {
          kind: 'payment',
          transaction: 'txn_1',
          occurredAt: null,
          amountMinor: '10',
          feeMinor: '0',
          netMinor: '10',
        },
      ],
    });
    expect(csv).toContain('"net_minor","10"');
    expect(csv.split('\r\n')).toContain('"payment","txn_1","","10","0","10"');
  });
});

describe('cron helpers', () => {
  it('validates five-field expressions in a zone', () => {
    expect(isValidCron('0 2 * * *', 'Africa/Kampala')).toBe(true);
    expect(isValidCron('0 0 2 * * *', 'UTC')).toBe(false);
    expect(isValidCron('nonsense', 'UTC')).toBe(false);
  });
  it('finds the previous and next occurrence in the zone', () => {
    const at = new Date('2025-03-10T00:30:00Z'); // 03:30 in Kampala
    expect(previousOccurrence('0 2 * * *', 'Africa/Kampala', at).toISOString()).toBe(
      '2025-03-09T23:00:00.000Z'
    );
    expect(nextOccurrence('0 2 * * *', 'Africa/Kampala', at).toISOString()).toBe(
      '2025-03-10T23:00:00.000Z'
    );
  });
});
