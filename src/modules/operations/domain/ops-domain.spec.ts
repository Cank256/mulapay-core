import { describe, expect, it } from 'vitest';
import { evaluateFlag, rolloutBucket } from './flag-evaluation';
import {
  currenciesLeftUncovered,
  isLastEnabledRuleOfCurrency,
  ruleProblem,
  type ProviderState,
  type RuleState,
} from './routing-safety';
import { decide, queueDepthSeverity, stuckSeverity, suspenseSeverity } from './ops-signals';

const flag = (over: Partial<Parameters<typeof evaluateFlag>[0]> = {}) => ({
  key: 'new_checkout',
  enabled: true,
  rolloutPercent: 100,
  merchantAllowlist: [],
  ...over,
});

describe('feature flag evaluation', () => {
  it('is off for everyone when disabled, even an allow-listed merchant', () => {
    expect(evaluateFlag(flag({ enabled: false, merchantAllowlist: ['m1'] }), 'm1')).toBe(false);
    expect(evaluateFlag(flag({ enabled: false }))).toBe(false);
  });

  it('turns an allow-listed merchant on whatever the rollout', () => {
    expect(evaluateFlag(flag({ rolloutPercent: 0, merchantAllowlist: ['m1'] }), 'm1')).toBe(true);
    expect(evaluateFlag(flag({ rolloutPercent: 0, merchantAllowlist: ['m1'] }), 'm2')).toBe(false);
  });

  it('gives a merchant the same answer every time and only adds merchants as the rollout grows', () => {
    const merchants = Array.from({ length: 400 }, (_, i) => `merchant-${i}`);
    const at = (pct: number) =>
      merchants.filter((m) => evaluateFlag(flag({ rolloutPercent: pct }), m));
    const ten = at(10);
    const fifty = at(50);
    expect(at(10)).toEqual(ten);
    expect(ten.every((m) => fifty.includes(m))).toBe(true);
    expect(ten.length).toBeGreaterThan(10);
    expect(ten.length).toBeLessThan(80);
    expect(at(0)).toEqual([]);
    expect(at(100)).toHaveLength(400);
  });

  it('answers a platform-wide check only for a flag at 100%', () => {
    expect(evaluateFlag(flag({ rolloutPercent: 100 }))).toBe(true);
    expect(evaluateFlag(flag({ rolloutPercent: 99 }))).toBe(false);
  });

  it('buckets into 0..99', () => {
    for (let i = 0; i < 200; i++) {
      const b = rolloutBucket('k', `m${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe('routing safety', () => {
  const all = (enabled: Record<string, boolean>): ProviderState[] =>
    (['mtn', 'airtel', 'flutterwave'] as const).map((provider) => ({
      provider,
      enabled: enabled[provider] ?? true,
    }));
  const rule = (
    ref: string,
    currency: string,
    provider: RuleState['provider'],
    enabled = true
  ): RuleState => ({
    ref,
    currency,
    provider,
    enabled,
  });

  it('is safe to disable a provider nobody routes to', () => {
    expect(currenciesLeftUncovered('mtn', all({}), [])).toEqual([]);
    expect(currenciesLeftUncovered('mtn', all({}), [rule('r1', 'KES', 'airtel')])).toEqual([]);
  });

  it('is unsafe when every enabled rule of a currency names the provider', () => {
    const rules = [rule('r1', 'UGX', 'mtn'), rule('r2', 'UGX', 'mtn'), rule('r3', 'GHS', 'mtn')];
    expect(currenciesLeftUncovered('mtn', all({}), rules)).toEqual(['GHS', 'UGX']);
  });

  it('is safe when another enabled provider has a rule for the currency', () => {
    const spread = [rule('r1', 'UGX', 'mtn'), rule('r2', 'UGX', 'airtel')];
    expect(currenciesLeftUncovered('mtn', all({}), spread)).toEqual([]);
    // ...but not when that other provider is itself disabled, or its rule is.
    expect(currenciesLeftUncovered('mtn', all({ airtel: false }), spread)).toEqual(['UGX']);
    const off = [rule('r1', 'UGX', 'mtn'), rule('r2', 'UGX', 'airtel', false)];
    expect(currenciesLeftUncovered('mtn', all({}), off)).toEqual(['UGX']);
  });

  it('knows the last enabled rule of a currency', () => {
    const rules = [
      rule('a', 'UGX', 'mtn'),
      rule('b', 'UGX', 'airtel', false),
      rule('c', 'KES', 'airtel'),
    ];
    expect(isLastEnabledRuleOfCurrency(rules[0]!, rules)).toBe(true);
    expect(isLastEnabledRuleOfCurrency(rules[1]!, rules)).toBe(false);
    expect(isLastEnabledRuleOfCurrency(rules[2]!, rules)).toBe(true);
    const two = [...rules, rule('d', 'UGX', 'flutterwave')];
    expect(isLastEnabledRuleOfCurrency(two[0]!, two)).toBe(false);
  });

  it('refuses a rule for a provider that cannot serve the currency or is disabled', () => {
    expect(ruleProblem('mtn', 'KES', all({}), true)).toBe('provider_unsupported_currency');
    expect(ruleProblem('airtel', 'UGX', all({ airtel: false }), true)).toBe('provider_disabled');
    expect(ruleProblem('airtel', 'UGX', all({ airtel: false }), false)).toBeUndefined();
    expect(ruleProblem('stripe', 'UGX', all({}), true)).toBe('provider_unknown');
    expect(ruleProblem('mtn', 'UGX', all({}), true)).toBeUndefined();
  });
});

describe('incident monitor decisions', () => {
  const now = new Date('2025-03-01T12:00:00Z');
  const reading = (active: boolean) => ({ active, severity: 'sev3' as const, value: {} });

  it('waits until a condition has lasted its sustain time', () => {
    const since = new Date(now.getTime() - 100_000);
    expect(decide(reading(true), { activeSince: null }, now, 300)).toEqual({
      action: 'wait',
      activeSince: now,
    });
    expect(decide(reading(true), { activeSince: since }, now, 300).action).toBe('wait');
    expect(decide(reading(true), { activeSince: since }, now, 100).action).toBe('open');
    expect(decide(reading(true), { activeSince: null }, now, 0).action).toBe('open');
  });

  it('clears when the condition goes, and says whether it had been seen', () => {
    expect(decide(reading(false), { activeSince: null }, now, 0)).toEqual({
      action: 'clear',
      wasActive: false,
    });
    expect(decide(reading(false), { activeSince: now }, now, 0)).toEqual({
      action: 'clear',
      wasActive: true,
    });
  });

  it('sets severity by how long and how bad', () => {
    expect(suspenseSeverity(3600, 24)).toBe('sev2');
    expect(suspenseSeverity(24 * 3600, 24)).toBe('sev1');
    expect(stuckSeverity(14, 60)).toBe('sev3');
    expect(stuckSeverity(60, 60)).toBe('sev2');
    expect(queueDepthSeverity(1000, 1000)).toBe('sev3');
    expect(queueDepthSeverity(5000, 1000)).toBe('sev2');
  });
});
