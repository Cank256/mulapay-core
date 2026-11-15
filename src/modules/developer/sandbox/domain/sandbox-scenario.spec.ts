import { describe, expect, it } from 'vitest';
import { assertGatewayEligible } from './gateway-boundary';
import {
  SANDBOX_SCENARIOS,
  isSandboxScenario,
  planFor,
  resolveScenario,
  type SandboxScenario,
} from './sandbox-scenario';

const resolve = (amountMinor: bigint, metadata: Record<string, string> = {}) =>
  resolveScenario({ amountMinor, metadata });

describe('sandbox scenario resolution', () => {
  it.each([
    [10_000n, 'succeed'],
    [10_000_00n, 'succeed'],
    [101n, 'fail'],
    [1_000_001n, 'fail'],
    [202n, 'timeout'],
    [303n, 'expire'],
    [404n, 'pending_then_succeed'],
    [505n, 'succeed'],
    [99n, 'succeed'],
    [1n, 'fail'],
  ] as const)('amount %s resolves to %s from its last two digits', (amount, expected) => {
    expect(resolve(amount)).toBe(expected);
  });

  it('prefers metadata.simulate over the amount', () => {
    for (const scenario of SANDBOX_SCENARIOS) {
      expect(resolve(101n, { simulate: scenario })).toBe(scenario);
    }
  });

  it('ignores an unknown simulate value here (creation refuses it before)', () => {
    expect(isSandboxScenario('boom')).toBe(false);
    expect(resolve(101n, { simulate: 'boom' })).toBe('fail');
  });

  it('is deterministic', () => {
    expect(resolve(20_002n)).toBe(resolve(20_002n));
  });
});

describe('sandbox plans', () => {
  const plans: Array<[SandboxScenario, string, boolean, string]> = [
    ['succeed', 'succeeded', false, 'none'],
    ['fail', 'failed', false, 'none'],
    ['expire', 'expired', false, 'none'],
    ['timeout', 'expired', true, 'timeout'],
    ['pending_then_succeed', 'succeeded', false, 'pending'],
  ];
  it.each(plans)(
    '%s ends %s (unknown outcome: %s, delay: %s)',
    (scenario, terminal, unknown, delay) => {
      expect(planFor(scenario)).toMatchObject({ terminal, outcomeUnknown: unknown, delay });
    }
  );
  it('gives every non-success terminal a sandbox failure code', () => {
    for (const scenario of ['fail', 'expire', 'timeout'] as const) {
      expect(planFor(scenario).failureCode).toMatch(/^sandbox_/);
    }
    expect(planFor('succeed').failureCode).toBeUndefined();
  });
});

describe('gateway boundary', () => {
  it('lets live operations through and refuses test ones', () => {
    expect(() => assertGatewayEligible('live')).not.toThrow();
    expect(() => assertGatewayEligible('test')).toThrow(/never be sent to the gateway/);
  });
});
