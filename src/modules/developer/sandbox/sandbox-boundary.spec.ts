/**
 * Test keys never reach the gateway (spec 6.11, D4): the sandbox must not import the
 * gateway integration, and nothing outside the gateway integration may import the gateway
 * HTTP client without going through the environment check. This reads the source tree so a
 * shortcut cannot be added unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../..');
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

describe('sandbox and the gateway', () => {
  it('nothing under the sandbox imports the gateway integration', () => {
    const offenders = files
      .filter((f) => f.path.startsWith('modules/developer/sandbox/'))
      .filter((f) => /integrations\/gateway/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
  it('the payment creator and lifecycle never import the gateway integration', () => {
    const offenders = files
      .filter((f) => f.path.startsWith('modules/payments/'))
      .filter((f) => /integrations\/gateway/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
  it('the webhook transport is not the gateway client: it never uses the gateway key or base URL', () => {
    const transport = files.find((f) => f.path === 'modules/webhooks/webhook-transport.ts');
    expect(transport?.text).not.toMatch(/GATEWAY_/);
  });
});
