/**
 * The CSV of a settlement statement. Pure. Every cell is quoted, and a cell that starts with
 * `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe, so a spreadsheet
 * never evaluates text a customer controlled as a formula.
 */
export interface StatementCsvInput {
  readonly settlement: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly rows: readonly {
    readonly kind: string;
    readonly transaction: string | null;
    readonly occurredAt: string | null;
    readonly amountMinor: string;
    readonly feeMinor: string;
    readonly netMinor: string;
  }[];
  readonly totals: Readonly<Record<string, string>>;
}

export function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toStatementCsv(input: StatementCsvInput): string {
  const lines: string[] = [];
  const row = (cells: readonly (string | null)[]) => lines.push(cells.map(csvCell).join(','));
  row(['settlement', input.settlement]);
  row(['currency', input.currency]);
  row(['period_start', input.periodStart]);
  row(['period_end', input.periodEnd]);
  for (const [name, value] of Object.entries(input.totals)) row([name, value]);
  row([]);
  row(['kind', 'transaction', 'occurred_at', 'amount_minor', 'fee_minor', 'net_minor']);
  for (const r of input.rows) {
    row([r.kind, r.transaction, r.occurredAt, r.amountMinor, r.feeMinor, r.netMinor]);
  }
  return `${lines.join('\r\n')}\r\n`;
}
