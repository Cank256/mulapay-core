/**
 * Reports, schedules, rollups and analytics (spec 6.12, 9.2): asynchronous generation from a
 * server-side cursor into object storage without buffering, 15 minute links, seven day files,
 * failure handling, schedules with history, and dashboard analytics read from the rollups.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORT_TYPES } from '../../src/modules/reports/domain/report-params';
import { REPORT_DEFINITIONS } from '../../src/modules/reports/report-queries';
import { REPORT_LINK_TTL_SECONDS } from '../../src/modules/reports/reports.service';
import {
  addTeamMember,
  loginMerchantUser,
  staffSession,
  type MerchantUser,
} from '../support/identity';
import {
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  toProcessing,
  type TestMerchant,
} from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

let ctx: SupportContext;
let merchant: TestMerchant;
let other: TestMerchant;
let developer: MerchantUser;
let supportUser: MerchantUser;
/** The UTC day (on the test clock) the payments of this suite completed. */
let paymentDay: string;

beforeAll(async () => {
  ctx = await startSupportContext({
    overrides: {
      REPORT_MAX_ACTIVE_PER_MERCHANT: '3',
      REPORT_SCHEDULE_MAX_FAILURES: '2',
      REPORT_CURSOR_BATCH_SIZE: '1000',
    },
  });
  merchant = await createTestMerchant(ctx, { label: 'reporter' });
  other = await createTestMerchant(ctx, { label: 'other' });
  developer = await addTeamMember(ctx, merchant.owner, 'developer');
  supportUser = await addTeamMember(ctx, merchant.owner, 'support');
});
afterAll(async () => {
  await ctx?.close();
});

const now = () => ctx.clock.now();
const window = () => ({
  from: new Date(now().getTime() - 86_400_000).toISOString(),
  to: new Date(now().getTime() + 86_400_000).toISOString(),
});
const stored = (key: string) => ctx.s3.objects.get(`${'mulapay-reports'}/${key}`);
const rowOf = async (ref: string) =>
  (
    await ctx.query<{
      id: string;
      status: string;
      file_key: string | null;
      attempts: number;
      error: string | null;
      row_count: string | null;
      expires_at: Date | null;
    }>(
      `select id, status, file_key, attempts, error, row_count::text, expires_at from core.reports where ref = $1`,
      [ref]
    )
  )[0]!;

async function succeedTestPayment(amount: string, extra: Record<string, unknown> = {}) {
  const created = await createPayment(merchant.test, {
    amountMinor: amount,
    currency: 'UGX',
    ...extra,
  });
  const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('test'), created.id);
  await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'mtn' } });
  const done = await applyEvent(
    ctx,
    detail!.payment.id,
    event(
      { kind: 'succeeded', amountMinor: BigInt(amount), currency: 'UGX' },
      {
        identifiers: { provider: 'mtn', providerTransactionId: `P-${randomUUID().slice(0, 10)}` },
        occurredAt: now(),
      }
    )
  );
  if (done.result !== 'applied') throw new Error(JSON.stringify(done));
  return created;
}
async function failTestPayment(amount: string) {
  const created = await createPayment(merchant.test, { amountMinor: amount, currency: 'UGX' });
  const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('test'), created.id);
  await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'airtel' } });
  await applyEvent(
    ctx,
    detail!.payment.id,
    event(
      { kind: 'failed', failureCode: 'insufficient_funds' },
      { identifiers: { provider: 'airtel' }, occurredAt: now() }
    )
  );
  return created;
}

describe('every report type is valid SQL', () => {
  it('plans against the real schema, with a bound on every partitioned table', async () => {
    const scope = {
      environment: 'test' as const,
      merchantId: merchant.id,
      merchantRef: merchant.ref,
    };
    const params: Record<string, Record<string, unknown>> = {
      ledger_account_statement: { accountCode: '9000:suspense', currency: 'UGX' },
      settlement_statement: { settlement: 'stl_x' },
      balance_statement: { currency: 'UGX' },
    };
    const from = new Date(now().getTime() - 86_400_000);
    const to = new Date(now().getTime() + 86_400_000);
    for (const type of REPORT_TYPES) {
      const built = REPORT_DEFINITIONS[type].build(scope, params[type] ?? {}, from, to);
      const statement = 'explain ' + built.text;
      const plan = await ctx.query(statement, built.values);
      expect(plan.length, type).toBeGreaterThan(0);
      expect(built.text, type).not.toMatch(/offset/i);
    }
  });
});

