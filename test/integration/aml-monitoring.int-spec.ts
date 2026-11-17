/**
 * AML monitoring (spec 6.13 step 3): every terminal live payment is monitored, asynchronously;
 * each rule type fires on a crafted scenario; thresholds, windows, severity, action, effective
 * dates and the audit trail are configurable; alerts carry an SLA and escalate when it passes;
 * alerts roll up into cases; a case exports an STR package.
 *
 * Live money in XAF, which no other suite uses, so a rule enabled here cannot act on another
 * suite's merchants. Every test disables the rules it created.
 */
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AML_MONITOR_JOB,
  AML_TERMINAL_OUTBOX_TYPE,
  AmlTerminalHandler,
} from '../../src/modules/aml/monitoring/aml-monitoring.trigger';
import { metricsRegistry } from '../../src/common/telemetry/metrics';
import { HoldsService } from '../../src/modules/holds/holds.service';
import { staffSession, type StaffSession } from '../support/identity';
import { createPayment, event, applyEvent, sql, toProcessing } from '../support/payments';
import {
  activeMerchant,
  errorCodeOf,
  FAKE_S3,
  startComplianceContext,
  succeedLivePayment,
  uniqueMsisdn,
  type ComplianceContext,
} from '../support/compliance';
import type { TestMerchant } from '../support/payments';

const CUR = 'XAF';
const HOUR = 3_600_000;

let ctx: ComplianceContext;
let staff: StaffSession;
let staffUuid: string;
const created: string[] = [];

beforeAll(async () => {
  ctx = await startComplianceContext();
  staff = await staffSession(ctx, 'compliance');
  const [row] = await sql<{ id: string }>('select id from core.users where email = $1', [
    staff.admin.email,
  ]);
  staffUuid = row?.id as string;
});
afterAll(async () => {
  await ctx?.close();
});
// Some tests move the shared clock days ahead, which expires tokens: log in again for each test.
beforeEach(async () => {
  staff = await staffSession(ctx, 'compliance');
});
afterEach(async () => {
  for (const code of created.splice(0)) {
    await ctx.rules.update(code, { enabled: false }, staffUuid);
  }
});

type Severity = 'low' | 'medium' | 'high' | 'critical';

async function makeRule(
  type: string,
  params: Record<string, unknown>,
  over: {
    severity?: Severity;
    action?: 'flag' | 'hold' | 'block';
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
  } = {}
): Promise<string> {
  const code = `t.${type}.${randomUUID().slice(0, 8)}`;
  await ctx.rules.create(
    {
      code,
      name: `Test ${type}`,
      ruleType: type,
      params: { currency: CUR, ...params },
      severity: over.severity ?? 'medium',
      action: over.action ?? 'flag',
      enabled: true,
      ...over,
    },
    staffUuid
  );
  created.push(code);
  return code;
}

/** A live payment, monitored as the `aml-screen` worker will. */
async function pay(
  merchant: TestMerchant,
  amountMinor: bigint,
  msisdn?: string
): Promise<{ transactionId: string; alerts: string[]; result: string }> {
  const payment = await succeedLivePayment(ctx, merchant, { amountMinor, currency: CUR, msisdn });
  const outcome = await ctx.monitoring.monitor(payment.transactionId);
  return {
    transactionId: payment.transactionId,
    result: outcome.result,
    alerts: outcome.result === 'monitored' ? outcome.alerts : [],
  };
}

const alertsOf = (merchantRef: string, rule?: string) =>
  sql<{
    ref: string;
    rule_code: string;
    rule_version: number;
    severity: string;
    status: string;
    score: number;
    action: string;
    details: Record<string, unknown>;
    due_at: Date;
    created_at: Date;
    transaction_id: string;
    hold_id: string | null;
  }>(
    `select a.ref, a.rule_code, a.rule_version, a.severity, a.status, a.score, a.action, a.details,
            a.due_at, a.created_at, a.transaction_id, a.hold_id
       from core.aml_alerts a join core.merchants m on m.id = a.merchant_id
      where m.ref = $1 and ($2::text is null or a.rule_code = $2) order by a.created_at, a.ref`,
    [merchantRef, rule ?? null]
  );

async function available(merchant: TestMerchant): Promise<bigint> {
  const balance = await ctx.balances.merchantBalance(merchant.id, 'live', CUR);
  return balance.availableMinor;
}

