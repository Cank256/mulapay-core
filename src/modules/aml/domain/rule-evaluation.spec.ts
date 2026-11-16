import { describe, expect, it } from 'vitest';
import {
  alertScore,
  evaluateRule,
  ruleIsEffective,
  type MonitoredTransaction,
  type RuleFacts,
} from './rule-evaluation';
import { parseRuleParams, type ParsedRule } from './rule-params';

const AT = new Date('2025-06-10T12:00:00Z');
const txn = (over: Partial<MonitoredTransaction> = {}): MonitoredTransaction => ({
  amountMinor: 1_000_000n,
  currency: 'UGX',
  status: 'succeeded',
  completedAt: AT,
  msisdn: '+256700000001',
  counterpartyHmac: 'a'.repeat(64),
  ...over,
});
const merchant = { createdAt: new Date('2025-01-01T00:00:00Z') };
function facts(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    windowTotals: async () => ({ count: 0, sumMinor: 0n }),
    countInBand: async () => 0,
    countRound: async () => 0,
    counterpartyPayments: async () => ({ count: 0, merchants: 0 }),
    ...over,
  };
}
function rule(type: string, params: Record<string, unknown>): ParsedRule {
  const parsed = parseRuleParams(type, { currency: 'UGX', ...params });
  if (!parsed.ok) throw new Error(parsed.issues.join('; '));
  return parsed.rule;
}

describe('velocity', () => {
  const count = rule('velocity', { measure: 'count', windowSeconds: 3600, max: 5 });
  const value = rule('velocity', { measure: 'value', windowSeconds: 3600, maxMinor: '5000000' });

  it('fires on a count above the maximum, not at it', async () => {
    const at = (n: number) => facts({ windowTotals: async () => ({ count: n, sumMinor: 0n }) });
    expect((await evaluateRule(count, txn(), merchant, at(5))).fired).toBe(false);
    const hit = await evaluateRule(count, txn(), merchant, at(6));
    expect(hit).toMatchObject({ fired: true, details: { observed: 6, max: 5 } });
  });

  it('fires on a value above the maximum', async () => {
    const at = (sum: bigint) => facts({ windowTotals: async () => ({ count: 1, sumMinor: sum }) });
    expect((await evaluateRule(value, txn(), merchant, at(5_000_000n))).fired).toBe(false);
    expect((await evaluateRule(value, txn(), merchant, at(5_000_001n))).fired).toBe(true);
  });

  it('ignores another currency and a status the rule does not watch', async () => {
    const busy = facts({ windowTotals: async () => ({ count: 99, sumMinor: 0n }) });
    expect((await evaluateRule(count, txn({ currency: 'KES' }), merchant, busy)).fired).toBe(false);
    expect((await evaluateRule(count, txn({ status: 'failed' }), merchant, busy)).fired).toBe(
      false
    );
  });
});

describe('amount threshold', () => {
  const r = rule('amount_threshold', { thresholdMinor: '20000000' });
  it('fires at the threshold and above, not below', async () => {
    expect(
      (await evaluateRule(r, txn({ amountMinor: 19_999_999n }), merchant, facts())).fired
    ).toBe(false);
    expect(
      (await evaluateRule(r, txn({ amountMinor: 20_000_000n }), merchant, facts())).fired
    ).toBe(true);
  });
});

describe('structuring', () => {
  const r = rule('structuring', {
    thresholdMinor: '10000000',
    bandBps: 1000,
    windowSeconds: 86400,
    minCount: 3,
  });
  it('looks only at payments in the band just under the threshold', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const f = facts({
      countInBand: async (_w, _s, from, to) => {
        calls.push([from, to]);
        return 3;
      },
    });
    expect((await evaluateRule(r, txn({ amountMinor: 8_999_999n }), merchant, f)).fired).toBe(
      false
    );
    expect((await evaluateRule(r, txn({ amountMinor: 10_000_000n }), merchant, f)).fired).toBe(
      false
    );
    expect(calls).toEqual([]);
    const hit = await evaluateRule(r, txn({ amountMinor: 9_500_000n }), merchant, f);
    expect(hit.fired).toBe(true);
    expect(calls).toEqual([[9_000_000n, 9_999_999n]]);
  });

  it('needs enough payments in the band', async () => {
    const f = facts({ countInBand: async () => 2 });
    expect((await evaluateRule(r, txn({ amountMinor: 9_500_000n }), merchant, f)).fired).toBe(
      false
    );
  });
});