describe('requesting and downloading a report', () => {
  it('answers 202 with a reference, produces the file in the background, and links it for 15 minutes', async () => {
    paymentDay = now().toISOString().slice(0, 10);
    await succeedTestPayment('12000', { description: '=HYPERLINK("http://evil","click")' });
    await succeedTestPayment('34000');
    await failTestPayment('5000');
    const res = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: window(),
    });
    expect(res.statusCode).toBe(202);
    const report = res.json().data;
    expect(report).toMatchObject({
      status: 'queued',
      type: 'transactions',
      format: 'csv',
      rowCount: null,
    });
    expect(report.id).toMatch(/^rpt_/);
    // Not ready: no file to download yet.
    const early = await merchant.owner.client.get(
      `/dashboard/v1/reports/${report.id}/download?environment=test`
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('REPORT_NOT_READY');

    await ctx.pump();
    const ready = (
      await merchant.owner.client.get(`/dashboard/v1/reports/${report.id}?environment=test`)
    ).json().data;
    expect(ready).toMatchObject({ status: 'ready', rowCount: 3, error: null });
    expect(ready.fileSize).toBeGreaterThan(100);
    // Files are kept seven days.
    expect(new Date(ready.expiresAt).getTime() - new Date(ready.finishedAt).getTime()).toBe(
      7 * 24 * 3_600_000
    );

    const link = await merchant.owner.client.get(
      `/dashboard/v1/reports/${report.id}/download?environment=test`
    );
    expect(link.statusCode).toBe(200);
    expect(new Date(link.json().data.expiresAt).getTime() - now().getTime()).toBe(
      REPORT_LINK_TTL_SECONDS * 1000
    );
    expect(REPORT_LINK_TTL_SECONDS).toBe(900);
    expect(link.json().data.url).toContain('X-Amz-Expires=900');

    const file = stored((await rowOf(report.id)).file_key!);
    expect(file?.contentType).toContain('text/csv');
    const lines = file!.body.toString('utf8').trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'reference,type,status,amount_minor,fee_minor,net_minor,currency,provider,channel,created_at,completed_at,failure_code'
    );
    expect(lines).toHaveLength(4);
    expect(createHash('sha256').update(file!.body).digest('hex')).toBe(ready.sha256);
    expect(file!.body.length).toBe(ready.fileSize);
    const audited = await ctx.query(
      `select 1 from core.audit_logs where action = 'report.download_link_issued' and resource_id = $1`,
      [report.id]
    );
    expect(audited).toHaveLength(1);

    // The requester is told it is ready.
    const told = await ctx.query(
      `select 1 from core.notifications where template_code = 'report.ready' and resource_key = $1 and channel = 'in_app'`,
      [report.id]
    );
    expect(told).toHaveLength(1);
  });

  it('writes a spreadsheet-safe CSV and a JSON array on request', async () => {
    const csv = (
      await merchant.owner.client.post('/dashboard/v1/reports', {
        type: 'payments',
        environment: 'test',
        params: window(),
      })
    ).json().data;
    const json = (
      await merchant.owner.client.post('/dashboard/v1/reports', {
        type: 'payments',
        environment: 'test',
        format: 'json',
        params: window(),
      })
    ).json().data;
    await ctx.pump();
    const csvFile = stored((await rowOf(csv.id)).file_key!)!.body.toString('utf8');
    // A description that starts like a formula is prefixed, so a spreadsheet will not run it.
    expect(csvFile).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    const jsonRow = await rowOf(json.id);
    const parsed = JSON.parse(stored(jsonRow.file_key!)!.body.toString('utf8')) as Array<
      Record<string, string>
    >;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toHaveProperty('reference');
    expect(stored(jsonRow.file_key!)!.contentType).toBe('application/json');
  });

  it('generates every platform type, and the merchant ones for a named merchant, end to end', async () => {
    const admin = await staffSession(ctx, 'super_admin');
    const requests: Array<[string, Record<string, unknown>]> = [
      [
        'ledger_account_statement',
        { accountCode: '9000:suspense', currency: 'UGX', environment: 'test', ...window() },
      ],
      ['reconciliation_exceptions', window()],
      ['aml_alerts', window()],
      ['kyc_status', {}],
      ['audit_trail', window()],
      ['merchant_performance', { merchant: merchant.ref, ...window() }],
      ['transactions', { merchant: merchant.ref, ...window() }],
      ['fees', { merchant: merchant.ref, ...window() }],
      ['balance_statement', { merchant: merchant.ref, currency: 'UGX', ...window() }],
    ];
    const refs: string[] = [];
    for (const [type, params] of requests) {
      const res = await admin.client.post('/admin/v1/reports', { type, params });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(202);
      refs.push(res.json().data.id);
      // Staff have the same limit on reports in flight, so let each one finish.
      await ctx.pump();
    }
    for (const [i, ref] of refs.entries()) {
      const row = await rowOf(ref);
      expect(row.status, `${requests[i]?.[0]} ${row.error}`).toBe('ready');
    }
    const kyc = stored((await rowOf(refs[3]!)).file_key!)!.body.toString('utf8');
    expect(kyc.split('\r\n')[0]).toBe(
      'merchant,legal_name,kyc_level,profile_level,status,submitted_at,reviewed_at,expires_at'
    );
    // Staff download through the admin route, which is audited; they only see what staff requested.
    const link = await admin.client.get(`/admin/v1/reports/${refs[0]}/download`);
    expect(link.statusCode).toBe(200);
    expect(
      (await admin.client.get('/admin/v1/reports?limit=100')).json().data.items.length
    ).toBeGreaterThanOrEqual(9);
    const merchantsView = await merchant.owner.client.get(`/dashboard/v1/reports/${refs[0]}`);
    expect(merchantsView.statusCode).toBe(404);
  });
});