describe('every terminal live payment is monitored, asynchronously', () => {
  it('queues monitoring in the transaction that made the payment terminal, and not for test payments', async () => {
    const m = await activeMerchant(ctx, 'trigger');
    const ok = await succeedLivePayment(ctx, m, { amountMinor: 1_000n, currency: CUR });

    // A failed payment is terminal too.
    const failedPayment = await createPayment(m.live!, {
      amountMinor: '2000',
      currency: CUR,
      paymentMethod: { provider: 'mtn', msisdn: uniqueMsisdn() },
    });
    const detail = await ctx.paymentsRepository.findDetailByRef(m.scope('live'), failedPayment.id);
    await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'mtn' } });
    const failed = await applyEvent(
      ctx,
      detail!.payment.id,
      event({ kind: 'failed', failureCode: 'insufficient_funds' })
    );
    expect(failed.result).toBe('applied');

    // A test-environment payment is never monitored.
    const test = await createPayment(m.test, { amountMinor: '3000', currency: CUR });
    expect(test.id).toMatch(/^pay_/);

    const failedRows = await sql(
      `select 1 from core.outbox where event_type = $1 and payload ->> 'transactionId' = $2`,
      [AML_TERMINAL_OUTBOX_TYPE, detail!.transaction.id]
    );
    expect(failedRows).toHaveLength(1);

    const rows = await sql<{ payload: { transactionId: string }; published_at: Date | null }>(
      `select payload, published_at from core.outbox where event_type = $1 and payload ->> 'transactionId' = $2`,
      [AML_TERMINAL_OUTBOX_TYPE, ok.transactionId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.published_at).toBeNull();

    // The outbox handler turns the row into one idempotent aml-screen job.
    const handler = ctx.app.get(AmlTerminalHandler, { strict: false });
    const jobs = await handler.handle(
      ctx.db as never,
      { payload: { transactionId: ok.transactionId } } as never
    );
    expect(jobs).toEqual([
      {
        queue: 'aml-screen',
        name: AML_MONITOR_JOB,
        data: { transactionId: ok.transactionId },
        options: { jobId: `aml_monitor_${ok.transactionId}` },
      },
    ]);
    const testRows = await sql(
      `select 1 from core.outbox where event_type = $1 and payload ->> 'transactionId' in
         (select id::text from core.transactions where merchant_id = $2 and environment = 'test')`,
      [AML_TERMINAL_OUTBOX_TYPE, m.id]
    );
    expect(testRows).toHaveLength(0);
  });

  it('does the work once however often the job runs', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '1000' });
    const m = await activeMerchant(ctx, 'once');
    const payment = await succeedLivePayment(ctx, m, { amountMinor: 5_000n, currency: CUR });
    const first = await ctx.monitoring.monitor(payment.transactionId);
    const second = await ctx.monitoring.monitor(payment.transactionId);
    const third = await ctx.monitoring.monitor(payment.transactionId);
    expect(first.result).toBe('monitored');
    expect(second.result).toBe('already_monitored');
    expect(third.result).toBe('already_monitored');
    expect(await alertsOf(m.ref)).toHaveLength(1);
    const facts = await sql('select 1 from core.aml_transaction_facts where transaction_id = $1', [
      payment.transactionId,
    ]);
    expect(facts).toHaveLength(1);
    expect(
      await ctx.monitoring
        .monitor(randomUUID())
        .then((o) => (o.result === 'not_applicable' ? o.reason : o.result))
    ).toBe('unknown_transaction');
  });

  it('does not monitor test or non-terminal transactions', async () => {
    const m = await activeMerchant(ctx, 'untouched');
    const created = await createPayment(m.live!, {
      amountMinor: '4000',
      currency: CUR,
      paymentMethod: { provider: 'mtn', msisdn: uniqueMsisdn() },
    });
    const detail = await ctx.paymentsRepository.findDetailByRef(m.scope('live'), created.id);
    const outcome = await ctx.monitoring.monitor(detail!.transaction.id);
    expect(outcome).toEqual({ result: 'not_applicable', reason: 'not_terminal' });
  });
});

