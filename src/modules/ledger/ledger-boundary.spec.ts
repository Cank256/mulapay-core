/**
 * Spec 6.6: posting is the only code path allowed to insert into journal tables, and
 * account balances change only through journal lines. Postgres enforces the second; this
 * test enforces the first in the source tree, so a shortcut cannot be added unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('ledger write boundary', () => {
  it('only the ledger repository references the journal tables', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith('db/schema/'))
      .filter((f) => f.path !== 'modules/ledger/ledger.repository.ts')
      .filter((f) => /\bjournal(Entries|Lines|EntryKeys)\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no application code writes account_balances except the zero-row lock helper', () => {
    const writers = files
      .filter((f) => /\.(insert|update|delete)\(accountBalances\)/.test(f.text))
      .map((f) => f.path);
    expect(writers).toEqual(['modules/balances/balances.repository.ts']);
    const repository = files.find((f) => f.path === 'modules/balances/balances.repository.ts');
    expect(repository?.text).not.toMatch(/\.(update|delete)\(accountBalances\)/);
  });

  it('no raw SQL writes the journal or balances outside the repositories', () => {
    const raw = files
      .filter((f) => !f.path.startsWith('db/'))
      .filter((f) =>
        /(insert\s+into|update|delete\s+from)\s+core\.(journal_|account_balances)/i.test(f.text)
      )
      .map((f) => f.path);
    expect(raw).toEqual([]);
  });
});