describe('who may ask for what', () => {
  it('keeps platform types and other merchants’ reports out of a merchant’s reach', async () => {
    const platform = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'audit_trail',
      params: window(),
    });
    expect(platform.statusCode).toBe(422);
    expect(platform.json().error.details.reason).toBe('type_not_available');
    const fresh = (
      await merchant.owner.client.post('/dashboard/v1/reports', {
        type: 'transactions',
        environment: 'test',
        params: window(),
      })
    ).json().data;
    for (const path of [
      `/dashboard/v1/reports/${fresh.id}?environment=test`,
      `/dashboard/v1/reports/${fresh.id}/download?environment=test`,
    ]) {
      expect((await other.owner.client.get(path)).statusCode).toBe(404);
    }
    const theirs = await other.owner.client.get('/dashboard/v1/reports?environment=test&limit=100');
    expect(theirs.json().data.items.map((r: { id: string }) => r.id)).not.toContain(fresh.id);
    // A `merchant` parameter cannot point a merchant's request at someone else's data.
    const aimed = await other.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: { merchant: merchant.ref, ...window() },
    });
    expect(aimed.statusCode).toBe(202);
    await ctx.pump();
    const mine = await rowOf(aimed.json().data.id);
    expect(stored(mine.file_key!)!.body.toString('utf8').trimEnd().split('\r\n')).toHaveLength(1);
    // A test key's data never appears in a live report.
    const liveReport = (
      await merchant.owner.client.post('/dashboard/v1/reports', {
        type: 'transactions',
        params: window(),
      })
    ).json().data;
    await ctx.pump();
    expect(
      stored((await rowOf(liveReport.id)).file_key!)!
        .body.toString('utf8')
        .trimEnd()
        .split('\r\n')
    ).toHaveLength(1);
  });

  it('refuses bad requests with a reason, and unauthorised ones', async () => {
    const owner = merchant.owner.client;
    expect((await owner.post('/dashboard/v1/reports', { type: 'nonsense' })).statusCode).toBe(400);
    const xlsx = await owner.post('/dashboard/v1/reports', {
      type: 'transactions',
      format: 'xlsx',
      environment: 'test',
    });
    expect(xlsx.statusCode).toBe(422);
    expect(xlsx.json().error).toMatchObject({
      code: 'REPORT_INVALID',
      details: { reason: 'format_not_supported' },
    });
    const long = await owner.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: { from: '2020-01-01T00:00:00Z', to: '2023-01-01T00:00:00Z' },
    });
    expect(long.json().error.details).toMatchObject({ reason: 'window_too_long', maxDays: 366 });
    const unknown = await owner.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: { sneaky: true },
    });
    expect(unknown.json().error.details.reason).toBe('bad_params');
    const notMine = await owner.post('/dashboard/v1/reports', {
      type: 'settlement_statement',
      environment: 'test',
      params: { settlement: 'stl_nope' },
    });
    expect(notMine.json().error.details.reason).toBe('settlement_not_found');

    expect((await supportUser.client.get('/dashboard/v1/reports')).statusCode).toBe(403);
    await loginMerchantUser(developer.client, developer.email, developer.merchantId);
    expect((await developer.client.get('/dashboard/v1/reports')).statusCode).toBe(200);
    expect(
      (
        await developer.client.post('/dashboard/v1/reports', {
          type: 'transactions',
          environment: 'test',
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/dashboard/v1/reports', payload: {} }))
        .statusCode
    ).toBe(401);

    // Platform reports need `reports:platform`, and the data a type exposes needs its own permission.
    const nobody = { userId: randomUUID(), userRef: 'usr_x', can: () => false };
    await expect(
      ctx.reportsService.request({ type: 'audit_trail', params: window() }, { staff: nobody })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      ctx.reportsService.request(
        { type: 'ledger_account_statement', params: window() },
        { staff: nobody }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const agent = await staffSession(ctx, 'support_agent');
    expect(
      (await agent.client.post('/admin/v1/reports', { type: 'kyc_status', params: {} })).statusCode
    ).toBe(403);
    const compliance = await staffSession(ctx, 'compliance');
    expect(
      (
        await compliance.client.post('/admin/v1/reports', {
          type: 'transactions',
          params: window(),
        })
      ).json().error.details.reason
    ).toBe('merchant_required');
    expect(
      (await compliance.client.post('/admin/v1/reports', { type: 'kyc_status', params: {} }))
        .statusCode
    ).toBe(202);
    const week = await compliance.client.post('/admin/v1/reports', {
      type: 'audit_trail',
      params: { from: '2025-01-01T00:00:00Z', to: '2025-06-01T00:00:00Z' },
    });
    expect([403, 422]).toContain(week.statusCode);
  });

  it('limits how many reports one merchant has in flight', async () => {
    const busy = await createTestMerchant(ctx, { label: 'busy' });
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await busy.owner.client.post('/dashboard/v1/reports', {
            type: 'transactions',
            environment: 'test',
          })
        ).statusCode
      ).toBe(202);
    }
    const fourth = await busy.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('REPORT_LIMIT_REACHED');
    await ctx.pump();
    expect(
      (
        await busy.owner.client.post('/dashboard/v1/reports', {
          type: 'transactions',
          environment: 'test',
        })
      ).statusCode
    ).toBe(202);
  });
});

