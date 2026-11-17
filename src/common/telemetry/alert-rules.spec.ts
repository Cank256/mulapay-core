import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './metrics';

const ROOT = join(__dirname, '..', '..', '..');
const rules = readFileSync(join(ROOT, 'deploy/alerts/core-api.rules.yml'), 'utf8');
const operations = readFileSync(join(ROOT, 'docs/OPERATIONS.md'), 'utf8');

/** GitHub-style heading anchors, plus explicit `{#id}` suffixes. */
function anchors(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/^#{2,4} (.+)$/gm)) {
    const heading = match[1] as string;
    const explicit = heading.match(/\{#([a-z0-9-]+)\}\s*$/);
    if (explicit) found.add(explicit[1] as string);
    const text = heading.replace(/\s*\{#[^}]+\}\s*$/, '');
    found.add(
      text
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, '')
        .trim()
        .replace(/ /g, '-')
    );
  }
  return found;
}

/** The rule blocks, one per `- alert:` entry, read without a YAML dependency. */
function alerts(): { name: string; body: string }[] {
  return [
    ...rules.matchAll(
      /^ {6}- alert: (\w+)\n([\s\S]*?)(?=^ {6}- alert: |^ {2}- name: |(?![\s\S]))/gm
    ),
  ].map((m) => ({ name: m[1] as string, body: m[2] as string }));
}

describe('alert rules (X-ALERT-1)', () => {
  const known = new Set(metricsRegistry.getMetricsAsArray().map((metric) => metric.name));
  const rows = alerts();

  it('defines the expected number of alerts and unique names', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
    expect((rules.match(/- alert: /g) ?? []).length).toBe(rows.length);
  });

  it('only references metrics that exist in the code', () => {
    for (const { name, body } of rows) {
      const expr = body.match(/^ {8}expr: (.+)$/m)?.[1] ?? '';
      expect(expr, `${name} has no expr`).not.toBe('');
      const metrics = [...expr.matchAll(/\bcore_[a-z0-9_]+/g)].map((m) =>
        m[0].replace(/_(bucket|sum|count)$/, '')
      );
      expect(metrics.length, `${name} references no core_ metric`).toBeGreaterThan(0);
      for (const metric of metrics) expect(known.has(metric), `${name}: ${metric}`).toBe(true);
    }
  });

  it('gives every alert a severity, a summary, a duration and a runbook heading that exists', () => {
    const headings = anchors(operations);
    for (const { name, body } of rows) {
      expect(body, name).toMatch(/^ {8}for: \d+[smh]$/m);
      expect(body, name).toMatch(/severity: (critical|warning)/);
      expect(body, name).toMatch(/^ {10}summary: \S/m);
      const runbook = body.match(/^ {10}runbook: docs\/OPERATIONS\.md#([a-z0-9-]+)$/m)?.[1];
      expect(runbook, `${name} has no runbook`).toBeDefined();
      expect(headings.has(runbook as string), `${name}: #${runbook}`).toBe(true);
    }
  });
});
