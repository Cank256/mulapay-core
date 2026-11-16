/**
 * The settlement and reconciliation HTTP surfaces (spec 7.1, 7.2, 7.3): authentication and
 * authorisation, validation, maker-checker over HTTP, the audit trail, what a merchant can and
 * cannot see, and the reconciliation queue as an operator uses it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { ReconciliationExceptionRecorder } from '../../src/modules/reconciliation/exception-recorder';
import { apiClient, createTestMerchant, sql, type TestMerchant } from '../support/payments';
import { staffSession, type StaffSession } from '../support/identity';
import {
  CURRENCY,
  setUpMerchant,
  startSettlementContext,
  succeedPayment,
  type SettledMerchant,
  type SettlementContext,
} from '../support/settlement';

let ctx: SettlementContext;
let s1: StaffSession;
let s2: StaffSession;
let ops: StaffSession;
let agent: StaffSession;

beforeAll(async () => {
  ctx = await startSettlementContext({ ACCESS_TOKEN_TTL: '3600', STEP_UP_WINDOW_SECONDS: '3600' });
  s1 = await staffSession(ctx, 'super_admin');
  s2 = await staffSession(ctx, 'super_admin');
  ops = await staffSession(ctx, 'operations');
  agent = await staffSession(ctx, 'support_agent');
});
afterAll(async () => {
  await ctx?.close();
});

const admin = '/admin/v1';

/** A cycle whose cutoff is the minute after the payments, run two minutes later. */
async function cycleFor(m: SettledMerchant) {
  ctx.clock.advanceBy(0);
  const cutoff = new Date(ctx.clock.now().getTime() + 60_000).toISOString().slice(11, 16);
  const created = await s1.client.post(`${admin}/settlement/cycles`, {
    name: `api cycle ${randomUUID()}`,
    schedule: '0 2 * * *',
    currency: CURRENCY,
    delayDays: 0,
    cutoffTime: cutoff,
    timezone: 'UTC',
    minPayoutMinor: '1000',
  });
  expect(created.statusCode).toBe(201);
  const ref = created.json().data.id as string;
  const assign = await s1.client.post(`${admin}/settlement/cycles/assign`, {
    merchant: m.merchant.ref,
    cycle: ref,
  });
  expect(assign.statusCode).toBe(200);
  ctx.clock.advanceBy(180_000);
  return ref;
}

async function draftThroughApi() {
  const m = await setUpMerchant(ctx);
  await succeedPayment(ctx, m, 600_000n, 6_000n);
  const cycle = await cycleFor(m);
  const run = await s1.client.post(`${admin}/settlement/batches`, { cycle });
  expect(run.statusCode).toBe(200);
  expect(run.json().data).toMatchObject({ outcome: 'completed', batchesCreated: 1 });
  const list = await s1.client.get(`${admin}/settlement/batches?merchant=${m.merchant.ref}`);
  const batch = list.json().data.items[0] as { id: string; status: string };
  return { m, cycle, batch };
}