describe('failure, retry and idempotence', () => {
  it('generates once however many workers run it, and leaves a finished report alone', async () => {
    const res = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'fees',
      environment: 'test',
      params: window(),
    });
    const ref = res.json().data.id;
    const { id } = await rowOf(ref);
    const results = await Promise.all([
      ctx.generation.generate(id),
      ctx.generation.generate(id),
      ctx.generation.generate(id),
    ]);
    expect(results.filter((r) => r === 'ready')).toHaveLength(1);
    expect(await ctx.generation.generate(id)).toBe('skipped');
    expect((await rowOf(ref)).attempts).toBe(1);
    expect(ctx.s3.uploads.size).toBe(0);
  });

  it('retries a storage outage, then fails the report, tells the requester, and leaves no file', async () => {
    const res = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: window(),
    });
    const ref = res.json().data.id;
    const { id } = await rowOf(ref);
    ctx.s3.failWith = 503;
    expect(await ctx.generation.generate(id)).toBe('retry');
    expect(await rowOf(ref)).toMatchObject({
      status: 'queued',
      attempts: 1,
      error: 'generation_failed',
    });
    expect(await ctx.generation.generate(id)).toBe('retry');
    expect(await ctx.generation.generate(id)).toBe('failed');
    ctx.s3.failWith = null;
    expect(await rowOf(ref)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: 'generation_failed',
      file_key: null,
    });
    expect(await ctx.generation.generate(id)).toBe('skipped');
    expect(stored(`reports/${merchant.ref}/test/${ref}.csv`)).toBeUndefined();
    const told = await ctx.query(
      `select 1 from core.notifications where template_code = 'report.failed' and resource_key = $1`,
      [ref]
    );
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(
      (await merchant.owner.client.get(`/dashboard/v1/reports/${ref}/download?environment=test`))
        .statusCode
    ).toBe(409);
    const reports = await ctx.query(
      `select 1 from core.audit_logs where action = 'report.failed' and resource_id = $1`,
      [ref]
    );
    expect(reports).toHaveLength(1);
  });

  it('recovers a worker that died mid-report once its lease lapses', async () => {
    const res = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: window(),
    });
    const ref = res.json().data.id;
    const { id } = await rowOf(ref);
    await ctx.query(
      `update core.reports set status = 'running', attempts = 1, lease_expires_at = $2 where id = $1`,
      [id, new Date(now().getTime() + 600_000)]
    );
    expect(await ctx.generation.generate(id)).toBe('skipped');
    ctx.clock.advanceBy(16 * 60_000);
    expect(await ctx.generation.generate(id)).toBe('ready');
    expect((await rowOf(ref)).attempts).toBe(2);
  });
});