describe('each rule type fires on a crafted scenario', () => {
  it('velocity: count in a window', async () => {
    const code = await makeRule('velocity', { measure: 'count', windowSeconds: 3600, max: 2 });
    const m = await activeMerchant(ctx, 'v-count');
    const [a, b, c] = [await pay(m, 1_000n), await pay(m, 1_000n), await pay(m, 1_000n)];
    expect([a.alerts, b.alerts]).toEqual([[], []]);
    expect(c.alerts).toHaveLength(1);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert).toMatchObject({
      status: 'open',
      severity: 'medium',
      action: 'flag',
      rule_version: 1,
      transaction_id: c.transactionId,
    });
    expect(alert?.details).toMatchObject({
      measure: 'count',
      observed: 3,
      max: 2,
      windowSeconds: 3600,
    });
    expect(alert?.score).toBeGreaterThanOrEqual(50);
  });

  it('velocity: value in a window', async () => {
    const code = await makeRule('velocity', {
      measure: 'value',
      windowSeconds: 3600,
      maxMinor: '50000',
    });
    const m = await activeMerchant(ctx, 'v-value');
    const results = [await pay(m, 20_000n), await pay(m, 20_000n), await pay(m, 20_000n)];
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 1]);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert?.details).toMatchObject({
      measure: 'value',
      observedMinor: '60000',
      maxMinor: '50000',
    });
  });

  it('amount threshold: at the threshold, not below', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '100000' }, { severity: 'high' });
    const m = await activeMerchant(ctx, 'threshold');
    const below = await pay(m, 99_999n);
    const at = await pay(m, 100_000n);
    expect(below.alerts).toEqual([]);
    expect(at.alerts).toHaveLength(1);
    const [alert] = await alertsOf(m.ref);
    expect(alert).toMatchObject({ severity: 'high', transaction_id: at.transactionId });
    expect(alert?.details).toMatchObject({ amountMinor: '100000', thresholdMinor: '100000' });
  });

  it('structuring: repeated payments just under the threshold', async () => {
    const code = await makeRule('structuring', {
      thresholdMinor: '100000',
      bandBps: 1000,
      windowSeconds: 3600,
      minCount: 3,
    });
    const m = await activeMerchant(ctx, 'structuring');
    const results = [
      await pay(m, 95_000n),
      await pay(m, 50_000n), // far under: not part of the pattern
      await pay(m, 92_000n),
      await pay(m, 99_000n),
    ];
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 0, 1]);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert?.details).toMatchObject({ observed: 3, minCount: 3, thresholdMinor: '100000' });
    // A payment at the threshold is not "just under" it.
    expect((await pay(m, 100_000n)).alerts).toEqual([]);
  });

  it('geography: a flagged calling code', async () => {
    const code = await makeRule('geography', { flaggedPrefixes: ['+850', '+98'] });
    const m = await activeMerchant(ctx, 'geo');
    expect((await pay(m, 1_000n)).alerts).toEqual([]);
    const flagged = await pay(m, 1_000n, '+989121234567');
    expect(flagged.alerts).toHaveLength(1);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert?.details).toMatchObject({ reason: 'flagged_prefix', prefix: '+98' });
    expect(JSON.stringify(alert?.details)).not.toContain('9121234567');
  });

  it('new-account burst: a young merchant taking many payments, but not an established one', async () => {
    const code = await makeRule('new_account', {
      measure: 'count',
      accountAgeDays: 30,
      windowSeconds: 3600,
      max: 3,
    });
    const young = await activeMerchant(ctx, 'young');
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await pay(young, 1_000n));
    expect(outcomes.map((o) => o.alerts.length)).toEqual([0, 0, 0, 1]);
    expect((await alertsOf(young.ref, code))[0]?.details).toMatchObject({
      observed: 4,
      max: 3,
      accountAgeDays: 30,
    });

    // The same burst, forty days after the merchant was created, is not a new-account burst.
    const old = await activeMerchant(ctx, 'old');
    ctx.clock.advanceBy(40 * 24 * HOUR);
    for (let i = 0; i < 5; i++) expect((await pay(old, 1_000n)).alerts).toEqual([]);
  });

  it('round amounts: repeated large round payments', async () => {
    const code = await makeRule('round_amount', {
      roundUnitMinor: '10000',
      minAmountMinor: '50000',
      windowSeconds: 3600,
      minCount: 3,
    });
    const m = await activeMerchant(ctx, 'round');
    const results = [
      await pay(m, 50_000n),
      await pay(m, 55_555n), // not round
      await pay(m, 60_000n),
      await pay(m, 10_000n), // round but small
      await pay(m, 70_000n),
    ];
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 0, 0, 1]);
    expect((await alertsOf(m.ref, code))[0]?.details).toMatchObject({
      observed: 3,
      roundUnitMinor: '10000',
    });
  });

  it('counterparty reuse: one payer, many payments', async () => {
    const code = await makeRule('counterparty_reuse', {
      scope: 'merchant',
      windowSeconds: 3600,
      minCount: 3,
    });
    const m = await activeMerchant(ctx, 'reuse');
    const payer = uniqueMsisdn();
    const results = [
      await pay(m, 1_000n, payer),
      await pay(m, 1_000n, payer),
      await pay(m, 1_000n, payer),
    ];
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 1]);
    expect((await pay(m, 1_000n, uniqueMsisdn())).alerts).toEqual([]);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert?.details).toMatchObject({ scope: 'merchant', observed: 3, minCount: 3 });
    // The payer's number appears nowhere in the alert or in the facts table, only as a keyed hash.
    expect(JSON.stringify(alert)).not.toContain(payer.slice(4));
    const facts = await sql<{ counterparty_hmac: string }>(
      'select counterparty_hmac from core.aml_transaction_facts where merchant_id = $1',
      [m.id]
    );
    expect(facts.every((f) => /^[0-9a-f]{64}$/.test(f.counterparty_hmac))).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(payer.slice(4));
  });

  it('counterparty reuse across merchants: one payer paying several merchants', async () => {
    const code = await makeRule('counterparty_reuse', {
      scope: 'platform',
      windowSeconds: 3600,
      minCount: 3,
    });
    const payer = uniqueMsisdn();
    const merchants = [
      await activeMerchant(ctx, 'x1'),
      await activeMerchant(ctx, 'x2'),
      await activeMerchant(ctx, 'x3'),
    ];
    const results = [];
    for (const merchant of merchants) results.push(await pay(merchant, 1_000n, payer));
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 1]);
    const [alert] = await alertsOf(merchants[2]?.ref as string, code);
    expect(alert?.details).toMatchObject({ scope: 'platform', observed: 3 });
  });

  it('ignores another currency and statuses the rule does not watch', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '1' });
    const m = await activeMerchant(ctx, 'other-currency');
    const other = await succeedLivePayment(ctx, m, { amountMinor: 5_000n, currency: 'UGX' });
    const outcome = await ctx.monitoring.monitor(other.transactionId);
    expect(outcome).toMatchObject({ result: 'monitored', alerts: [] });
  });
});