describe('settlement admin routes: access', () => {
  it('requires authentication and the right permission', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: `${admin}/settlement/cycles` });
    expect(anonymous.statusCode).toBe(401);
    expect((await agent.client.get(`${admin}/settlement/cycles`)).statusCode).toBe(200);
    const body = {
      name: 'x',
      schedule: '0 2 * * *',
      currency: CURRENCY,
      delayDays: 1,
      cutoffTime: '00:00',
      timezone: 'UTC',
      minPayoutMinor: '1',
    };
    expect((await agent.client.post(`${admin}/settlement/cycles`, body)).statusCode).toBe(403);
    expect((await agent.client.get(`${admin}/reconciliation/runs`)).statusCode).toBe(403);
    // Operations can prepare and release, but only super admins approve.
    const draft = await draftThroughApi();
    expect(
      (await ops.client.post(`${admin}/settlement/batches/${draft.batch.id}/submit`, {})).statusCode
    ).toBe(200);
    expect(
      (await ops.client.post(`${admin}/settlement/batches/${draft.batch.id}/approve`, {}))
        .statusCode
    ).toBe(403);
  });

  it('refuses a merchant’s dashboard token and an API key on the admin surface', async () => {
    const m = await createTestMerchant(ctx, { active: true, label: 'notstaff' });
    expect((await m.owner.client.get(`${admin}/settlement/cycles`)).statusCode).toBe(401);
    expect((await apiClient(ctx, m.liveKey!).get(`${admin}/settlement/cycles`)).statusCode).toBe(
      401
    );
  });

  it('validates input strictly', async () => {
    const bad = await s1.client.post(`${admin}/settlement/cycles`, {
      name: 'x',
      schedule: 'not a cron',
      currency: CURRENCY,
      delayDays: 1,
      cutoffTime: '00:00',
      timezone: 'UTC',
      minPayoutMinor: '1',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('SETTLEMENT_CYCLE_INVALID');
    const unknown = await s1.client.post(`${admin}/settlement/cycles`, { name: 'x', extra: 1 });
    expect(unknown.statusCode).toBe(400);
    expect((await s1.client.post(`${admin}/settlement/batches`, {})).statusCode).toBe(400);
    expect((await s1.client.get(`${admin}/settlement/batches/stl_missing`)).statusCode).toBe(404);
    expect(
      (
        await s1.client.put(`${admin}/settlement/destinations`, {
          merchant: 'mch_x',
          currency: CURRENCY,
          provider: 'mtn',
          msisdn: '0700000000',
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await s1.client.put(`${admin}/settlement/rolling-reserve`, {
          merchant: 'mch_x',
          currency: CURRENCY,
          percentBps: 20000,
          holdDays: 1,
        })
      ).statusCode
    ).toBe(400);
  });
});

describe('settlement over HTTP: maker-checker, release, audit', () => {
  it('runs from draft to releasing, refusing the submitter as approver', async () => {
    const { m, cycle, batch } = await draftThroughApi();
    expect(batch.status).toBe('draft');

    const payables = await s1.client.get(`${admin}/settlement/payables?cycle=${cycle}`);
    expect(payables.statusCode).toBe(200);
    // Nothing is left to settle once the batch exists: its period is covered.
    expect(payables.json().data.items.map((i: { decision: string }) => i.decision)).toEqual([
      'up_to_date',
    ]);

    const detail = await s1.client.get(`${admin}/settlement/batches/${batch.id}`);
    expect(detail.json().data).toMatchObject({
      merchant: m.merchant.ref,
      cycle,
      status: 'draft',
      grossMinor: '600000',
      feeMinor: '6000',
      netMinor: '594000',
    });
    const items = await s1.client.get(`${admin}/settlement/batches/${batch.id}/items`);
    expect(items.json().data.items).toEqual([
      expect.objectContaining({ kind: 'payment', amountMinor: '600000', feeMinor: '6000' }),
    ]);

    expect(
      (await s1.client.post(`${admin}/settlement/batches/${batch.id}/approve`, {})).statusCode
    ).toBe(409);
    expect(
      (await s1.client.post(`${admin}/settlement/batches/${batch.id}/submit`, {})).json().data
        .status
    ).toBe('pending_approval');
    const self = await s1.client.post(`${admin}/settlement/batches/${batch.id}/approve`, {});
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SETTLEMENT_APPROVER_IS_SUBMITTER');
    expect(
      (await ctx.release.release(batch.id, s2.admin.userId).catch((e: Error) => e)).constructor.name
    ).toBe('AppError');
    expect(
      (await s2.client.post(`${admin}/settlement/batches/${batch.id}/approve`, {})).json().data
        .status
    ).toBe('approved');

    // Release is idempotent over HTTP, and answers with the batch releasing.
    const first = await s2.client.post(`${admin}/settlement/batches/${batch.id}/release`, {});
    const again = await s2.client.post(`${admin}/settlement/batches/${batch.id}/release`, {});
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('releasing');
    expect(again.json().data.status).toBe('releasing');
    expect(
      await sql(`select 1 from core.transactions where type = 'settlement' and merchant_id = $1`, [
        m.merchant.id,
      ])
    ).toHaveLength(1);
    expect(
      (
        await s2.client.post(`${admin}/settlement/batches/${batch.id}/cancel`, {
          reason: 'too late',
        })
      ).statusCode
    ).toBe(409);

    // The merchant's destination is shown masked and never returned in full.
    const destinations = await s1.client.get(
      `${admin}/settlement/destinations?merchant=${m.merchant.ref}`
    );
    expect(destinations.json().data.items[0]).toMatchObject({
      display: '+255••••••001',
      status: 'active',
    });
    expect(destinations.body).not.toContain('255700000001');

    // Every state change by a person is in the audit trail, in order.
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 and outcome = 'success' order by seq`,
      [batch.id]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'settlement.batch.created',
      'settlement.batch.pending_approval',
      'settlement.batch.approved',
      'settlement.batch.releasing',
    ]);
  });

  it('cancelling needs a reason and is final', async () => {
    const { batch } = await draftThroughApi();
    expect(
      (await s1.client.post(`${admin}/settlement/batches/${batch.id}/cancel`, {})).statusCode
    ).toBe(400);
    const cancelled = await s1.client.post(`${admin}/settlement/batches/${batch.id}/cancel`, {
      reason: 'wrong cycle',
    });
    expect(cancelled.json().data.status).toBe('cancelled');
    expect(
      (await s1.client.post(`${admin}/settlement/batches/${batch.id}/submit`, {})).statusCode
    ).toBe(409);
  });
});

describe('what a merchant sees of its settlements', () => {
  it('shows a settlement once submitted, with its statement and CSV, and nothing of anyone else’s', async () => {
    const { m, batch } = await draftThroughApi();
    const owner = m.merchant.owner.client;

    // A draft is internal: the merchant cannot see it.
    expect((await owner.get('/dashboard/v1/settlements')).json().data.items).toEqual([]);
    expect((await owner.get(`/dashboard/v1/settlements/${batch.id}`)).statusCode).toBe(404);

    await s1.client.post(`${admin}/settlement/batches/${batch.id}/submit`, {});
    await s2.client.post(`${admin}/settlement/batches/${batch.id}/approve`, {});
    const released = await s2.client.post(`${admin}/settlement/batches/${batch.id}/release`, {});
    const row = await ctx.batches.get(batch.id);
    expect(released.json().data.status).toBe('releasing');
    await ctx.release.submitPayout(row.id);
    await ctx.unitOfWork.run((tx) =>
      ctx.outcome.apply(tx, {
        payoutRef: row.payoutRef as string,
        eventKey: `api-${randomUUID()}`,
        signal: { kind: 'succeeded', amountMinor: row.netMinor, currency: CURRENCY },
      })
    );

    const list = await owner.get('/dashboard/v1/settlements');
    expect(list.statusCode).toBe(200);
    const view = list.json().data.items[0];
    expect(view).toMatchObject({
      id: batch.id,
      status: 'paid',
      grossMinor: '600000',
      netMinor: '594000',
      currency: CURRENCY,
    });
    expect(view.payoutTransaction).toMatch(/^txn_/);
    // Internal identifiers, the destination and gateway details never reach a merchant.
    for (const secret of [
      'merchantId',
      'destination',
      'payoutRef',
      'po_',
      'fingerprint',
      'hold',
      row.payoutRef as string,
    ]) {
      expect(list.body).not.toContain(secret);
    }

    const statement = await owner.get(`/dashboard/v1/settlements/${batch.id}/statement`);
    expect(statement.json().data).toMatchObject({
      payout: { status: 'succeeded', provider: 'airtel', destination: '+255••••••001' },
      totals: { gross_minor: '600000', net_minor: '594000' },
    });
    expect(statement.json().data.reconciliation.ledgerEntries).toEqual([]);
    const csv = await owner.get(`/dashboard/v1/settlements/${batch.id}/statement/csv`);
    expect(csv.json().data).toMatchObject({ filename: `${batch.id}.csv`, contentType: 'text/csv' });
    expect(csv.json().data.content).toContain(`"settlement","${batch.id}"`);
    expect(
      (await owner.get(`/dashboard/v1/settlements/${batch.id}/items`)).json().data.items.length
    ).toBe(1);

    // Another merchant cannot read it, and gets the same 404 as for a settlement that does not exist.
    const other = await createTestMerchant(ctx, { active: true, label: 'other' });
    const foreign = await other.owner.client.get(`/dashboard/v1/settlements/${batch.id}`);
    const missing = await other.owner.client.get('/dashboard/v1/settlements/stl_missing');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect((await other.owner.client.get('/dashboard/v1/settlements')).json().data.items).toEqual(
      []
    );
    expect(
      (await other.owner.client.get(`/dashboard/v1/settlements/${batch.id}/statement/csv`))
        .statusCode
    ).toBe(404);
  });

  it('serves the public API to a key with the settlements scope, live money only', async () => {
    const { m, batch } = await draftThroughApi();
    await s1.client.post(`${admin}/settlement/batches/${batch.id}/submit`, {});
    const issue = async (environment: 'live' | 'test', scopes: string[]) => {
      const res = await m.merchant.owner.client.post('/dashboard/v1/api-keys', {
        name: `k ${environment}`,
        environment,
        scopes,
      });
      expect(res.statusCode).toBe(201);
      return apiClient(ctx, res.json().data.key as string);
    };
    const live = await issue('live', ['settlements:read']);
    const test = await issue('test', ['settlements:read']);
    const noScope = await issue('live', ['payments:read']);

    const list = await live.get('/v1/settlements');
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items.map((i: { id: string }) => i.id)).toEqual([batch.id]);
    expect((await live.get(`/v1/settlements/${batch.id}`)).json().data).toMatchObject({
      status: 'pending_approval',
    });
    expect((await live.get(`/v1/settlements/${batch.id}/items`)).json().data.items).toHaveLength(1);
    expect((await test.get('/v1/settlements')).json().data.items).toEqual([]);
    expect((await test.get(`/v1/settlements/${batch.id}`)).statusCode).toBe(404);
    expect((await noScope.get('/v1/settlements')).statusCode).toBe(403);

    const other = await createTestMerchant(ctx, { active: true, label: 'other2' });
    const otherKey = await other.owner.client.post('/dashboard/v1/api-keys', {
      name: 'k',
      environment: 'live',
      scopes: ['settlements:read'],
    });
    const foreign = apiClient(ctx, otherKey.json().data.key as string);
    expect((await foreign.get(`/v1/settlements/${batch.id}`)).statusCode).toBe(404);
  });
});

describe('reconciliation over HTTP', () => {
  let m: TestMerchant;
  beforeAll(async () => {
    m = await createTestMerchant(ctx, { active: true, label: 'recon-http' });
  });

  async function exception(amountMinor = 800n) {
    const raised = await ctx.unitOfWork.run((tx) =>
      ctx.app.get(ReconciliationExceptionRecorder, { strict: false }).raise(tx, null, {
        kind: 'statement_unmatched_row',
        dedupeKey: `http:${randomUUID()}`,
        environment: 'live',
        currency: 'GHS',
        amountMinor,
        expected: {},
        actual: { amountMinor },
      })
    );
    return raised.exception.ref;
  }

  it('starts a run, repeats it as the same run, and lists runs and status', async () => {
    const body = {
      kind: 'ledger_integrity',
      environment: 'test',
      currency: 'MWK',
      idempotencyKey: `http-${randomUUID()}`,
    };
    expect(
      (await s1.client.post(`${admin}/reconciliation/runs`, { ...body, kind: 'nope' })).statusCode
    ).toBe(400);
    expect(
      (await s1.client.post(`${admin}/reconciliation/runs`, { ...body, idempotencyKey: 'short' }))
        .statusCode
    ).toBe(400);
    expect(
      (
        await s1.client.post(`${admin}/reconciliation/runs`, {
          kind: 'provider_statement',
          idempotencyKey: body.idempotencyKey,
        })
      ).statusCode
    ).toBe(400);
    const first = await s1.client.post(`${admin}/reconciliation/runs`, body);
    const second = await s1.client.post(`${admin}/reconciliation/runs`, body);
    expect(first.json().data).toMatchObject({
      outcome: 'completed',
      run: { kind: 'ledger_integrity', status: 'completed' },
    });
    expect(second.json().data.outcome).toBe('duplicate');
    expect(second.json().data.run.id).toBe(first.json().data.run.id);
    const runRef = first.json().data.run.id as string;
    expect((await s1.client.get(`${admin}/reconciliation/runs/${runRef}`)).json().data.id).toBe(
      runRef
    );
    expect((await s1.client.get(`${admin}/reconciliation/runs/rcr_missing`)).statusCode).toBe(404);
    const runs = await agent.client.get(`${admin}/reconciliation/runs`);
    expect(runs.statusCode).toBe(403);
    expect(
      (await ops.client.get(`${admin}/reconciliation/runs?kind=ledger_integrity`)).json().data.items
        .length
    ).toBeGreaterThan(0);
    const status = await ops.client.get(`${admin}/reconciliation/status`);
    expect(status.json().data.latestRuns.map((r: { kind: string }) => r.kind)).toEqual([
      'gateway_gap',
      'ledger_integrity',
      'provider_statement',
      'balance_proof',
    ]);
    expect((await agent.client.post(`${admin}/reconciliation/runs`, body)).statusCode).toBe(403);
    void m;
  });

  it('works the queue: assign, note, resolve, and decide a write-off with a second person', async () => {
    const ref = await exception(800n);
    const list = await ops.client.get(
      `${admin}/reconciliation/exceptions?kind=statement_unmatched_row&limit=200`
    );
    expect(list.json().data.items.map((e: { id: string }) => e.id)).toContain(ref);
    expect(
      (await ops.client.get(`${admin}/reconciliation/unresolved?limit=200`)).json().data.items
        .length
    ).toBeGreaterThan(0);

    const assign = await ops.client.post(`${admin}/reconciliation/exceptions/${ref}/assign`, {
      assignee: ops.admin.userId,
    });
    expect(assign.json().data).toMatchObject({
      status: 'investigating',
      assignedTo: ops.admin.userId,
    });
    expect(
      (
        await ops.client.post(`${admin}/reconciliation/exceptions/${ref}/assign`, {
          assignee: 'usr_missing',
        })
      ).statusCode
    ).toBe(404);
    const note = await ops.client.post(`${admin}/reconciliation/exceptions/${ref}/notes`, {
      body: 'Checked the provider portal',
    });
    expect(note.statusCode).toBe(201);

    // Bad resolutions are refused before anything is recorded.
    const resolve = (client: StaffSession['client'], body: unknown) =>
      client.post(`${admin}/reconciliation/exceptions/${ref}/resolve`, body);
    expect(
      (await resolve(ops.client, { resolution: 'written_off', note: 'no account' })).statusCode
    ).toBe(400);
    expect(
      (
        await resolve(ops.client, {
          resolution: 'matched_manually',
          note: 'ok',
          accountCode: '9000:suspense',
        })
      ).statusCode
    ).toBe(400);
    const bank = (
      await ctx.unitOfWork.run((tx) =>
        ctx.app.get(AccountsService, { strict: false }).openBankAccount(tx, {
          environment: 'live',
          bankKey: `h${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          name: 'http bank',
          currency: 'GHS',
        })
      )
    ).code;

    // Operations requests the write-off; operations cannot approve it; a different super admin does.
    const requested = await resolve(ops.client, {
      resolution: 'written_off',
      note: 'Provider fee never refunded',
      accountCode: bank,
      amountMinor: '500',
    });
    expect(requested.statusCode).toBe(200);
    const request = requested.json().data.request as { id: string; status: string };
    expect(request.status).toBe('pending');
    const decide = (client: StaffSession['client'], body: unknown) =>
      client.post(`${admin}/reconciliation/resolutions/${request.id}/decide`, body);
    expect((await decide(ops.client, { decision: 'approve' })).statusCode).toBe(403);
    expect((await decide(s1.client, { decision: 'maybe' })).statusCode).toBe(400);
    const pending = await ops.client.get(`${admin}/reconciliation/pending-resolutions`);
    expect(pending.json().data.items.map((r: { id: string }) => r.id)).toContain(request.id);
    const approved = await decide(s1.client, { decision: 'approve', note: 'Agreed' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.exception).toMatchObject({
      status: 'written_off',
      resolution: 'written_off',
    });
    expect(approved.json().data.request.entry).toMatch(/^je_/);
    expect((await decide(s2.client, { decision: 'approve' })).statusCode).toBe(409);

    const detail = await ops.client.get(`${admin}/reconciliation/exceptions/${ref}`);
    expect(detail.json().data.notes.map((n: { kind: string }) => n.kind)).toEqual(
      expect.arrayContaining(['assignment', 'note', 'resolution', 'approval'])
    );
    const history = await ops.client.get(`${admin}/reconciliation/history`);
    expect(history.json().data.items.map((e: { id: string }) => e.id)).toContain(ref);
  });

  it('refuses the requester as approver over HTTP, and a rejected write-off posts nothing', async () => {
    const ref = await exception(300n);
    const bank = (
      await ctx.unitOfWork.run((tx) =>
        ctx.app.get(AccountsService, { strict: false }).openBankAccount(tx, {
          environment: 'live',
          bankKey: `r${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          name: 'http bank 2',
          currency: 'GHS',
        })
      )
    ).code;
    const requested = await s1.client.post(`${admin}/reconciliation/exceptions/${ref}/resolve`, {
      resolution: 'written_off',
      note: 'Accept the loss',
      accountCode: bank,
      amountMinor: '300',
    });
    const id = requested.json().data.request.id as string;
    const self = await s1.client.post(`${admin}/reconciliation/resolutions/${id}/decide`, {
      decision: 'approve',
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('RECONCILIATION_APPROVER_IS_REQUESTER');
    const rejected = await s2.client.post(`${admin}/reconciliation/resolutions/${id}/decide`, {
      decision: 'reject',
      note: 'Not enough evidence',
    });
    expect(rejected.json().data).toMatchObject({
      exception: { status: 'investigating' },
      request: { status: 'rejected', decisionNote: 'Not enough evidence' },
    });
    expect(
      await sql(`select 1 from core.journal_entries where source_id = $1`, [`writeoff:${id}`])
    ).toEqual([]);
  });

  it('uploads a statement, lists it and its rows', async () => {
    const now = ctx.clock.now();
    const body = {
      provider: 'airtel',
      currency: CURRENCY,
      periodStart: new Date(now.getTime() - 3_600_000).toISOString(),
      periodEnd: new Date(now.getTime() + 3_600_000).toISOString(),
      rows: [
        { providerRef: `HTTP-${randomUUID()}`, amountMinor: '4242', occurredAt: now.toISOString() },
        { providerRef: `HTTP-${randomUUID()}`, amountMinor: '4343', occurredAt: now.toISOString() },
      ],
    };
    const up = await ops.client.post(`${admin}/reconciliation/statements`, body);
    expect(up.statusCode).toBe(201);
    const ref = up.json().data.id as string;
    expect(up.json().data).toMatchObject({ rowCount: 2, totalMinor: '8585', status: 'uploaded' });
    expect((await ops.client.post(`${admin}/reconciliation/statements`, body)).statusCode).toBe(
      409
    );
    expect(
      (await ops.client.post(`${admin}/reconciliation/statements`, { ...body, rows: [] }))
        .statusCode
    ).toBe(400);
    expect((await agent.client.post(`${admin}/reconciliation/statements`, body)).statusCode).toBe(
      403
    );
    const run = await ops.client.post(`${admin}/reconciliation/runs`, {
      kind: 'provider_statement',
      statement: ref,
      idempotencyKey: `stmt-${randomUUID()}`,
    });
    expect(run.json().data.outcome).toBe('completed');
    const rows = await ops.client.get(`${admin}/reconciliation/statements/${ref}/rows`);
    expect(rows.json().data.items.map((r: { matchStatus: string }) => r.matchStatus)).toEqual([
      'unmatched',
      'unmatched',
    ]);
    expect(
      (await ops.client.get(`${admin}/reconciliation/statements`))
        .json()
        .data.items.map((x: { id: string }) => x.id)
    ).toContain(ref);
    expect(
      (await ops.client.get(`${admin}/reconciliation/statements/pst_missing/rows`)).statusCode
    ).toBe(404);
  });
});