describe('streaming a large report', () => {
  it('reads through a server-side cursor and uploads in parts, never holding the file', async () => {
    const big = await createTestMerchant(ctx, { label: 'big' });
    // 130,000 transactions straight into the table: the point is the size of the report. The
    // registry trigger only allows the application's own inserts, so it is switched off for this load.
    try {
      await ctx.query('begin');
      await ctx.query('set local session_replication_role = replica');
      await ctx.query(
        `insert into core.transaction_keys (id, ref, transaction_created_at, merchant_id, environment, type, created_at)
         select gen_random_uuid(), 'txn_' || upper(substr(md5(g::text) || md5(g::text || 'x'), 1, 26)), now(), $1, 'test', 'payment', now() from generate_series(1, 130000) g`,
        [big.id]
      );
      await ctx.query(
        `insert into core.transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, provider, channel, initiated_at, completed_at, created_at, updated_at)
         select k.id, k.ref, k.merchant_id, 'test', 'payment', 'succeeded', 1000, 10, 990, 'UGX', 'mtn', 'mobile_money', now(), now(), k.created_at, now()
           from core.transaction_keys k where k.merchant_id = $1`,
        [big.id]
      );
      await ctx.query('commit');
    } catch (error) {
      await ctx.query('rollback');
      throw error;
    }
    const res = await big.owner.client.post('/dashboard/v1/reports', {
      type: 'transactions',
      environment: 'test',
      params: {
        from: new Date(now().getTime() - 2 * 86_400_000).toISOString(),
        to: new Date(now().getTime() + 2 * 86_400_000).toISOString(),
      },
    });
    ctx.s3.maxBodyBytes = 0;
    await ctx.pump();
    const row = await rowOf(res.json().data.id);
    expect(row).toMatchObject({ status: 'ready', row_count: '130000' });
    const file = stored(row.file_key!)!;
    expect(file.body.length).toBeGreaterThan(12 * 1024 * 1024);
    expect(file.body.toString('utf8', 0, 200)).toContain('reference,type,status');
    // The largest request core made to the store was one part, not the file.
    expect(ctx.s3.maxBodyBytes).toBeLessThan(6 * 1024 * 1024);
    expect(ctx.s3.maxBodyBytes).toBeLessThan(file.body.length / 2);
    expect(ctx.s3.uploads.size).toBe(0);
    expect(file.body.toString('utf8').trimEnd().split('\r\n')).toHaveLength(130_001);
  }, 120_000);
});

