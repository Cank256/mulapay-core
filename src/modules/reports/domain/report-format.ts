/**
 * Serialising report rows as they stream (spec 6.12): no row is kept after it is written.
 *
 * CSV follows RFC 4180 (comma, double quotes, CRLF). A text cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return is prefixed with an apostrophe, so a spreadsheet does not run
 * a merchant-controlled value (a payment description, a complaint subject) as a formula.
 * Numeric columns are written as they are, because a negative amount starts with `-`.
 * JSON is one array of objects, written element by element.
 */
export type ColumnKind = 'text' | 'number';

export interface Column {
  readonly label: string;
  readonly kind: ColumnKind;
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | null, kind: ColumnKind): string {
  if (value === null) return '';
  const safe = kind === 'text' && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvHeader(columns: readonly Column[]): string {
  return `${columns.map((c) => csvCell(c.label, 'text')).join(',')}\r\n`;
}

export function csvRow(columns: readonly Column[], row: ReadonlyArray<string | null>): string {
  return `${columns.map((c, i) => csvCell(row[i] ?? null, c.kind)).join(',')}\r\n`;
}

export function jsonRow(
  columns: readonly Column[],
  row: ReadonlyArray<string | null>,
  first: boolean
): string {
  const object: Record<string, string | null> = {};
  columns.forEach((c, i) => {
    object[c.label] = row[i] ?? null;
  });
  return `${first ? '' : ',\n'}${JSON.stringify(object)}`;
}

export const JSON_OPEN = '[\n';
export const JSON_CLOSE = '\n]\n';

export function contentTypeOf(format: 'csv' | 'json'): string {
  return format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json';
}

export function extensionOf(format: 'csv' | 'json'): string {
  return format;
}
