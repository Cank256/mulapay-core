/**
 * Operations (spec 6.14, 11): maintenance mode, feature flags, providers, routing rules, the
 * consumer cursor, queues, stuck transactions, the suspense balance, the approvals workflow, and
 * the automatic incident monitors. Runs on the isolated database: it changes platform-wide
 * state and reads every transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { QueueProcessor } from '../../src/common/queue/queue-processor';
import { QUEUES } from '../../src/common/queue/queue.definitions';
import { WorkerHost } from '../../src/common/queue/worker-host';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { loginMerchantUser, staffSession } from '../support/identity';
import pino from 'pino';
import {
  createPayment,
  createTestMerchant,
  postPayment,
  toProcessing,
  type TestMerchant,
} from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';
import { testConfig } from '../support/test-env';

interface AuditRow {
  action: string;
  outcome: string;
  after: Record<string, unknown> | null;
  actor_id: string | null;
}

let ctx: SupportContext;
let merchant: TestMerchant;

beforeAll(async () => {
  ctx = await startSupportContext({
    isolated: true,
    overrides: {
      OPS_FLAG_CHANGE_APPROVAL: 'always',
      OPS_QUEUE_DEPTH_THRESHOLD: '3',
      OPS_QUEUE_DEPTH_SUSTAIN_SECONDS: '120',
      CONSUMER_LAG_ALERT_SECONDS: '60',
    },
  });
  merchant = await createTestMerchant(ctx, { label: 'ops' });
});
afterAll(async () => {
  await ctx?.close();
});

const audit = (action: string, resourceId?: string) =>
  resourceId === undefined
    ? ctx.query<AuditRow>(
        `select action, outcome, after, actor_id from core.audit_logs where action = $1 order by seq`,
        [action]
      )
    : ctx.query<AuditRow>(
        `select action, outcome, after, actor_id from core.audit_logs where action = $1 and resource_id = $2 order by seq`,
        [action, resourceId]
      );
const ops = () => staffSession(ctx, 'operations');
const boss = () => staffSession(ctx, 'super_admin');

describe('maintenance mode', () => {
  it('refuses writes with 503 and Retry-After on every surface, keeps reads, and audits both switches', async () => {
    const a = await ops();
    const reader = await boss();
    const before = await merchant.owner.client.post('/dashboard/v1/complaints', {
      category: 'other',
      subject: 'before',
      description: 'd',
    });
    expect(before.statusCode).toBe(201);

    const on = await a.client.post('/admin/v1/ops/maintenance-mode', {
      enabled: true,
      message: 'Upgrading the ledger',
      retryAfterSeconds: 45,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().data).toMatchObject({
      enabled: true,
      retryAfterSeconds: 45,
      message: 'Upgrading the ledger',
    });

    // Dashboard, public API and admin writes: all refused, with the standard error.
    const writes = [
      await merchant.owner.client.post('/dashboard/v1/complaints', {
        category: 'other',
        subject: 'x',
        description: 'd',
      }),
      await postPayment(merchant.test),
      await reader.client.post('/admin/v1/ops/feature-flags', {
        key: 'blocked.flag',
        description: 'x',
      }),
    ];
    for (const res of writes) {
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('45');
      expect(res.json().error.code).toBe('MAINTENANCE_MODE');
    }
    // Nothing was written, and the refusal is not audited as a denied action.
    expect(
      await ctx.query(
        `select 1 from core.complaints where subject = 'x' and merchant_id = (select id from core.merchants where ref = $1)`,
        [merchant.ref]
      )
    ).toEqual([]);

    // Reads, signing in and turning it off still work.
    expect((await merchant.owner.client.get('/dashboard/v1/complaints')).statusCode).toBe(200);
    expect((await merchant.test.get('/v1/ping')).statusCode).toBe(200);
    expect((await reader.client.get('/admin/v1/ops/overview')).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(200);
    const login = await staffSession(ctx, 'operations');
    expect((await login.client.get('/admin/v1/ops/maintenance-mode')).json().data.enabled).toBe(
      true
    );

    const off = await a.client.post('/admin/v1/ops/maintenance-mode', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({ enabled: false, message: null });
    const after = await merchant.owner.client.post('/dashboard/v1/complaints', {
      category: 'other',
      subject: 'after',
      description: 'd',
    });
    expect(after.statusCode).toBe(201);

    const enabled = await audit('maintenance.enabled');
    const disabled = await audit('maintenance.disabled');
    expect(enabled).toHaveLength(1);
    expect(disabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ outcome: 'success', actor_id: a.admin.userId });
    expect(enabled[0]?.after).toMatchObject({ enabled: true, retryAfterSeconds: 45 });
    // Staff are told, on the channels that cannot be switched off.
    const told = await ctx.query(
      `select 1 from core.notifications where template_code = 'maintenance.changed' and recipient_id = (select id from core.users where ref = $1)`,
      [reader.admin.userId]
    );
    expect(told.length).toBeGreaterThanOrEqual(2);
  });

  it('needs ops:manage and a recent step-up', async () => {
    const auditor = await staffSession(ctx, 'auditor');
    expect(
      (await auditor.client.post('/admin/v1/ops/maintenance-mode', { enabled: true })).statusCode
    ).toBe(403);
    expect((await auditor.client.get('/admin/v1/ops/maintenance-mode')).statusCode).toBe(200);
    const stale = await ops();
    ctx.clock.advanceBy(6 * 60_000);
    const refused = await stale.client.post('/admin/v1/ops/maintenance-mode', { enabled: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/admin/v1/ops/maintenance-mode',
          payload: { enabled: true },
        })
      ).statusCode
    ).toBe(401);
    expect((await ctx.maintenance.status()).enabled).toBe(false);
  });
});

describe('approvals and feature flags', () => {
  it('turns a flag change into an approval request that changes nothing until a second person agrees', async () => {
    const maker = await ops();
    const checker = await boss();
    const created = await maker.client.post('/admin/v1/ops/feature-flags', {
      key: 'new.checkout',
      description: 'The new checkout',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ key: 'new.checkout', enabled: false });

    const noReason = await maker.client.patch('/admin/v1/ops/feature-flags/new.checkout', {
      enabled: true,
    });
    expect(noReason.statusCode).toBe(422);
    const request = await maker.client.patch('/admin/v1/ops/feature-flags/new.checkout', {
      enabled: true,
      rolloutPercent: 50,
      reason: 'Start the rollout',
    });
    expect(request.statusCode).toBe(202);
    const approval = request.json().data.approval;
    expect(approval).toMatchObject({
      kind: 'feature_flag.change',
      status: 'pending',
      resourceId: 'new.checkout',
      requestedBy: maker.admin.userId,
    });
    expect((await ctx.flags.get('new.checkout')).enabled).toBe(false);

    // Asking again is the same request, not a second one.
    const again = await maker.client.patch('/admin/v1/ops/feature-flags/new.checkout', {
      enabled: true,
      rolloutPercent: 50,
      reason: 'Start the rollout',
    });
    expect(again.json().data.approval.id).toBe(approval.id);

    // The requester cannot decide it; a person without ops:approve cannot either.
    const self = await maker.client.post(`/admin/v1/ops/approvals/${approval.id}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('APPROVAL_SELF_DECISION');
    const reader = await staffSession(ctx, 'auditor');
    expect(
      (await reader.client.post(`/admin/v1/ops/approvals/${approval.id}/approve`, {})).statusCode
    ).toBe(403);
    expect((await ctx.flags.get('new.checkout')).enabled).toBe(false);

    // It is in the inbox, and the other approvers were told.
    const inbox = await checker.client.get('/admin/v1/ops/approvals?status=pending');
    expect(inbox.json().data.items.map((i: { id: string }) => i.id)).toContain(approval.id);
    const asked = await ctx.query(
      `select 1 from core.notifications where template_code = 'approval.requested' and resource_key = $1 and recipient_id = (select id from core.users where ref = $2)`,
      [approval.id, checker.admin.userId]
    );
    expect(asked.length).toBeGreaterThanOrEqual(1);

    const approved = await checker.client.post(`/admin/v1/ops/approvals/${approval.id}/approve`, {
      note: 'Go',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({ status: 'approved' });
    expect(approved.json().data.decisions).toEqual([
      expect.objectContaining({ approver: checker.admin.userId, decision: 'approve', note: 'Go' }),
    ]);
    expect(await ctx.flags.get('new.checkout')).toMatchObject({
      enabled: true,
      rolloutPercent: 50,
    });
    const changed = await audit('feature_flag.changed', 'new.checkout');
    // (The first row is the refused request without a reason, audited as an error.)
    expect(changed.find((r) => r.outcome === 'success')?.after).toMatchObject({
      enabled: true,
      via: `approval:${approval.id}`,
    });
    expect(
      (await audit('approval.approved', approval.id)).find((r) => r.outcome === 'success')
    ).toMatchObject({ actor_id: checker.admin.userId });

    // A decided approval is final.
    expect(
      (await checker.client.post(`/admin/v1/ops/approvals/${approval.id}/approve`, {})).statusCode
    ).toBe(409);
    await expect(
      ctx.query(`update core.approvals set status = 'pending' where ref = $1`, [approval.id])
    ).rejects.toThrow(/final/);
  });

  it('changes nothing on a rejection, and expires a request nobody decides', async () => {
    const maker = await ops();
    const checker = await boss();
    await maker.client.post('/admin/v1/ops/feature-flags', {
      key: 'risky.thing',
      description: 'Risky',
    });
    const req = (
      await maker.client.patch('/admin/v1/ops/feature-flags/risky.thing', {
        enabled: true,
        reason: 'Try it',
      })
    ).json().data.approval;
    const rejected = await checker.client.post(`/admin/v1/ops/approvals/${req.id}/reject`, {
      note: 'Not now',
    });
    expect(rejected.json().data.status).toBe('rejected');
    expect((await ctx.flags.get('risky.thing')).enabled).toBe(false);

    const second = (
      await maker.client.patch('/admin/v1/ops/feature-flags/risky.thing', {
        enabled: true,
        reason: 'Try again',
      })
    ).json().data.approval;
    expect(second.id).not.toBe(req.id);
    ctx.clock.advanceBy(25 * 3_600_000);
    expect(await ctx.approvals.expireOverdue()).toBeGreaterThanOrEqual(1);
    const fresh = await boss();
    const late = await fresh.client.post(`/admin/v1/ops/approvals/${second.id}/approve`, {});
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('APPROVAL_NOT_PENDING');
    expect((await ctx.flags.get('risky.thing')).enabled).toBe(false);
    expect(
      (await fresh.client.get(`/admin/v1/ops/approvals/${second.id}`)).json().data.status
    ).toBe('expired');
  });

  it('decides which merchants see a flag, deterministically', async () => {
    await ctx.query(
      `update core.feature_flags set enabled = true, rollout_percent = 0, merchant_allowlist = array[$1::uuid] where key = 'new.checkout'`,
      [merchant.id]
    );
    ctx.clock.advanceBy(31_000);
    expect(await ctx.flags.isEnabled('new.checkout', merchant.id)).toBe(true);
    expect(await ctx.flags.isEnabled('new.checkout', randomUUID())).toBe(false);
    expect(await ctx.flags.isEnabled('no.such.flag', merchant.id)).toBe(false);
    await ctx.query(`update core.feature_flags set enabled = false where key = 'new.checkout'`);
    // The answer is cached for 30 seconds.
    expect(await ctx.flags.isEnabled('new.checkout', merchant.id)).toBe(true);
    ctx.clock.advanceBy(31_000);
    expect(await ctx.flags.isEnabled('new.checkout', merchant.id)).toBe(false);
  });
});

describe('providers and routing rules', () => {
  it('disables an unrouted provider at once, and re-enables it', async () => {
    const a = await ops();
    const off = await a.client.patch('/admin/v1/providers/flutterwave', {
      enabled: false,
      note: 'Provider maintenance',
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({
      provider: 'flutterwave',
      enabled: false,
      note: 'Provider maintenance',
    });
    const on = await a.client.patch('/admin/v1/providers/flutterwave', { enabled: true });
    expect(on.json().data.enabled).toBe(true);
    expect(await audit('provider.disabled', 'flutterwave')).toHaveLength(1);
    expect(
      (await a.client.get('/admin/v1/providers'))
        .json()
        .data.items.map((p: { provider: string }) => p.provider)
    ).toEqual(['airtel', 'flutterwave', 'mtn']);
    const denied = await staffSession(ctx, 'support_agent');
    expect(
      (await denied.client.patch('/admin/v1/providers/mtn', { enabled: false })).statusCode
    ).toBe(403);
    expect(
      (await a.client.patch('/admin/v1/providers/stripe', { enabled: false })).statusCode
    ).toBe(400);
  });

  it('validates routing rules and protects the last route of a currency', async () => {
    const a = await ops();
    const boss1 = await boss();
    const base = { priority: 10, currency: 'UGX', provider: 'mtn' };
    const created = await a.client.post('/admin/v1/routing-rules', base);
    expect(created.statusCode).toBe(201);
    const rule = created.json().data;
    expect(rule).toMatchObject({
      currency: 'UGX',
      provider: 'mtn',
      weight: 100,
      enabled: true,
      country: '*',
    });

    // Unsafe or invalid configurations are refused.
    const unsupported = await a.client.post('/admin/v1/routing-rules', {
      priority: 1,
      currency: 'KES',
      provider: 'mtn',
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().error).toMatchObject({
      code: 'UNSAFE_CONFIGURATION',
      details: { reason: 'provider_unsupported_currency' },
    });
    const duplicate = await a.client.post('/admin/v1/routing-rules', base);
    expect(duplicate.json().error.details.reason).toBe('duplicate_rule');
    const range = await a.client.post('/admin/v1/routing-rules', {
      ...base,
      priority: 11,
      minAmountMinor: '500',
      maxAmountMinor: '100',
    });
    expect(range.statusCode).toBe(400);
    expect(
      (
        await a.client.post('/admin/v1/routing-rules', {
          ...base,
          priority: 11,
          msisdnPrefix: '0700',
        })
      ).statusCode
    ).toBe(400);

    // A rule for a disabled provider is unsafe; a second route lets the first be disabled directly.
    await a.client.patch('/admin/v1/providers/airtel', { enabled: false });
    const toDisabled = await a.client.post('/admin/v1/routing-rules', {
      priority: 20,
      currency: 'UGX',
      provider: 'airtel',
    });
    expect(toDisabled.json().error.details.reason).toBe('provider_disabled');
    await a.client.patch('/admin/v1/providers/airtel', { enabled: true });
    const second = (
      await a.client.post('/admin/v1/routing-rules', {
        priority: 20,
        currency: 'UGX',
        provider: 'airtel',
      })
    ).json().data;
    const tuned = await a.client.patch(`/admin/v1/routing-rules/${second.id}`, {
      weight: 250,
      priority: 15,
    });
    expect(tuned.json().data).toMatchObject({ weight: 250, priority: 15 });
    const disabled = await a.client.patch(`/admin/v1/routing-rules/${second.id}`, {
      enabled: false,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data.enabled).toBe(false);
    await a.client.patch(`/admin/v1/routing-rules/${second.id}`, { enabled: true });

    // Taking the provider out when it carries a currency that has no other route needs approval.
    const solo = (
      await a.client.post('/admin/v1/routing-rules', {
        priority: 5,
        currency: 'GHS',
        provider: 'mtn',
      })
    ).json().data;
    const unsafe = await a.client.patch('/admin/v1/providers/mtn', { enabled: false });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json().error.details).toMatchObject({
      reason: 'approval_needs_a_reason',
      uncoveredCurrencies: ['GHS'],
    });
    const pending = await a.client.patch('/admin/v1/providers/mtn', {
      health: 'down',
      reason: 'Provider outage, GHS has no other route',
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().data.approval.payload).toMatchObject({
      provider: 'mtn',
      health: 'down',
      uncoveredCurrencies: ['GHS'],
    });
    expect((await ctx.providers.get('mtn')).row.health).toBe('healthy');
    const ok = await boss1.client.post(
      `/admin/v1/ops/approvals/${pending.json().data.approval.id}/approve`,
      {}
    );
    expect(ok.json().data.status).toBe('approved');
    expect(await ctx.providers.get('mtn')).toMatchObject({ row: { health: 'down' } });
    expect(
      (await audit('provider.disabled', 'mtn')).some((r) =>
        String(r.after?.via).startsWith('approval:')
      )
    ).toBe(true);
    await a.client.patch('/admin/v1/providers/mtn', { health: 'healthy' });

    // The last enabled rule of a currency cannot be disabled directly; deleting never is.
    const last = await a.client.patch(`/admin/v1/routing-rules/${solo.id}`, { enabled: false });
    expect(last.statusCode).toBe(409);
    const asked = await a.client.patch(`/admin/v1/routing-rules/${solo.id}`, {
      enabled: false,
      reason: 'Retire GHS',
    });
    expect(asked.statusCode).toBe(202);
    const removal = await a.client.delete(`/admin/v1/routing-rules/${rule.id}`, {
      reason: 'Replace it',
    });
    expect(removal.statusCode).toBe(202);
    expect((await ctx.routing.get(rule.id)).ref).toBe(rule.id);
    const done = await boss1.client.post(
      `/admin/v1/ops/approvals/${removal.json().data.approval.id}/approve`,
      {}
    );
    expect(done.statusCode).toBe(200);
    expect((await a.client.get(`/admin/v1/routing-rules/${rule.id}`)).statusCode).toBe(404);
    expect(await audit('routing_rule.deleted', rule.id)).toHaveLength(1);
    const asLedger = await a.client.get('/admin/v1/routing-rules?currency=UGX');
    expect(asLedger.json().data.items.map((r: { id: string }) => r.id)).toEqual([second.id]);
  });

  it('reads the provider balance through the gateway and says when it cannot', async () => {
    const a = await ops();
    const unsupported = await a.client.get('/admin/v1/providers/mtn/balance?currency=KES');
    expect(unsupported.statusCode).toBe(422);
    const down = await a.client.get('/admin/v1/providers/mtn/balance?currency=UGX');
    expect(down.statusCode).toBe(503);
    (ctx.providers as unknown as { gateway: unknown }).gateway = {
      getBalance: async () => ({ kind: 'ok', availableMinor: 12_500n, currency: 'UGX' }),
    };
    const ok = await a.client.get(
      '/admin/v1/providers/mtn/balance?currency=UGX&accountType=disbursement'
    );
    expect(ok.json().data).toEqual({
      provider: 'mtn',
      accountType: 'disbursement',
      currency: 'UGX',
      availableMinor: '12500',
    });
  });
});

describe('the consumer cursor', () => {
  it('shows position, heartbeat and lag, and rewinds only with approval', async () => {
    const a = await ops();
    const checker = await boss();
    const old = new Date(ctx.clock.now().getTime() - 5 * 60_000).toISOString();
    for (let i = 0; i < 3; i++) {
      await ctx.query(
        `insert into public.operation_events (event_id, operation_id, tenant_id, provider_id, operation_type, external_id, status, amount, currency, source, occurred_at)
         values ($1, $2, 'core', 'mtn', 'collection', $3, 'successful', 1000, 'UGX', 'callback', $4)`,
        [randomUUID(), randomUUID(), `pay_${randomUUID()}`, old]
      );
    }
    await ctx.query(
      `update core.consumer_cursors set position = 0, heartbeat_at = null where name = 'gateway'`
    );
    const list = await a.client.get('/admin/v1/ops/consumer-cursors');
    const cursor = list.json().data.items.find((c: { name: string }) => c.name === 'gateway');
    expect(cursor).toMatchObject({
      position: '0',
      status: 'never_started',
      eventsBehind: '3',
      lagAlert: true,
    });
    expect(cursor.lagSeconds).toBeGreaterThanOrEqual(300);

    await ctx.query(
      `update core.consumer_cursors set position = (select max(id) from public.operation_events), heartbeat_at = now() where name = 'gateway'`
    );
    const caughtUp = (await a.client.get('/admin/v1/ops/consumer-cursors')).json().data.items[0];
    expect(caughtUp).toMatchObject({ eventsBehind: '0', lagSeconds: 0, lagAlert: false });

    const head = BigInt(caughtUp.position);
    const notBack = await a.client.post('/admin/v1/ops/consumer-cursors/gateway/rewind', {
      position: head.toString(),
      reason: 'noop',
    });
    expect(notBack.statusCode).toBe(422);
    expect(notBack.json().error.details.reason).toBe('not_a_rewind');
    expect(
      (
        await a.client.post('/admin/v1/ops/consumer-cursors/nope/rewind', {
          position: '1',
          reason: 'x',
        })
      ).statusCode
    ).toBe(404);

    const to = (head - 2n).toString();
    const request = await a.client.post('/admin/v1/ops/consumer-cursors/gateway/rewind', {
      position: to,
      reason: 'Re-read after a bad deploy',
    });
    expect(request.statusCode).toBe(202);
    expect(request.json().data.approvalRequired).toBe(true);
    const id = request.json().data.approval.id;
    expect((await ctx.cursors.list())[0]?.position).toBe(head);
    expect((await a.client.post(`/admin/v1/ops/approvals/${id}/approve`, {})).statusCode).toBe(403);
    const approved = await checker.client.post(`/admin/v1/ops/approvals/${id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    const after = (await ctx.cursors.list())[0];
    expect(after?.position).toBe(head - 2n);
    expect(after?.eventsBehind).toBe(2n);
    expect((await audit('consumer_cursor.rewound', 'gateway'))[0]?.after).toMatchObject({
      position: to,
    });
    expect((await audit('consumer_cursor.rewind_requested')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('queues', () => {
  it('lists depth and age, pauses and resumes, and retries failed jobs', async () => {
    const a = await ops();
    const definition = QUEUES.supportOps;
    const handler = vi
      .fn<(job: Job) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    const processor: QueueProcessor = { definition: { ...definition }, process: handler };
    const host = new WorkerHost(
      testConfig({ QUEUE_PREFIX: ctx.config.QUEUE_PREFIX, REDIS_URL: ctx.config.REDIS_URL }),
      pino({ level: 'silent' }),
      ctx.clock,
      [processor],
      ctx.queues
    );
    await host.onApplicationBootstrap();
    try {
      const queue = ctx.queues.get(definition.name);
      await queue.add('work', { n: 1 }, { attempts: 1 });
      await vi.waitFor(async () => expect((await queue.getJobCounts('failed')).failed).toBe(1), {
        timeout: 10_000,
      });

      const list = await a.client.get('/admin/v1/ops/queues');
      const row = list.json().data.items.find((q: { name: string }) => q.name === 'support-ops');
      expect(row).toMatchObject({ failed: 1, paused: false });
      expect(list.json().data.items.map((q: { name: string }) => q.name)).toEqual(
        expect.arrayContaining([
          'outbox-dispatch',
          'notification-send',
          'report-generate',
          'dead-letter',
        ])
      );

      const retried = await a.client.post('/admin/v1/ops/queues/support-ops/retry-failed', {
        limit: 10,
      });
      expect(retried.json().data).toEqual({ retried: 1 });
      await vi.waitFor(async () => expect((await queue.getJobCounts('failed')).failed).toBe(0), {
        timeout: 10_000,
      });
      expect(handler).toHaveBeenCalledTimes(2);

      expect(
        (await a.client.post('/admin/v1/ops/queues/support-ops/pause', {})).json().data.paused
      ).toBe(true);
      expect((await ctx.queueOps.view('support-ops', ctx.clock.now())).paused).toBe(true);
      expect(
        (await a.client.post('/admin/v1/ops/queues/support-ops/resume', {})).json().data.paused
      ).toBe(false);
    } finally {
      await host.onApplicationShutdown();
    }
    const denied = await a.client.post('/admin/v1/ops/queues/dead-letter/pause', {});
    expect(denied.statusCode).toBe(422);
    expect((await a.client.post('/admin/v1/ops/queues/nope/pause', {})).statusCode).toBe(404);
    const reader = await staffSession(ctx, 'auditor');
    expect(
      (await reader.client.post('/admin/v1/ops/queues/support-ops/pause', {})).statusCode
    ).toBe(403);
    const actions =
      (await audit('queue.paused', 'support-ops')).length +
      (await audit('queue.failed_retried', 'support-ops')).length;
    expect(actions).toBe(2);
  });
});

describe('stuck transactions, suspense and the overview', () => {
  it('lists transactions processing past the threshold, oldest first', async () => {
    const created = await createPayment(merchant.test, { amountMinor: '7000', currency: 'UGX' });
    const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('test'), created.id);
    await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'mtn' } });
    const a = await ops();
    const none = await a.client.get('/admin/v1/ops/stuck-transactions');
    expect(
      none.json().data.items.filter((s: { merchant: string }) => s.merchant === merchant.ref)
    ).toEqual([]);

    ctx.clock.advanceBy(20 * 60_000);
    const fresh = await ops();
    const stuck = await fresh.client.get('/admin/v1/ops/stuck-transactions');
    expect(stuck.statusCode).toBe(200);
    const item = stuck
      .json()
      .data.items.find((s: { merchant: string }) => s.merchant === merchant.ref);
    expect(item).toMatchObject({
      type: 'payment',
      provider: 'mtn',
      amountMinor: '7000',
      currency: 'UGX',
      environment: 'test',
    });
    expect(item.ageMinutes).toBeGreaterThanOrEqual(20);
    const older = await fresh.client.get('/admin/v1/ops/stuck-transactions?olderThanMinutes=600');
    expect(
      older.json().data.items.filter((s: { merchant: string }) => s.merchant === merchant.ref)
    ).toEqual([]);
    const overview = await fresh.client.get('/admin/v1/ops/overview');
    expect(overview.json().data.stuckTransactions.count).toBeGreaterThanOrEqual(1);
  });

  it('shows a non-zero suspense balance and the overview built from the rollups', async () => {
    const accounts = ctx.app.get(AccountsService, { strict: false });
    const bank = (
      await ctx.unitOfWork.run((tx) =>
        accounts.openBankAccount(tx, {
          environment: 'test',
          bankKey: `ops${randomUUID().slice(0, 6)}`,
          name: 'Ops bank',
          currency: 'MWK',
        })
      )
    ).code;
    await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', `ops-suspense-${randomUUID()}`),
        environment: 'test',
        currency: 'MWK',
        source: 'adjustment',
        sourceId: `ops-suspense-${randomUUID()}`,
        description: 'unidentified money',
        lines: [
          { accountCode: '9000:suspense', direction: 'debit', amountMinor: 900n },
          { accountCode: bank, direction: 'credit', amountMinor: 900n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    const a = await ops();
    const res = await a.client.get('/admin/v1/ops/suspense');
    expect(res.json().data.items).toEqual(
      expect.arrayContaining([{ environment: 'test', currency: 'MWK', balanceMinor: '900' }])
    );
    const overview = await a.client.get('/admin/v1/ops/overview');
    expect(overview.json().data.suspense).toEqual(
      expect.arrayContaining([{ environment: 'test', currency: 'MWK', balanceMinor: '900' }])
    );
    expect(overview.json().data.providers).toHaveLength(3);
    expect(overview.json().data.today.day).toBe(ctx.clock.now().toISOString().slice(0, 10));
  });
});

describe('the automatic incident monitors', () => {
  const incident = (key: string) =>
    ctx.query<{
      ref: string;
      severity: string;
      status: string;
      detection_count: number;
      source: string;
      public: boolean;
    }>(
      `select ref, severity, status, detection_count, source, public from core.incidents where dedupe_key = $1 and status <> 'resolved' order by created_at desc`,
      [key]
    );

  it('opens one stuck-transaction incident, deduplicates it, raises it with age, and notes recovery', async () => {
    // The payment above has been processing for 20 minutes: past the 15 minute threshold.
    const key = 'ops:stuck_transactions';
    await ctx.query(`update core.ops_signals set active_since = null where signal_key = $1`, [key]);
    await ctx.query(
      `update core.incidents set status = 'resolved', resolved_at = now() where dedupe_key = $1 and status <> 'resolved'`,
      [key]
    );
    await ctx.monitor.evaluate();
    const [opened] = await incident(key);
    expect(opened).toMatchObject({
      severity: 'sev3',
      status: 'investigating',
      source: 'monitor',
      public: false,
      detection_count: 1,
    });

    await ctx.monitor.evaluate();
    await ctx.monitor.evaluate();
    const again = await incident(key);
    expect(again).toHaveLength(1);
    expect(again[0]?.detection_count).toBe(3);

    // An hour on, the oldest transaction is far past the sev2 threshold: raised, never duplicated.
    ctx.clock.advanceBy(60 * 60_000);
    await ctx.monitor.evaluate();
    const raised = await incident(key);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe('sev2');
    const updates = await ctx.query<{ body: string; public: boolean; author_id: string | null }>(
      `select u.body, u.public, u.author_id from core.incident_updates u join core.incidents i on i.id = u.incident_id where i.dedupe_key = $1 order by u.created_at`,
      [key]
    );
    expect(updates.some((u) => u.body.startsWith('Severity raised from sev3 to sev2'))).toBe(true);
    expect(updates.every((u) => !u.public && u.author_id === null)).toBe(true);
    expect((await audit('incident.severity_raised', raised[0]?.ref)).length).toBe(1);

    // The condition clears: the incident moves to monitoring for a person to resolve.
    // The app clock, not the database's, decides what is stuck.
    await ctx.query(`update core.transactions set initiated_at = $1 where status = 'processing'`, [
      new Date(ctx.clock.now().getTime() + 86_400_000),
    ]);
    await ctx.monitor.evaluate();
    const cleared = await incident(key);
    expect(cleared[0]).toMatchObject({ status: 'monitoring', severity: 'sev2' });
    // Never resolved by a machine.
    expect(cleared[0]?.status).not.toBe('resolved');
  });

  it('opens a suspense drift incident only after the alert hours, and raises it to sev1 after a day', async () => {
    const key = 'ops:suspense_drift:test:MWK';
    // Start from nothing: earlier monitor runs saw the same balance. No reconciliation incident covers it here.
    await ctx.query(
      `update core.incidents set status = 'resolved', resolved_at = now() where dedupe_key = $1 and status <> 'resolved'`,
      [key]
    );
    await ctx.query(`delete from core.ops_signals where signal_key = $1`, [key]);
    await ctx.monitor.evaluate();
    expect(await incident(key)).toEqual([]);
    ctx.clock.advanceBy(30 * 60_000);
    await ctx.monitor.evaluate();
    expect(await incident(key)).toEqual([]);
    ctx.clock.advanceBy(31 * 60_000);
    await ctx.monitor.evaluate();
    expect((await incident(key))[0]).toMatchObject({
      severity: 'sev2',
      source: 'monitor',
      detection_count: 1,
    });
    ctx.clock.advanceBy(24 * 3_600_000);
    await ctx.monitor.evaluate();
    const day = await incident(key);
    expect(day).toHaveLength(1);
    expect(day[0]?.severity).toBe('sev1');
  });

  it('does not open a second incident while the ledger integrity incident for the environment is open', async () => {
    const key = 'ops:suspense_drift:test:MWK';
    await ctx.query(
      `update core.incidents set status = 'resolved', resolved_at = now() where dedupe_key = $1 and status <> 'resolved'`,
      [key]
    );
    await ctx.query(
      `update core.ops_signals set active_since = now() - interval '3 days' where signal_key = $1`,
      [key]
    );
    await ctx.unitOfWork.run((tx) =>
      ctx.incidentsService.openAutomatic(tx, {
        dedupeKey: 'ledger_integrity:test:MWK',
        title: 'Ledger integrity failure (test)',
        severity: 'sev1',
        impact: 'x',
        affectedServices: ['ledger'],
        source: 'reconciliation',
      })
    );
    await ctx.monitor.evaluate();
    expect(await incident(key)).toEqual([]);
    await ctx.query(
      `update core.incidents set status = 'resolved', resolved_at = now() where dedupe_key = 'ledger_integrity:test:MWK'`
    );
  });

  it('opens a queue depth incident when a queue stays above the threshold', async () => {
    const queue = ctx.queues.get(QUEUES.gatewayChase.name);
    // No worker runs here, so jobs just wait.
    for (let i = 0; i < 5; i++) await queue.add('probe', { i }, { jobId: `probe-${randomUUID()}` });
    const key = `ops:queue_depth:${QUEUES.gatewayChase.name}`;
    await ctx.monitor.evaluate();
    expect(await incident(key)).toEqual([]);
    ctx.clock.advanceBy(121_000);
    await ctx.monitor.evaluate();
    expect((await incident(key))[0]).toMatchObject({ severity: 'sev3', source: 'monitor' });
    for (let i = 0; i < 20; i++)
      await queue.add('probe', { i }, { jobId: `probe-${randomUUID()}` });
    await ctx.monitor.evaluate();
    expect((await incident(key))[0]?.severity).toBe('sev2');
    await queue.obliterate({ force: true });
    await ctx.monitor.evaluate();
    expect((await incident(key))[0]?.status).toBe('monitoring');
  });

  it('is run by the support-ops job and is safe to run twice at once', async () => {
    const results = await Promise.all([
      ctx.supportProcessor.process({ name: 'ops.monitor', data: {} } as unknown as Job),
      ctx.supportProcessor.process({ name: 'ops.monitor', data: {} } as unknown as Job),
    ]);
    expect(results).toHaveLength(2);
    const dupes = await ctx.query<{ dedupe_key: string; n: string }>(
      `select dedupe_key, count(*)::text as n from core.incidents where dedupe_key like 'ops:%' and status <> 'resolved' group by dedupe_key having count(*) > 1`
    );
    expect(dupes).toEqual([]);
    expect(
      await ctx.supportProcessor.process({ name: 'approvals.expire', data: {} } as unknown as Job)
    ).toEqual(expect.any(Number));
    await expect(
      ctx.supportProcessor.process({ name: 'nonsense', data: {} } as unknown as Job)
    ).rejects.toThrow(/unknown/);
  });

  it('keeps the operations surface closed to merchant users', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    expect((await merchant.owner.client.get('/admin/v1/ops/overview')).statusCode).toBe(401);
    expect(
      (await merchant.owner.client.post('/admin/v1/ops/maintenance-mode', { enabled: true }))
        .statusCode
    ).toBe(401);
  });
});