describe('geography', () => {
  it('fires on a flagged calling code', async () => {
    const r = rule('geography', { flaggedPrefixes: ['+850', '+98'] });
    expect(
      await evaluateRule(r, txn({ msisdn: '+989121234567' }), merchant, facts())
    ).toMatchObject({
      fired: true,
      details: { reason: 'flagged_prefix', prefix: '+98' },
    });
    expect((await evaluateRule(r, txn(), merchant, facts())).fired).toBe(false);
  });

  it('fires on a number outside the allowed prefixes', async () => {
    const r = rule('geography', { allowedPrefixes: ['+256'] });
    expect((await evaluateRule(r, txn({ msisdn: '+254711000000' }), merchant, facts())).fired).toBe(
      true
    );
    expect((await evaluateRule(r, txn(), merchant, facts())).fired).toBe(false);
  });

  it('cannot fire without a number, and an empty rule never fires', async () => {
    const r = rule('geography', { flaggedPrefixes: ['+98'] });
    expect((await evaluateRule(r, txn({ msisdn: null }), merchant, facts())).fired).toBe(false);
    expect((await evaluateRule(rule('geography', {}), txn(), merchant, facts())).fired).toBe(false);
  });
});

describe('new account burst', () => {
  const r = rule('new_account', {
    measure: 'count',
    accountAgeDays: 30,
    windowSeconds: 3600,
    max: 3,
  });
  const busy = facts({ windowTotals: async () => ({ count: 4, sumMinor: 0n }) });
  it('fires for a merchant younger than the limit', async () => {
    const young = { createdAt: new Date('2025-06-01T00:00:00Z') };
    expect((await evaluateRule(r, txn(), young, busy)).fired).toBe(true);
  });
  it('does not fire for an established merchant', async () => {
    expect((await evaluateRule(r, txn(), merchant, busy)).fired).toBe(false);
  });
  it('supports a value limit', async () => {
    const v = rule('new_account', {
      measure: 'value',
      accountAgeDays: 30,
      windowSeconds: 3600,
      maxMinor: '100',
    });
    const young = { createdAt: new Date('2025-06-09T00:00:00Z') };
    const rich = facts({ windowTotals: async () => ({ count: 1, sumMinor: 101n }) });
    expect((await evaluateRule(v, txn(), young, rich)).fired).toBe(true);
  });
});

describe('round amounts', () => {
  const r = rule('round_amount', {
    roundUnitMinor: '1000000',
    minAmountMinor: '5000000',
    windowSeconds: 86400,
    minCount: 3,
  });
  it('needs a round, large-enough amount and enough of them', async () => {
    const f = facts({ countRound: async () => 3 });
    expect((await evaluateRule(r, txn({ amountMinor: 5_000_000n }), merchant, f)).fired).toBe(true);
    expect((await evaluateRule(r, txn({ amountMinor: 5_000_001n }), merchant, f)).fired).toBe(
      false
    );
    expect((await evaluateRule(r, txn({ amountMinor: 4_000_000n }), merchant, f)).fired).toBe(
      false
    );
    expect(
      (
        await evaluateRule(
          r,
          txn({ amountMinor: 5_000_000n }),
          merchant,
          facts({ countRound: async () => 2 })
        )
      ).fired
    ).toBe(false);
  });
});