describe('expiry', () => {
  it('deletes the file after seven days and stops offering links', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const res = await merchant.owner.client.post('/dashboard/v1/reports', {
      type: 'fees',
      environment: 'test',
      params: window(),
    });
    const ref = res.json().data.id;
    await ctx.pump();
    const key = (await rowOf(ref)).file_key!;
    expect(stored(key)).toBeDefined();
    ctx.clock.advanceBy(6 * 24 * 3_600_000);
    expect(await ctx.reportsService.expireOld()).toBe(0);
    ctx.clock.advanceBy(25 * 3_600_000);
    expect(await ctx.reportsService.expireOld()).toBeGreaterThanOrEqual(1);
    expect(stored(key)).toBeUndefined();
    expect((await rowOf(ref)).status).toBe('expired');
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const gone = await merchant.owner.client.get(
      `/dashboard/v1/reports/${ref}/download?environment=test`
    );
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe('REPORT_EXPIRED');
  });
});

describe('report schedules', () => {
  it('validates the schedule and its recipients', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = merchant.owner.client;
    const base = {
      reportType: 'transactions',
      period: 'previous_day',
      cron: '0 6 * * *',
      recipients: [merchant.owner.email],
      environment: 'test',
    };
    expect(
      (await c.post('/dashboard/v1/report-schedules', { ...base, cron: 'every day' })).json().error
        .details.reason
    ).toBe('invalid_cron');
    expect(
      (await c.post('/dashboard/v1/report-schedules', { ...base, cron: '*/5 * * * *' })).json()
        .error.details.reason
    ).toBe('too_frequent');
    expect(
      (
        await c.post('/dashboard/v1/report-schedules', {
          ...base,
          recipients: ['stranger@example.com'],
        })
      ).json().error.details.reason
    ).toBe('unknown_recipient');
    expect(
      (await c.post('/dashboard/v1/report-schedules', { ...base, reportType: 'audit_trail' }))
        .statusCode
    ).toBe(422);
    expect(
      (
        await c.post('/dashboard/v1/report-schedules', {
          ...base,
          reportType: 'settlement_statement',
          params: { settlement: 'stl_x' },
        })
      ).json().error.details.reason
    ).toBe('type_not_schedulable');
    expect(
      (await c.post('/dashboard/v1/report-schedules', { ...base, recipients: [] })).statusCode
    ).toBe(400);
  });

  it('creates one report per due time, with its window and history, however many ticks run', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = merchant.owner.client;
    const created = await c.post('/dashboard/v1/report-schedules', {
      reportType: 'transactions',
      period: 'previous_day',
      cron: '0 6 * * *',
      recipients: [merchant.owner.email, developer.email],
      environment: 'test',
    });
    expect(created.statusCode).toBe(201);
    const schedule = created.json().data;
    expect(schedule).toMatchObject({
      active: true,
      timezone: 'UTC',
      period: 'previous_day',
      consecutiveFailures: 0,
    });
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(now().getTime());

    expect(await ctx.schedulesService.tick()).toBeGreaterThanOrEqual(0);
    ctx.clock.set(new Date(new Date(schedule.nextRunAt).getTime() + 1000));
    const ticks = await Promise.all([
      ctx.schedulesService.tick(),
      ctx.schedulesService.tick(),
      ctx.schedulesService.tick(),
    ]);
    expect(ticks.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    await ctx.pump();
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);

    const detail = await c.get(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`);
    expect(detail.json().data.history).toHaveLength(1);
    expect(detail.json().data.history[0]).toMatchObject({ status: 'succeeded', error: null });
    expect(detail.json().data.lastStatus).toBe('succeeded');
    const dueAt = new Date(detail.json().data.history[0].dueAt);
    expect(dueAt.toISOString()).toBe(schedule.nextRunAt);
    expect(new Date(detail.json().data.nextRunAt).getTime() - dueAt.getTime()).toBe(86_400_000);

    const generated = await ctx.query<{
      ref: string;
      params: { from: string; to: string };
      status: string;
    }>(
      `select r.ref, r.params, r.status from core.reports r join core.report_schedules s on s.id = r.schedule_id where s.ref = $1`,
      [schedule.id]
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]?.status).toBe('ready');
    // The window is the UTC day before the due time.
    const midnight = Date.UTC(dueAt.getUTCFullYear(), dueAt.getUTCMonth(), dueAt.getUTCDate());
    expect(generated[0]?.params).toMatchObject({
      from: new Date(midnight - 86_400_000).toISOString(),
      to: new Date(midnight).toISOString(),
    });
    // Every recipient is told it is ready.
    const told = await ctx.query(
      `select 1 from core.notifications where template_code = 'report.ready' and resource_key = $1 and channel = 'in_app'`,
      [generated[0]?.ref]
    );
    expect(told).toHaveLength(2);

    // Switch it off, and nothing more is made.
    const off = await c.patch(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`, {
      active: false,
    });
    expect(off.json().data).toMatchObject({ active: false });
    ctx.clock.advanceBy(3 * 86_400_000);
    expect(await ctx.schedulesService.tick()).toBe(0);
    await loginMerchantUser(c, merchant.owner.email, merchant.owner.merchantId);
    const after = await c.get(`/dashboard/v1/report-schedules?environment=test`);
    expect(after.json().data.items.map((s: { id: string }) => s.id)).toContain(schedule.id);
    expect(
      (await c.delete(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`)).json().data
    ).toEqual({ deleted: true });
    expect(
      (await c.get(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`)).statusCode
    ).toBe(404);
    await loginMerchantUser(other.owner.client, other.owner.email, other.owner.merchantId);
    expect(
      (
        await other.owner.client.get(
          `/dashboard/v1/report-schedules/${schedule.id}?environment=test`
        )
      ).statusCode
    ).toBe(404);
  });

  it('turns itself off after repeated failures and tells its recipients', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = merchant.owner.client;
    const schedule = (
      await c.post('/dashboard/v1/report-schedules', {
        reportType: 'fees',
        period: 'previous_day',
        cron: '0 5 * * *',
        recipients: [merchant.owner.email],
        environment: 'test',
      })
    ).json().data;
    ctx.s3.failWith = 503;
    for (let day = 0; day < 2; day++) {
      ctx.clock.set(
        new Date(
          new Date(
            (
              await ctx.query<{ n: Date }>(
                `select next_run_at as n from core.report_schedules where ref = $1`,
                [schedule.id]
              )
            )[0]!.n
          ).getTime() + 1000
        )
      );
      await ctx.schedulesService.tick();
      // The worker tries three times, as BullMQ would, then the report fails.
      const rows = await ctx.query<{ id: string }>(
        `select r.id from core.reports r join core.report_schedules s on s.id = r.schedule_id where s.ref = $1 and r.status in ('queued', 'running')`,
        [schedule.id]
      );
      for (const r of rows) for (let i = 0; i < 3; i++) await ctx.generation.generate(r.id);
    }
    ctx.s3.failWith = null;
    const row = (
      await ctx.query<{
        active: boolean;
        consecutive_failures: number;
        disabled_reason: string | null;
        last_status: string;
      }>(
        `select active, consecutive_failures, disabled_reason, last_status from core.report_schedules where ref = $1`,
        [schedule.id]
      )
    )[0];
    expect(row).toEqual({
      active: false,
      consecutive_failures: 2,
      disabled_reason: 'repeated_failures',
      last_status: 'failed',
    });
    const told = await ctx.query(
      `select 1 from core.notifications where template_code = 'report_schedule.disabled' and resource_key = $1`,
      [schedule.id]
    );
    expect(told.length).toBeGreaterThanOrEqual(1);
    await loginMerchantUser(c, merchant.owner.email, merchant.owner.merchantId);
    const history = await c.get(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`);
    expect(history.json().data.history.map((h: { status: string }) => h.status)).toEqual([
      'failed',
      'failed',
    ]);
    // Turning it back on starts it afresh.
    const on = await c.patch(`/dashboard/v1/report-schedules/${schedule.id}?environment=test`, {
      active: true,
    });
    expect(on.json().data).toMatchObject({
      active: true,
      consecutiveFailures: 0,
      disabledReason: null,
    });
    expect(new Date(on.json().data.nextRunAt).getTime()).toBeGreaterThan(now().getTime());
  });
});

describe('rollups and analytics', () => {
  it('rolls transactions up per day, and the dashboard reads only the rollups', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    await loginMerchantUser(other.owner.client, other.owner.email, other.owner.merchantId);
    const today = paymentDay;
    await ctx.rollups.recompute([today]);
    const first = await ctx.query(
      `select * from core.daily_merchant_rollups where merchant_id = $1 order by channel, provider`,
      [merchant.id]
    );
    // Running it again, or twice at once, gives the same numbers.
    await Promise.all([ctx.rollups.recompute([today]), ctx.rollups.recompute([today])]);
    const second = await ctx.query(
      `select * from core.daily_merchant_rollups where merchant_id = $1 order by channel, provider`,
      [merchant.id]
    );
    expect(second.map((r) => ({ ...r, computed_at: null }))).toEqual(
      first.map((r) => ({ ...r, computed_at: null }))
    );

    const c = merchant.owner.client;
    const overview = await c.get(
      `/dashboard/v1/analytics/overview?environment=test&from=${today}&to=${today}`
    );
    expect(overview.statusCode).toBe(200);
    const ugx = overview
      .json()
      .data.currencies.find((x: { currency: string }) => x.currency === 'UGX');
    // The suite made two succeeded payments (12,000 and 34,000), a failed one, and 130,000 only for "big".
    expect(ugx).toMatchObject({
      paymentCount: 2,
      paymentMinor: '46000',
      successCount: 2,
      failureCount: 1,
      successRate: 0.6667,
    });
    const volume = await c.get(
      `/dashboard/v1/analytics/volume?environment=test&from=${today}&to=${today}`
    );
    expect(volume.json().data.points).toEqual([
      expect.objectContaining({
        day: today,
        currency: 'UGX',
        paymentCount: 2,
        paymentMinor: '46000',
      }),
    ]);
    const rate = await c.get(
      `/dashboard/v1/analytics/success-rate?environment=test&from=${today}&to=${today}`
    );
    expect(rate.json().data.points[0]).toMatchObject({
      successCount: 2,
      failureCount: 1,
      successRate: 0.6667,
    });
    const channels = await c.get(
      `/dashboard/v1/analytics/channels?environment=test&from=${today}&to=${today}`
    );
    const mtn = channels
      .json()
      .data.channels.find((x: { provider: string }) => x.provider === 'mtn');
    expect(mtn).toMatchObject({
      channel: 'mobile_money',
      paymentCount: 2,
      successCount: 2,
      successRate: 1,
    });
    expect(
      channels.json().data.channels.find((x: { provider: string }) => x.provider === 'airtel')
    ).toMatchObject({ failureCount: 1, successRate: 0 });

    // Test and live are separate, and another merchant sees nothing of this.
    const live = await c.get(`/dashboard/v1/analytics/overview?from=${today}&to=${today}`);
    expect(live.json().data.currencies).toEqual([]);
    const theirs = await other.owner.client.get(
      `/dashboard/v1/analytics/overview?environment=test&from=${today}&to=${today}`
    );
    expect(theirs.json().data.currencies).toEqual([]);

    // A window over a year is refused; the support role has no analytics.
    const long = await c.get('/dashboard/v1/analytics/overview?from=2020-01-01&to=2023-01-01');
    expect(long.statusCode).toBe(400);
    await loginMerchantUser(supportUser.client, supportUser.email, supportUser.merchantId);
    expect((await supportUser.client.get('/dashboard/v1/analytics/overview')).statusCode).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/dashboard/v1/analytics/overview' })).statusCode
    ).toBe(401);
  });

  it('puts platform volume for the day on the operations overview from the rollups', async () => {
    const ops = await staffSession(ctx, 'operations');
    const overview = await ops.client.get('/admin/v1/ops/overview');
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.today).toMatchObject({ day: now().toISOString().slice(0, 10) });
  });
});
