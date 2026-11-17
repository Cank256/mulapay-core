import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function variableNames(text: string): string[] {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string);
}

describe('README environment reference', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

  it('lists every variable in .env.example', () => {
    const missing = variableNames(example).filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it('names no variable that .env.example lacks', () => {
    const known = new Set(variableNames(example));
    const rows = [...readme.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1] as string);
    expect(rows.filter((name) => !known.has(name))).toEqual([]);
  });
});