describe('counterparty reuse', () => {
  it('counts payments at one merchant, or merchants for one payer', async () => {
    const f = facts({ counterpartyPayments: async () => ({ count: 4, merchants: 2 }) });
    const one = rule('counterparty_reuse', { scope: 'merchant', windowSeconds: 3600, minCount: 4 });
    const many = rule('counterparty_reuse', {
      scope: 'platform',
      windowSeconds: 3600,
      minCount: 3,
    });
    expect((await evaluateRule(one, txn(), merchant, f)).fired).toBe(true);
    expect((await evaluateRule(many, txn(), merchant, f)).fired).toBe(false);
  });
  it('cannot fire for a payment without a payer number', async () => {
    const r = rule('counterparty_reuse', { scope: 'merchant', windowSeconds: 3600, minCount: 2 });
    const f = facts({ counterpartyPayments: async () => ({ count: 9, merchants: 9 }) });
    expect((await evaluateRule(r, txn({ counterpartyHmac: null }), merchant, f)).fired).toBe(false);
  });
});

describe('details and scoring', () => {
  it('never put a phone number or hash into an alert', async () => {
    const f = facts({
      windowTotals: async () => ({ count: 9, sumMinor: 9n }),
      counterpartyPayments: async () => ({ count: 9, merchants: 9 }),
      countInBand: async () => 9,
      countRound: async () => 9,
    });
    const rules = [
      rule('velocity', { measure: 'count', windowSeconds: 60, max: 1 }),
      rule('counterparty_reuse', { scope: 'merchant', windowSeconds: 60, minCount: 2 }),
      rule('geography', { flaggedPrefixes: ['+256'] }),
    ];
    for (const r of rules) {
      const hit = await evaluateRule(r, txn(), merchant, f);
      expect(JSON.stringify(hit)).not.toContain('+25670');
      expect(JSON.stringify(hit)).not.toContain('aaaaaaaa');
    }
  });

  it('scores from the severity floor up to ten more points', () => {
    expect(alertScore('low', 0)).toBe(25);
    expect(alertScore('critical', 1)).toBe(100);
    expect(alertScore('high', 0.5)).toBe(80);
    expect(alertScore('medium', 7)).toBe(60);
  });

  it('knows when a rule is in force', () => {
    const base = {
      enabled: true,
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      effectiveTo: null,
    };
    expect(ruleIsEffective(base, AT)).toBe(true);
    expect(ruleIsEffective({ ...base, enabled: false }, AT)).toBe(false);
    expect(ruleIsEffective({ ...base, effectiveFrom: new Date('2025-07-01T00:00:00Z') }, AT)).toBe(
      false
    );
    expect(ruleIsEffective({ ...base, effectiveTo: AT }, AT)).toBe(false);
    expect(ruleIsEffective({ ...base, effectiveTo: new Date('2025-06-11T00:00:00Z') }, AT)).toBe(
      true
    );
  });
});

describe('rule parameters', () => {
  it('rejects unknown keys, bad money and unknown types', () => {
    expect(
      parseRuleParams('velocity', {
        currency: 'UGX',
        measure: 'count',
        windowSeconds: 60,
        max: 1,
        extra: 1,
      }).ok
    ).toBe(false);
    expect(
      parseRuleParams('amount_threshold', { currency: 'UGX', thresholdMinor: '12.5' }).ok
    ).toBe(false);
    expect(parseRuleParams('amount_threshold', { currency: 'UGX', thresholdMinor: '0' }).ok).toBe(
      false
    );
    expect(parseRuleParams('amount_threshold', { currency: 'XXX', thresholdMinor: '5' }).ok).toBe(
      false
    );
    expect(parseRuleParams('nonsense', {}).ok).toBe(false);
    expect(parseRuleParams('geography', { currency: 'UGX', flaggedPrefixes: ['256'] }).ok).toBe(
      false
    );
  });

  it('fills the default status list', () => {
    const parsed = parseRuleParams('amount_threshold', { currency: 'UGX', thresholdMinor: '5' });
    expect(parsed.ok && parsed.rule.params.statuses).toEqual(['succeeded']);
  });
});