describe('rule configuration', () => {
  it('is editable: enable and disable, thresholds, windows, severity, action, with a version history and audit trail', async () => {
    const code = await makeRule(
      'velocity',
      { measure: 'count', windowSeconds: 3600, max: 1 },
      { severity: 'low' }
    );
    const m = await activeMerchant(ctx, 'configurable');
    await pay(m, 1_000n);
    expect((await pay(m, 1_000n)).alerts).toHaveLength(1);

    // Disable: the next payment raises nothing.
    const off = await staff.client.patch(`/admin/v1/aml/rules/${code}`, {
      enabled: false,
      reason: 'tuning',
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({ enabled: false, version: 2 });
    expect((await pay(m, 1_000n)).alerts).toEqual([]);

    // Re-enable with a higher threshold, a longer window and a higher severity.
    const on = await staff.client.patch(`/admin/v1/aml/rules/${code}`, {
      enabled: true,
      params: { currency: CUR, measure: 'count', windowSeconds: 7200, max: 4 },
      severity: 'critical',
    });
    expect(on.json().data).toMatchObject({ enabled: true, severity: 'critical', version: 3 });
    expect(on.json().data.params).toMatchObject({ windowSeconds: 7200, max: 4 });
    expect((await pay(m, 1_000n)).alerts).toEqual([]); // the fourth payment is within the new maximum
    expect((await pay(m, 1_000n)).alerts).toHaveLength(1); // the fifth is not
    const raised = await alertsOf(m.ref, code);
    expect(raised.map((a) => [a.severity, a.rule_version])).toEqual([
      ['low', 1],
      ['critical', 3],
    ]);

    const versions = await sql<{
      version: number;
      snapshot: { enabled: boolean; severity: string };
    }>(
      `select v.version, v.snapshot from core.aml_rule_versions v
         join core.aml_rules r on r.id = v.rule_id where r.code = $1 order by v.version`,
      [code]
    );
    expect(versions.map((v) => [v.version, v.snapshot.enabled, v.snapshot.severity])).toEqual([
      [1, true, 'low'],
      [2, false, 'low'],
      [3, true, 'critical'],
    ]);
    const audit = await sql<{ action: string; changed_fields: string[] }>(
      `select action, changed_fields from core.audit_logs where resource_type = 'aml_rule' and resource_id = $1 order by seq`,
      [code]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'aml.rule.created',
      'aml.rule.updated',
      'aml.rule.updated',
    ]);
    const listed = (await staff.client.get('/admin/v1/aml/rules')).json().data.items;
    expect(listed.find((r: { code: string }) => r.code === code)).toMatchObject({ version: 3 });
  });

  it('counts only rules that are enabled and in effect now (P7-C2 coverage signal)', async () => {
    // Other suites share this database, so compare against the count before each change.
    const base = await ctx.coverage.refresh();
    await makeRule('amount_threshold', { thresholdMinor: '1' });
    expect(await ctx.coverage.refresh()).toBe(base + 1);
    await makeRule(
      'amount_threshold',
      { thresholdMinor: '1' },
      { effectiveFrom: new Date(ctx.clock.now().getTime() + 6 * HOUR) }
    );
    await makeRule(
      'amount_threshold',
      { thresholdMinor: '1' },
      {
        effectiveFrom: new Date(ctx.clock.now().getTime() - 2 * HOUR),
        effectiveTo: new Date(ctx.clock.now().getTime() - HOUR),
      }
    );
    expect(await ctx.coverage.refresh()).toBe(base + 1);
    const metrics = await metricsRegistry.getSingleMetricAsString('core_aml_rules_enabled');
    expect(metrics).toMatch(new RegExp(`^core_aml_rules_enabled\\{[^}]*\\} ${base + 1}$`, 'm'));
  });
  it('honours effective dates, judged at the time the payment completed', async () => {
    const future = await makeRule(
      'amount_threshold',
      { thresholdMinor: '1' },
      { effectiveFrom: new Date(ctx.clock.now().getTime() + 6 * HOUR) }
    );
    const expired = await makeRule(
      'amount_threshold',
      { thresholdMinor: '1' },
      {
        effectiveFrom: new Date(ctx.clock.now().getTime() - 2 * HOUR),
        effectiveTo: new Date(ctx.clock.now().getTime() - HOUR),
      }
    );
    const current = await makeRule(
      'amount_threshold',
      { thresholdMinor: '1' },
      {
        effectiveFrom: new Date(ctx.clock.now().getTime() - HOUR),
      }
    );
    const m = await activeMerchant(ctx, 'dates');
    const outcome = await pay(m, 1_000n);
    expect(outcome.alerts).toHaveLength(1);
    expect((await alertsOf(m.ref, current)).length).toBe(1);
    expect((await alertsOf(m.ref, future)).length).toBe(0);
    expect((await alertsOf(m.ref, expired)).length).toBe(0);
  });

  it('refuses rules that cannot be read, and keeps rule changes to staff with the permission', async () => {
    const bad = await staff.client.post('/admin/v1/aml/rules', {
      code: 'bad.rule',
      name: 'bad',
      ruleType: 'velocity',
      params: { currency: CUR, measure: 'count', windowSeconds: 5, max: 1 },
      severity: 'low',
      action: 'flag',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('AML_RULE_INVALID');
    const unknownKey = await staff.client.post('/admin/v1/aml/rules', {
      code: 'bad.rule2',
      name: 'bad',
      ruleType: 'amount_threshold',
      params: { currency: CUR, thresholdMinor: '10', sneaky: true },
      severity: 'low',
      action: 'flag',
    });
    expect(unknownKey.statusCode).toBe(400);
    expect(
      (await staff.client.patch('/admin/v1/aml/rules/does.not.exist', { enabled: true })).statusCode
    ).toBe(404);
    const seeded = (await staff.client.get('/admin/v1/aml/rules')).json().data.items;
    expect(seeded.map((r: { ruleType: string }) => r.ruleType)).toEqual(
      expect.arrayContaining([
        'velocity',
        'amount_threshold',
        'structuring',
        'geography',
        'new_account',
        'round_amount',
        'counterparty_reuse',
      ])
    );
    // Seeded rules ship disabled.
    expect(
      seeded.filter(
        (r: { code: string; enabled: boolean }) => !r.code.startsWith('t.') && r.enabled
      )
    ).toEqual([]);

    const operations = await staffSession(ctx, 'operations');
    expect((await operations.client.get('/admin/v1/aml/rules')).statusCode).toBe(200);
    expect(
      (
        await operations.client.patch('/admin/v1/aml/rules/velocity.count.hourly', {
          enabled: true,
        })
      ).statusCode
    ).toBe(403);
  });
});

describe('actions: flag, hold and block', () => {
  it('a hold rule holds the payment amount on the merchant balance, and releasing the alert releases it', async () => {
    const code = await makeRule(
      'amount_threshold',
      { thresholdMinor: '100000' },
      { action: 'hold' }
    );
    const m = await activeMerchant(ctx, 'hold');
    const paid = await pay(m, 120_000n);
    expect(paid.alerts).toHaveLength(1);
    const [alert] = await alertsOf(m.ref, code);
    expect(alert?.hold_id).toBeTruthy();
    const holds = await sql<{ amount_minor: string; reason: string; state: string }>(
      'select amount_minor::text, reason, state from core.holds where id = $1',
      [alert?.hold_id]
    );
    expect(holds[0]).toMatchObject({ amount_minor: '120000', state: 'active' });
    expect(holds[0]?.reason).toBe(`aml:alert:${alert?.ref}`);
    expect(await available(m)).toBe(0n);
    // Settlement counts it as an AML hold.
    const amlHolds = await sql<{ n: string }>(
      `select coalesce(sum(amount_minor), 0)::text as n from core.holds
        where merchant_id = $1 and state = 'active' and reason like 'aml:%'`,
      [m.id]
    );
    expect(amlHolds[0]?.n).toBe('120000');

    const analyst = await staffSession(ctx, 'compliance');
    const resolved = await analyst.client.post(`/admin/v1/aml/alerts/${alert?.ref}/resolve`, {
      outcome: 'closed_false_positive',
      note: 'Verified with the merchant: a one-off large sale.',
    });
    expect(resolved.statusCode).toBe(200);
    expect(await available(m)).toBe(120_000n);
    expect(resolved.json().data).toMatchObject({ status: 'closed_false_positive' });
  });

  it('holds only what is available when the balance cannot cover the payment, and says so', async () => {
    const code = await makeRule(
      'amount_threshold',
      { thresholdMinor: '100000' },
      { action: 'hold' }
    );
    const m = await activeMerchant(ctx, 'partial');
    const payment = await succeedLivePayment(ctx, m, { amountMinor: 120_000n, currency: CUR });
    // Something else already holds most of the money.
    const holds = ctx.app.get(HoldsService, { strict: false });
    await ctx.unitOfWork.run((tx) =>
      holds.place(tx, {
        merchantId: m.id,
        environment: 'live',
        currency: CUR,
        amountMinor: 100_000n,
        reason: 'manual test hold',
        idempotencyKey: `test:${randomUUID()}`,
        createdBy: 'system:test',
      })
    );
    await ctx.monitoring.monitor(payment.transactionId);
    const [alert] = await alertsOf(m.ref, code);
    const hold = await sql<{ amount_minor: string }>(
      'select amount_minor::text from core.holds where id = $1',
      [alert?.hold_id]
    );
    expect(hold[0]?.amount_minor).toBe('20000');
    const audit = await sql<{ after: { heldMinor: string; requestedMinor: string } }>(
      `select after from core.audit_logs where action = 'aml.alert.hold_placed' and resource_id = $1`,
      [alert?.ref]
    );
    expect(audit[0]?.after).toMatchObject({ heldMinor: '20000', requestedMinor: '120000' });
    expect(await available(m)).toBe(0n);
  });

  it('a block rule blocks the merchant: holds its balance, suspends payouts, reverses nothing', async () => {
    const code = await makeRule(
      'velocity',
      { measure: 'count', windowSeconds: 3600, max: 1 },
      { action: 'block', severity: 'high' }
    );
    const m = await activeMerchant(ctx, 'block');
    await pay(m, 40_000n);
    const before = await snapshotOf(m);
    const second = await pay(m, 60_000n);
    expect(second.alerts).toHaveLength(1);
    expect(second.result).toBe('monitored');

    const blocks = await sql<{
      ref: string;
      status: string;
      source: string;
      alert_id: string;
      created_by: string;
    }>(
      'select ref, status, source, alert_id::text, created_by from core.aml_blocks where merchant_id = $1',
      [m.id]
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ status: 'active', source: 'rule', created_by: 'system:aml' });
    expect(blocks[0]?.alert_id).toBeTruthy();
    expect(await ctx.payoutControl.isSuspended(m.id)).toBe(true);
    expect(await available(m)).toBe(0n);
    const held = await sql<{ amount_minor: string; reason: string }>(
      'select amount_minor::text, reason from core.holds where merchant_id = $1 and state = $2',
      [m.id, 'active']
    );
    expect(held).toEqual([{ amount_minor: '100000', reason: `aml:block:${blocks[0]?.ref}` }]);

    // Completed transactions and their ledger entries are exactly as they were.
    const after = await snapshotOf(m);
    for (const earlier of before.transactions) {
      expect(after.transactions).toContainEqual(earlier);
    }
    expect(after.transactions.every((t) => t.status === 'succeeded')).toBe(true);
    expect(after.postedMinor).toBe(100_000n);
    expect(after.entries).toBe(before.entries + 1); // only the second payment's own posting
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [blocks[0]?.ref]
    );
    expect(audit.map((a) => a.action)).toEqual(['aml.merchant.blocked']);
    expect((await alertsOf(m.ref, code))[0]?.action).toBe('block');
  });
});

async function snapshotOf(m: TestMerchant) {
  const transactions = await sql<{ ref: string; status: string; amount_minor: string }>(
    'select ref, status, amount_minor::text from core.transactions where merchant_id = $1 order by created_at, ref',
    [m.id]
  );
  const [entries] = await sql<{ n: string }>(
    'select count(*)::text as n from core.journal_entries where merchant_id = $1',
    [m.id]
  );
  const balance = await ctx.balances.merchantBalance(m.id, 'live', CUR);
  return { transactions, entries: Number(entries?.n), postedMinor: balance.postedMinor };
}

describe('alerts: severity, due date, SLA, assignment, escalation', () => {
  it('sets due_at from the severity and escalates an unworked alert once, when the SLA passes', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '1000' }, { severity: 'critical' });
    await makeRule('amount_threshold', { thresholdMinor: '1000' }, { severity: 'low' });
    const m = await activeMerchant(ctx, 'sla');
    await pay(m, 5_000n);
    const alerts = await alertsOf(m.ref);
    expect(alerts).toHaveLength(2);
    const byHours = new Map(
      alerts.map((a) => [a.severity, (a.due_at.getTime() - ctx.clock.now().getTime()) / HOUR])
    );
    expect(Math.round(byHours.get('critical') ?? 0)).toBe(4);
    expect(Math.round(byHours.get('low') ?? 0)).toBe(72);

    // Nothing of this merchant's is overdue yet.
    await ctx.alerts.sweepOverdue();
    expect((await alertsOf(m.ref)).map((a) => a.status)).toEqual(['open', 'open']);
    // Five hours on, the critical alert is past its SLA; the low one is not.
    ctx.clock.advanceBy(5 * HOUR);
    const fresh = await staffSession(ctx, 'compliance');
    const overdue = await fresh.client.get(`/admin/v1/aml/alerts?merchant=${m.ref}&overdue=true`);
    expect(overdue.json().data.items.map((a: { severity: string }) => a.severity)).toEqual([
      'critical',
    ]);
    expect(overdue.json().data.items[0].overdue).toBe(true);

    const swept = await ctx.alerts.sweepOverdue();
    expect(swept.escalated).toBeGreaterThanOrEqual(1);
    expect((await ctx.alerts.sweepOverdue()).escalated).toBe(0);
    const after = await alertsOf(m.ref);
    expect(after.find((a) => a.severity === 'critical')?.status).toBe('escalated');
    expect(after.find((a) => a.severity === 'low')?.status).toBe('open');
    const [row] = await sql<{ escalation_reason: string; escalated_at: Date }>(
      `select escalation_reason, escalated_at from core.aml_alerts where ref = $1`,
      [after.find((a) => a.severity === 'critical')?.ref]
    );
    expect(row?.escalation_reason).toBe('sla_breach');
    const audit = await sql<{ action: string; actor_type: string }>(
      `select action, actor_type from core.audit_logs where resource_id = $1 and outcome = 'success' order by seq`,
      [after.find((a) => a.severity === 'critical')?.ref]
    );
    expect(audit.map((a) => [a.action, a.actor_type])).toEqual([
      ['aml.alert.raised', 'job'],
      ['aml.alert.sla_breached', 'job'],
    ]);
  });

  it('is worked through assignment, escalation and resolution, each audited, and is final once closed', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '1000' });
    const m = await activeMerchant(ctx, 'workflow');
    await pay(m, 5_000n);
    const admin = await staffSession(ctx, 'compliance');
    const investigator = await staffSession(ctx, 'compliance');
    const [alert] = await alertsOf(m.ref);
    const ref = alert?.ref as string;

    const detail = (await admin.client.get(`/admin/v1/aml/alerts/${ref}`)).json().data;
    expect(detail).toMatchObject({ id: ref, status: 'open', merchant: m.ref, assignedTo: null });
    expect(detail.transaction).toMatch(/^txn_/);

    const assigned = await admin.client.post(`/admin/v1/aml/alerts/${ref}/assign`, {
      assignee: investigator.admin.userId,
    });
    expect(assigned.json().data).toMatchObject({
      status: 'investigating',
      assignedTo: investigator.admin.userId,
    });
    expect(
      (
        await admin.client.post(`/admin/v1/aml/alerts/${ref}/assign`, {
          assignee: 'usr_00000000000000000000000000',
        })
      ).statusCode
    ).toBe(404);

    const escalated = await admin.client.post(`/admin/v1/aml/alerts/${ref}/escalate`, {
      note: 'Needs a senior look',
    });
    expect(escalated.json().data).toMatchObject({
      status: 'escalated',
      escalationReason: 'manual',
    });
    expect(
      (await admin.client.post(`/admin/v1/aml/alerts/${ref}/escalate`, {})).json().error.code
    ).toBe('AML_TRANSITION_INVALID');

    const resolved = await admin.client.post(`/admin/v1/aml/alerts/${ref}/resolve`, {
      outcome: 'closed_confirmed',
      note: 'Pattern matches known abuse.',
    });
    expect(resolved.json().data).toMatchObject({ status: 'closed_confirmed' });
    for (const path of ['assign', 'escalate', 'resolve']) {
      const body =
        path === 'assign'
          ? { assignee: investigator.admin.userId }
          : path === 'resolve'
            ? { outcome: 'closed_false_positive', note: 'x' }
            : {};
      const again = await admin.client.post(`/admin/v1/aml/alerts/${ref}/${path}`, body);
      expect(again.statusCode, path).toBe(409);
    }
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 and outcome = 'success' order by seq`,
      [ref]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'aml.alert.raised',
      'aml.alert.assigned',
      'aml.alert.escalated',
      'aml.alert.resolved',
    ]);
    const list = (
      await admin.client.get(`/admin/v1/aml/alerts?merchant=${m.ref}&status=closed_confirmed`)
    ).json().data;
    expect(list.items).toHaveLength(1);
  });

  it('lets support see nothing and operations read only', async () => {
    const support = await staffSession(ctx, 'support_agent');
    expect((await support.client.get('/admin/v1/aml/alerts')).statusCode).toBe(403);
    expect((await support.client.get('/admin/v1/aml/cases')).statusCode).toBe(403);
    const operations = await staffSession(ctx, 'operations');
    expect((await operations.client.get('/admin/v1/aml/alerts')).statusCode).toBe(200);
    expect(
      (await operations.client.post('/admin/v1/aml/alerts/alrt_x/escalate', {})).statusCode
    ).toBe(403);
  });
});

describe('cases and the STR package', () => {
  it('aggregates alerts, carries notes and an outcome, keeps an audit history and exports an STR package', async () => {
    await makeRule('amount_threshold', { thresholdMinor: '1000' }, { severity: 'high' });
    const m = await activeMerchant(ctx, 'case');
    const p1 = await pay(m, 5_000n);
    const p2 = await pay(m, 7_000n);
    const p3 = await pay(m, 9_000n);
    const alerts = await alertsOf(m.ref);
    expect(alerts).toHaveLength(3);
    const admin = await staffSession(ctx, 'compliance');

    const opened = await admin.client.post('/admin/v1/aml/cases', {
      merchant: m.ref,
      title: 'Repeated large payments',
      summary: 'Three alerts in an hour.',
      severity: 'high',
      alerts: [alerts[0]?.ref, alerts[1]?.ref],
    });
    expect(opened.statusCode).toBe(201);
    const caseRef = opened.json().data.id as string;
    expect(opened.json().data).toMatchObject({
      status: 'open',
      merchant: m.ref,
      source: 'manual',
      outcome: null,
    });

    // An alert belongs to one case only.
    const other = await admin.client.post('/admin/v1/aml/cases', {
      merchant: m.ref,
      title: 'Duplicate',
      severity: 'low',
      alerts: [alerts[0]?.ref],
    });
    expect(other.statusCode).toBe(409);

    const worked = await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, {
      assignee: admin.admin.userId,
      note: 'Called the merchant; they could not explain the pattern.',
      addAlerts: [alerts[2]?.ref],
    });
    expect(worked.statusCode).toBe(200);
    expect(worked.json().data).toMatchObject({
      status: 'investigating',
      assignedTo: admin.admin.userId,
    });

    const detail = (await admin.client.get(`/admin/v1/aml/cases/${caseRef}`)).json().data;
    expect(detail.alerts).toHaveLength(3);
    expect(detail.alerts.every((a: { case: string }) => a.case === caseRef)).toBe(true);
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes[0].body).toContain('could not explain');
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining([
        'aml.case.opened',
        'aml.case.note_added',
        'aml.case.alerts_attached',
        'aml.case.updated',
      ])
    );

    // The audit row for a note carries the note's length, not its text.
    const noteAudit = await sql<{ after: Record<string, unknown> }>(
      `select after from core.audit_logs where resource_id = $1 and action = 'aml.case.note_added'`,
      [caseRef]
    );
    expect(JSON.stringify(noteAudit)).not.toContain('could not explain');

    // STR export.
    const str = await admin.client.post(`/admin/v1/aml/cases/${caseRef}/str`, {});
    expect(str.statusCode).toBe(201);
    const pkg = str.json().data;
    expect(pkg).toMatchObject({ alertCount: 3 });
    const download = await request(pkg.downloadUrl);
    expect(download.statusCode).toBe(200);
    const bytes = Buffer.from(await download.body.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pkg.sha256);
    expect(bytes.length).toBe(pkg.sizeBytes);
    const content = JSON.parse(bytes.toString('utf8')) as {
      schema: string;
      case: { ref: string; title: string };
      merchant: { ref: string; legalName: string };
      alerts: Array<{ rule: string; transaction: string; details: Record<string, unknown> }>;
      transactions: Array<{ ref: string; amountMinor: string; status: string }>;
      notes: Array<{ body: string }>;
    };
    expect(content.schema).toBe('mulapay.str/1');
    expect(content.case).toMatchObject({ ref: caseRef, title: 'Repeated large payments' });
    expect(content.merchant.ref).toBe(m.ref);
    expect(content.alerts).toHaveLength(3);
    expect(content.transactions.map((t) => t.amountMinor).sort()).toEqual(['5000', '7000', '9000']);
    expect(content.transactions.every((t) => t.status === 'succeeded')).toBe(true);
    expect(content.notes[0]?.body).toContain('could not explain');
    // Internal ids never appear in the package.
    for (const id of [p1.transactionId, p2.transactionId, p3.transactionId, m.id]) {
      expect(bytes.toString('utf8')).not.toContain(id);
    }
    // It is stored in the reports bucket, encrypted at rest, and the row records its hash.
    const stored = [...ctx.s3.objects.entries()].find(([key]) =>
      key.startsWith(`${FAKE_S3.reports}/str/${caseRef}/`)
    );
    expect(stored?.[1].body.equals(bytes)).toBe(true);
    expect(stored?.[1].encryption).toBe('AES256');
    const strAudit = await sql<{ after: { sha256: string } }>(
      `select after from core.audit_logs where resource_id = $1 and action = 'aml.case.str_generated'`,
      [caseRef]
    );
    expect(strAudit[0]?.after.sha256).toBe(pkg.sha256);
    // Each export is its own numbered package.
    const second = await admin.client.post(`/admin/v1/aml/cases/${caseRef}/str`, {});
    expect(second.json().data.id).not.toBe(pkg.id);

    // Closing needs an outcome; the filing is recorded once; a closed case is final.
    expect(
      (await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, { status: 'closed' })).statusCode
    ).toBe(409);
    const closed = await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, {
      status: 'closed',
      outcome: 'suspicious_activity_reported',
    });
    expect(closed.json().data).toMatchObject({
      status: 'closed',
      outcome: 'suspicious_activity_reported',
    });
    const filed = await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, {
      strReference: 'FIA-2025-000123',
    });
    expect(filed.json().data).toMatchObject({ strReference: 'FIA-2025-000123' });
    expect(
      (await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, { strReference: 'again' }))
        .statusCode
    ).toBe(409);
    expect(
      (await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, { title: 'new title' }))
        .statusCode
    ).toBe(409);
    expect(
      (await admin.client.patch(`/admin/v1/aml/cases/${caseRef}`, { note: 'late note' })).statusCode
    ).toBe(200);
    const listed = (await admin.client.get(`/admin/v1/aml/cases?merchant=${m.ref}`)).json().data
      .items;
    expect(listed).toHaveLength(1);
    const history = (await admin.client.get(`/admin/v1/aml/cases/${caseRef}`))
      .json()
      .data.history.map((h: { action: string }) => h.action);
    expect(history).toEqual(
      expect.arrayContaining(['aml.case.closed', 'aml.case.str_recorded', 'aml.case.str_generated'])
    );
  });

  it('keeps STR export to staff with the permission and fails clearly when storage is down', async () => {
    const m = await activeMerchant(ctx, 'str-denied');
    const admin = await staffSession(ctx, 'compliance');
    const opened = await admin.client.post('/admin/v1/aml/cases', {
      merchant: m.ref,
      title: 'Manual case',
      severity: 'low',
    });
    const caseRef = opened.json().data.id as string;
    const operations = await staffSession(ctx, 'operations');
    expect(
      (await operations.client.post(`/admin/v1/aml/cases/${caseRef}/str`, {})).statusCode
    ).toBe(403);
    ctx.s3.failWith = 503;
    try {
      const down = await admin.client.post(`/admin/v1/aml/cases/${caseRef}/str`, {});
      expect(down.statusCode).toBe(503);
    } finally {
      ctx.s3.failWith = null;
    }
    const rows = await sql(
      'select 1 from core.aml_str_packages p join core.aml_cases c on c.id = p.case_id where c.ref = $1',
      [caseRef]
    );
    expect(rows).toHaveLength(0);
    expect(await errorCodeOf(ctx.str.generate('case_00000000000000000000000000', staffUuid))).toBe(
      'NOT_FOUND'
    );
  });
});
