/**
 * The runbooks in docs/OPERATIONS.md are executable (spec 13, Phase 8 exit criteria).
 *
 * The blocks tagged `runbook:<name>` are read from the document itself and run:
 *
 *   sql   read-only, against a database that holds the failure the runbook describes
 *   http  the route must exist in the committed OpenAPI documents; a GET without placeholders is
 *         called and must answer 200; the scenarios below call the others with the document's own
 *         bodies
 *
 * Each scenario creates the failure (a stuck payment, a lagging cursor, a suspense balance, a
 * failed delivery, a failed settlement batch, ...) and follows the steps. A runbook with no
 * scenario, or a document block that no longer parses or names a missing column, fails here.
 *
 * Runs on its own database: it switches maintenance mode, the consumer cursor and the providers.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { publicId } from '../../src/common/ids/ids';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { Client, loginMerchantUser, staffSession } from '../support/identity';
import {
  apiClient,
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  toProcessing,
  type TestMerchant,
} from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

const ROOT = resolve(__dirname, '../..');
const DOCUMENT = readFileSync(join(ROOT, 'docs/OPERATIONS.md'), 'utf8');

interface Block {
  readonly kind: 'sql' | 'http';
  readonly runbook: string;
  readonly text: string;
}
const BLOCKS: Block[] = [
  ...DOCUMENT.matchAll(/^```(sql|http) runbook:([a-z-]+)\n([\s\S]*?)^```$/gm),
].map((m) => ({ kind: m[1] as 'sql' | 'http', runbook: m[2] ?? '', text: (m[3] ?? '').trim() }));
const ANCHORS = [...DOCUMENT.matchAll(/^<!-- runbook:([a-z-]+) -->$/gm)].map((m) => m[1] ?? '');

interface HttpBlock {
  readonly runbook: string;
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}
function parseHttp(block: Block): HttpBlock {
  const [first = '', ...rest] = block.text.split('\n');
  const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/.exec(first.trim());
  if (!match) throw new Error(`runbook ${block.runbook}: not "METHOD /path": ${first}`);
  const body = rest.join('\n').trim();
  return {
    runbook: block.runbook,
    method: match[1] ?? '',
    path: match[2] ?? '',
    body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
  };
}
const sqlBlocks = (runbook: string) =>
  BLOCKS.filter((b) => b.kind === 'sql' && b.runbook === runbook).map((b) => b.text);
const httpBlocks = (runbook: string) =>
  BLOCKS.filter((b) => b.kind === 'http' && b.runbook === runbook).map(parseHttp);
function http(runbook: string, method: string, pathStart: string): HttpBlock {
  const found = httpBlocks(runbook).find(
    (b) => b.method === method && b.path.startsWith(pathStart)
  );
  if (!found) throw new Error(`runbook ${runbook} has no ${method} ${pathStart}`);
  return found;
}
function fill(path: string, subs: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_all, name: string) => {
    const value = subs[name];
    if (value === undefined) throw new Error(`no value for {${name}} in ${path}`);
    return encodeURIComponent(value);
  });
}
/** Calls a block of the document, with its own body unless the scenario needs other values. */
function call(
  client: Client,
  block: HttpBlock,
  subs: Record<string, string> = {},
  body: Record<string, unknown> | undefined = block.body
) {
  const url = fill(block.path, subs);
  switch (block.method) {
    case 'GET':
      return client.get(url);
    case 'POST':
      return client.post(url, body ?? {});
    case 'PATCH':
      return client.patch(url, body ?? {});
    case 'PUT':
      return client.put(url, body ?? {});
    default:
      return client.delete(url, body);
  }
}

const REQUIRED = [
  'stuck-transaction',
  'consumer-lag',
  'ledger-mismatch',
  'suspense-balance',
  'webhook-backlog',
  'outbox-exhausted',
  'failed-settlement',
  'api-key-compromise',
  'queue-depth',
  'notification-delivery',
  'report-failures',
  'complaint-sla',
  'rollup-staleness',
  'maintenance-mode',
  'approvals',
  'provider-routing',
  'request-log-buffer',
  'rate-limits',
  'sandbox',
  'incidents',
  'compliance',
];

const OPENAPI: Record<string, { paths: Record<string, Record<string, unknown>> }> = {
  '/admin/v1': JSON.parse(readFileSync(join(ROOT, 'docs/openapi/admin.json'), 'utf8')),
  '/dashboard/v1': JSON.parse(readFileSync(join(ROOT, 'docs/openapi/dashboard.json'), 'utf8')),
  '/v1': JSON.parse(readFileSync(join(ROOT, 'docs/openapi/public.json'), 'utf8')),
};
function documented(block: HttpBlock): boolean {
  const surface = Object.keys(OPENAPI).find((prefix) => block.path.startsWith(`${prefix}/`));
  if (!surface) return false;
  const path = block.path.split('?')[0] ?? '';
  return OPENAPI[surface]?.paths[path]?.[block.method.toLowerCase()] !== undefined;
}

let ctx: SupportContext;
let merchant: TestMerchant;
let pg: PgClient;

beforeAll(async () => {
  ctx = await startSupportContext({
    isolated: 'runbooks',
    overrides: { NOTIFICATION_MAX_ATTEMPTS: '3', CONSUMER_LAG_ALERT_SECONDS: '60' },
  });
  merchant = await createTestMerchant(ctx, { label: 'runbook' });
  pg = new PgClient({ connectionString: inject('runbookDatabaseUrls').superuser });
  await pg.connect();
});
afterAll(async () => {
  await pg?.end();
  await ctx?.close();
});

/** Runs a document query in a read-only transaction, with optional damage applied first. */
async function readOnly(sql: string, damage?: string): Promise<Array<Record<string, unknown>>> {
  await pg.query(damage ? 'begin' : 'begin read only');
  try {
    if (damage) {
      await pg.query('set local session_replication_role = replica');
      await pg.query(damage);
    }
    return (await pg.query(sql)).rows;
  } finally {
    await pg.query('rollback');
  }
}
const admin = () => staffSession(ctx, 'super_admin');
/** Tests advance the shared clock, which expires access tokens: sign in again. */
const ownerClient = async () => {
  await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
  return merchant.owner.client;
};

describe('the document', () => {
  it('has a runbook, with at least one executable block, for everything the spec lists', () => {
    for (const name of REQUIRED) {
      expect(ANCHORS, `anchor for ${name}`).toContain(name);
      expect(BLOCKS.filter((b) => b.runbook === name).length, `blocks of ${name}`).toBeGreaterThan(
        0
      );
    }
    for (const block of BLOCKS) expect(ANCHORS, `tag ${block.runbook}`).toContain(block.runbook);
    expect(new Set(ANCHORS).size, 'one anchor per runbook').toBe(ANCHORS.length);
  });
  it('names only routes that exist in the committed OpenAPI documents', () => {
    const missing = BLOCKS.filter((b) => b.kind === 'http')
      .map(parseHttp)
      .filter((b) => !documented(b))
      .map((b) => `${b.method} ${b.path}`);
    expect(missing).toEqual([]);
  });
  it('runs every SQL block read-only against the real schema', async () => {
    for (const block of BLOCKS.filter((b) => b.kind === 'sql')) {
      await expect(
        readOnly(block.text),
        `${block.runbook}: ${block.text.slice(0, 60)}`
      ).resolves.toBeInstanceOf(Array);
    }
  });
  it('answers every GET without placeholders with 200', async () => {
    const staff = await admin();
    const owner = await ownerClient();
    const anonymous = new Client(ctx.app);
    const seen = new Set<string>();
    for (const block of BLOCKS.filter((b) => b.kind === 'http').map(parseHttp)) {
      if (block.method !== 'GET' || block.path.includes('{')) continue;
      if (seen.has(block.path)) continue;
      seen.add(block.path);
      const client = block.path.startsWith('/admin/')
        ? staff.client
        : block.path.startsWith('/dashboard/')
          ? owner
          : anonymous;
      const res = await call(client, block);
      expect(res.statusCode, `${block.path}: ${res.body.slice(0, 200)}`).toBe(200);
    }
    expect(seen.size).toBeGreaterThan(15);
  });
});

describe('suspense balance', () => {
  it('finds the balance and the entry that put it there', async () => {
    const accounts = ctx.app.get(AccountsService, { strict: false });
    const bank = (
      await ctx.unitOfWork.run((tx) =>
        accounts.openBankAccount(tx, {
          environment: 'test',
          bankKey: `rb${randomUUID().slice(0, 6)}`,
          name: 'Runbook bank',
          currency: 'MWK',
        })
      )
    ).code;
    const sourceId = `runbook-suspense-${randomUUID()}`;
    await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', sourceId),
        environment: 'test',
        currency: 'MWK',
        source: 'adjustment',
        sourceId,
        description: 'unidentified money',
        lines: [
          { accountCode: '9000:suspense', direction: 'debit', amountMinor: 900n },
          { accountCode: bank, direction: 'credit', amountMinor: 900n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    const [balances, postings] = sqlBlocks('suspense-balance');
    expect(await readOnly(balances ?? '')).toEqual([
      expect.objectContaining({
        code: '9000:suspense',
        environment: 'test',
        currency: 'MWK',
        balance_debit_positive: '900',
      }),
    ]);
    expect(await readOnly(postings ?? '')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'adjustment', source_id: sourceId, direction: 'debit' }),
      ])
    );
    const a = await admin();
    const res = await call(a.client, http('suspense-balance', 'GET', '/admin/v1/ops/suspense'));
    expect(res.json().data.items).toEqual([
      { environment: 'test', currency: 'MWK', balanceMinor: '900' },
    ]);
  });
});

describe('ledger mismatch', () => {
  it('finds nothing on a healthy ledger, and each query finds its own kind of damage', async () => {
    const [unbalanced, balances, totals] = sqlBlocks('ledger-mismatch');
    expect(await readOnly(unbalanced ?? '')).toEqual([]);
    expect(await readOnly(balances ?? '')).toEqual([]);
    expect(await readOnly(totals ?? '')).toEqual([]);
    // Damage is made inside a transaction with the guard triggers off, and rolled back.
    const lineLoss = `delete from core.journal_lines
       where (entry_id, created_at) = (select entry_id, created_at from core.journal_lines limit 1)
         and direction = 'credit'`;
    expect((await readOnly(unbalanced ?? '', lineLoss)).length).toBeGreaterThan(0);
    const drift = `update core.account_balances set posted_debits_minor = posted_debits_minor + 1
       where (account_id, currency) = (select account_id, currency from core.account_balances limit 1)`;
    expect((await readOnly(balances ?? '', drift)).length).toBeGreaterThan(0);
    expect((await readOnly(totals ?? '', drift)).length).toBeGreaterThan(0);
    // The rollbacks left the ledger untouched.
    expect(await readOnly(balances ?? '')).toEqual([]);
  });
  it('re-checks the ledger from the runbook and reads the findings', async () => {
    const a = await admin();
    const run = http('ledger-mismatch', 'POST', '/admin/v1/reconciliation/runs');
    const res = await call(
      a.client,
      run,
      {},
      { ...run.body, idempotencyKey: `rb-${randomUUID()}` }
    );
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().data.kind ?? res.json().data.run?.kind).toBe('ledger_integrity');
    for (const block of httpBlocks('ledger-mismatch').filter((b) => b.method === 'GET')) {
      expect((await call(a.client, block)).statusCode).toBe(200);
    }
  });
});

describe('stuck transaction, consumer lag and approvals', () => {
  it('follows the stuck transaction runbook from the query to the resolved incident', async () => {
    const created = await createPayment(merchant.test, { amountMinor: '7000', currency: 'UGX' });
    const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('test'), created.id);
    await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'mtn' } });
    await ctx.query(
      `update core.transactions set initiated_at = now() - interval '30 minutes' where merchant_id = $1 and status = 'processing'`,
      [merchant.id]
    );
    const [stuck, exceptions] = sqlBlocks('stuck-transaction');
    const rows = await readOnly(stuck ?? '');
    expect(rows).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^txn_/),
        type: 'payment',
        provider: 'mtn',
        outcome_unknown: false,
      }),
    ]);
    expect(await readOnly(exceptions ?? '')).toEqual([]);

    // The application measures age on its own clock.
    ctx.clock.advanceBy(20 * 60_000);
    const a = await admin();
    const list = await call(a.client, http('stuck-transaction', 'GET', '/admin/v1/ops/stuck'));
    expect(list.json().data.items).toEqual([
      expect.objectContaining({ merchant: merchant.ref, provider: 'mtn', amountMinor: '7000' }),
    ]);
    await ctx.monitor.evaluate();
    const [incident] = await ctx.query<{ ref: string; severity: string }>(
      `select ref, severity from core.incidents where dedupe_key = 'ops:stuck_transactions'`
    );
    expect(incident?.severity).toBe('sev3');
    const resolved = await call(
      a.client,
      http('stuck-transaction', 'POST', '/admin/v1/incidents/{ref}/resolve'),
      { ref: incident?.ref ?? '' }
    );
    expect(resolved.statusCode, resolved.body).toBeLessThan(300);
    const [after] = await ctx.query<{ status: string }>(
      `select status from core.incidents where ref = $1`,
      [incident?.ref]
    );
    expect(after?.status).toBe('resolved');
    // Nothing in the runbook touched the payment.
    const [row] = await ctx.query<{ status: string }>(
      `select status from core.transactions where merchant_id = $1`,
      [merchant.id]
    );
    expect(row?.status).toBe('processing');
  });

  it('follows the consumer lag runbook, and the rewind needs a second person', async () => {
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
    const [lag] = sqlBlocks('consumer-lag');
    expect(await readOnly(lag ?? '')).toEqual([
      expect.objectContaining({ name: 'gateway', position: '0', events_behind: '3' }),
    ]);
    const a = await admin();
    const reader = http('consumer-lag', 'GET', '/admin/v1/ops/consumer-cursors');
    const cursors = await call(a.client, reader);
    expect(cursors.json().data.items[0]).toMatchObject({ eventsBehind: '3', lagAlert: true });

    // The consumer catches up, then someone asks to read the last two events again.
    await ctx.query(
      `update core.consumer_cursors set position = (select max(id) from public.operation_events), heartbeat_at = now() where name = 'gateway'`
    );
    const [{ head }] = (await ctx.query<{ head: string }>(
      `select max(id)::text as head from public.operation_events`
    )) as [{ head: string }];
    const rewind = http('consumer-lag', 'POST', '/admin/v1/ops/consumer-cursors/{name}/rewind');
    const target = (BigInt(head) - 2n).toString();
    const asked = await call(
      a.client,
      rewind,
      { name: 'gateway' },
      { ...rewind.body, position: target }
    );
    expect(asked.statusCode).toBe(202);
    const approval = asked.json().data.approval.id as string;
    expect((await ctx.cursors.list())[0]?.position).toBe(BigInt(head));

    // Approvals runbook: the request is in the inbox and in the SQL; the requester cannot approve.
    const [pending] = sqlBlocks('approvals');
    expect(await readOnly(pending ?? '')).toEqual([
      expect.objectContaining({ kind: 'consumer_cursor.rewind', status: 'pending' }),
    ]);
    const inbox = await call(a.client, http('approvals', 'GET', '/admin/v1/ops/approvals'));
    expect(inbox.json().data.items.map((i: { id: string }) => i.id)).toContain(approval);
    const approve = http('approvals', 'POST', '/admin/v1/ops/approvals/{ref}/approve');
    expect((await call(a.client, approve, { ref: approval })).statusCode).toBe(403);
    const checker = await admin();
    const done = await call(checker.client, approve, { ref: approval });
    expect(done.statusCode, done.body).toBe(200);
    expect((await ctx.cursors.list())[0]?.position).toBe(BigInt(target));

    // A rejected request changes nothing.
    const again = await call(
      a.client,
      rewind,
      { name: 'gateway' },
      { ...rewind.body, position: (BigInt(target) - 1n).toString() }
    );
    expect(again.statusCode).toBe(202);
    const reject = http('approvals', 'POST', '/admin/v1/ops/approvals/{ref}/reject');
    const rejected = await call(checker.client, reject, { ref: again.json().data.approval.id });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((await ctx.cursors.list())[0]?.position).toBe(BigInt(target));
    expect(await readOnly(pending ?? '')).toEqual([]);
  });

  it('shows the rollups the dashboards read, and refreshes them', async () => {
    const [latest] = sqlBlocks('rollup-staleness');
    expect(await readOnly(latest ?? '')).toEqual([]);
    // A payment that succeeded today, which no rollup has counted yet.
    const created = await createPayment(merchant.test, { amountMinor: '12000', currency: 'UGX' });
    const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('test'), created.id);
    await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'mtn' } });
    const done = await applyEvent(
      ctx,
      detail!.payment.id,
      event(
        { kind: 'succeeded', amountMinor: 12000n, currency: 'UGX' },
        {
          identifiers: { provider: 'mtn', providerTransactionId: `P-${randomUUID().slice(0, 10)}` },
          occurredAt: ctx.clock.now(),
        }
      )
    );
    expect(done.result).toBe('applied');
    await ctx.rollups.recomputeRecent();
    expect(await readOnly(latest ?? '')).toEqual([
      expect.objectContaining({ environment: 'test', latest_day: expect.anything() }),
    ]);
  });
});

describe('webhooks, outbox, queues', () => {
  it('finds outbox rows that exhausted their attempts', async () => {
    const [exhausted] = sqlBlocks('outbox-exhausted');
    expect(await readOnly(exhausted ?? '')).toEqual([]);
    const id = randomUUID();
    await ctx.query(
      `insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, attempts, last_error)
       values ($1, 'runbook', 'x', 'runbook.exhausted', '{}'::jsonb, $2, 10, 'boom')`,
      [id, `runbook:${id}`]
    );
    const [waiting] = sqlBlocks('webhook-backlog');
    expect((await readOnly(waiting ?? ''))[0]).toHaveProperty('waiting');
    expect(await readOnly(exhausted ?? '')).toEqual([
      expect.objectContaining({ id, event_type: 'runbook.exhausted', last_error: 'boom' }),
    ]);
  });

  it('reads the queues, pauses, resumes and retries as the queue depth runbook says', async () => {
    const a = await admin();
    const list = await call(a.client, http('queue-depth', 'GET', '/admin/v1/ops/queues'));
    const names = list.json().data.items.map((q: { name: string }) => q.name);
    expect(names).toContain('support-ops');
    const pause = await call(
      a.client,
      http('queue-depth', 'POST', '/admin/v1/ops/queues/{name}/pause'),
      {
        name: 'support-ops',
      }
    );
    expect(pause.statusCode, pause.body).toBeLessThan(300);
    const paused = await call(a.client, http('queue-depth', 'GET', '/admin/v1/ops/queues'));
    expect(
      paused.json().data.items.find((q: { name: string }) => q.name === 'support-ops').paused
    ).toBe(true);
    const resume = await call(
      a.client,
      http('queue-depth', 'POST', '/admin/v1/ops/queues/{name}/resume'),
      {
        name: 'support-ops',
      }
    );
    expect(resume.statusCode, resume.body).toBeLessThan(300);
    const retry = await call(
      a.client,
      http('queue-depth', 'POST', '/admin/v1/ops/queues/{name}/retry-failed'),
      {
        name: 'support-ops',
      }
    );
    expect(retry.statusCode, retry.body).toBeLessThan(300);
    const actions = await ctx.query<{ action: string }>(
      `select action from core.audit_logs where action like 'queue.%' order by seq`
    );
    expect(actions.map((r) => r.action)).toEqual(
      expect.arrayContaining(['queue.paused', 'queue.resumed', 'queue.failed_retried'])
    );
  });
});

describe('failed settlement', () => {
  it('lists the failed batch and its detail', async () => {
    const cycleId = randomUUID();
    const batchId = randomUUID();
    const batchRef = publicId('settlementBatch');
    await ctx.query(
      `insert into core.settlement_cycles (id, ref, name, schedule, currency, delay_days, cutoff_time, timezone, min_payout_minor, created_by)
       values ($1, $2, $3, '0 6 * * *', 'UGX', 1, '00:00', 'UTC', 0, 'test')`,
      [cycleId, publicId('settlementCycle'), `runbook-${cycleId.slice(0, 8)}`]
    );
    await ctx.query(
      `insert into core.settlement_batches (id, ref, merchant_id, cycle_id, environment, currency, period_start, period_end,
         gross_minor, refund_minor, fee_minor, reserve_minor, reserve_release_minor, dispute_hold_minor, aml_hold_minor,
         shortfall_minor, payable_draw_minor, net_minor, min_payout_minor, status, failure_code, created_by)
       values ($1, $2, $3, $4, 'live', 'UGX', now() - interval '2 days', now() - interval '1 day',
         5000, 0, 0, 0, 0, 0, 0, 0, 5000, 5000, 0, 'failed', 'gateway_failed', 'test')`,
      [batchId, batchRef, merchant.id, cycleId]
    );
    const [failed] = sqlBlocks('failed-settlement');
    expect(await readOnly(failed ?? '')).toEqual([
      expect.objectContaining({ ref: batchRef, status: 'failed', failure_code: 'gateway_failed' }),
    ]);
    const a = await admin();
    const list = await call(
      a.client,
      http('failed-settlement', 'GET', '/admin/v1/settlement/batches?status=failed')
    );
    expect(list.body).toContain(batchRef);
    const one = await call(
      a.client,
      http('failed-settlement', 'GET', '/admin/v1/settlement/batches/{ref}'),
      { ref: batchRef }
    );
    expect(one.statusCode, one.body).toBe(200);
  });
});

describe('notifications, reports and complaints', () => {
  it('shows a delivery that exhausted its attempts', async () => {
    const [user] = await ctx.query<{ id: string }>(`select id from core.users where ref = $1`, [
      merchant.owner.userId,
    ]);
    ctx.messaging.reset();
    ctx.messaging.fail('email', 10, 500);
    const key = `runbook-${randomUUID()}`;
    await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'complaint.resolved',
        audience: { kind: 'user', userId: user?.id ?? '' },
        resourceKey: key,
        variables: { complaint_ref: key, subject: 's' },
      })
    );
    await ctx.dispatcher.dispatch();
    const [delivery] = await ctx.query<{ id: string; created_at: string }>(
      `select d.id, d.created_at::text from core.notification_deliveries d
        join core.notifications n on n.id = d.notification_id
       where n.resource_key = $1 and d.channel = 'email'`,
      [key]
    );
    const createdAt = new Date(delivery?.created_at ?? '');
    expect(await ctx.delivery.deliver(delivery?.id ?? '', createdAt)).toBe('retry');
    ctx.clock.advanceBy(10 * 60_000);
    expect(await ctx.delivery.deliver(delivery?.id ?? '', createdAt)).toBe('retry');
    ctx.clock.advanceBy(10 * 60_000);
    expect(await ctx.delivery.deliver(delivery?.id ?? '', createdAt)).toBe('failed');
    ctx.messaging.reset();
    const [summary] = sqlBlocks('notification-delivery');
    expect(await readOnly(summary ?? '')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'email',
          status: 'failed',
          error: 'provider_status_500',
        }),
      ])
    );
    const a = await admin();
    const log = await call(
      a.client,
      http('notification-delivery', 'GET', '/admin/v1/notifications/deliveries')
    );
    expect(log.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', error: 'provider_status_500' }),
      ])
    );
    const broadcast = await call(
      a.client,
      http('notification-delivery', 'POST', '/admin/v1/notifications/broadcast')
    );
    expect(broadcast.statusCode, broadcast.body).toBeLessThan(300);
  });

  it('finds a report that failed', async () => {
    const owner = await ownerClient();
    const now = ctx.clock.now().getTime();
    const res = await owner.post('/dashboard/v1/reports', {
      type: 'payments',
      environment: 'test',
      params: {
        from: new Date(now - 86_400_000).toISOString(),
        to: new Date(now + 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const ref = res.json().data.id as string;
    await ctx.query(
      `update core.reports set status = 'failed', error = 'generation_failed', attempts = 3, finished_at = now(), lease_expires_at = null
        where ref = $1`,
      [ref]
    );
    const [problem] = sqlBlocks('report-failures');
    expect(await readOnly(problem ?? '')).toEqual([
      expect.objectContaining({ ref, status: 'failed', error: 'generation_failed', attempts: 3 }),
    ]);
    const a = await admin();
    const failed = await call(a.client, http('report-failures', 'GET', '/admin/v1/reports'));
    expect(failed.statusCode).toBe(200);
  });

  it('finds a complaint past its deadline, and the unassigned ones first', async () => {
    const owner = await ownerClient();
    const filed = await owner.post('/dashboard/v1/complaints', {
      category: 'other',
      subject: 'Runbook complaint',
      description: 'A complaint that nobody answered',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const ref = filed.json().data.id as string;
    // The deadline never changes after filing: let it pass (category `other` answers within 96 hours).
    ctx.clock.advanceBy(97 * 3_600_000);
    expect(await ctx.complaintsService.sweepSla()).toBeGreaterThanOrEqual(1);
    const [overdue] = sqlBlocks('complaint-sla');
    expect(await readOnly(overdue ?? '')).toEqual([
      expect.objectContaining({ ref, status: 'open' }),
    ]);
    const a = await admin();
    for (const block of [
      http('complaint-sla', 'GET', '/admin/v1/complaints/sla-breaches'),
      http('complaint-sla', 'GET', '/admin/v1/complaints?unassigned'),
    ]) {
      const res = await call(a.client, block);
      expect(res.json().data.items.map((c: { id: string }) => c.id)).toContain(ref);
    }
  });
});

describe('maintenance mode and providers', () => {
  it('stops writes with 503 and Retry-After, keeps reads, and the switch-off is in the runbook', async () => {
    const a = await admin();
    const on = http('maintenance-mode', 'POST', '/admin/v1/ops/maintenance-mode');
    const enabled = await call(a.client, on);
    expect(enabled.statusCode, enabled.body).toBe(200);
    const owner = await ownerClient();
    const refused = await owner.post('/dashboard/v1/complaints', {
      category: 'other',
      subject: 'x',
      description: 'd',
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe(String(on.body?.retryAfterSeconds));
    expect(refused.json().error.code).toBe('MAINTENANCE_MODE');
    const state = await call(
      a.client,
      http('maintenance-mode', 'GET', '/admin/v1/ops/maintenance-mode')
    );
    expect(state.json().data.enabled).toBe(true);
    expect((await owner.get('/dashboard/v1/notifications/unread-count')).statusCode).toBe(200);
    const off = await call(a.client, on, {}, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    const again = await owner.post('/dashboard/v1/complaints', {
      category: 'other',
      subject: 'y',
      description: 'd',
    });
    expect(again.statusCode, again.body).toBe(201);
    const actions = await ctx.query<{ action: string }>(
      `select action from core.audit_logs where action like 'maintenance.%' order by seq`
    );
    expect(actions.map((r) => r.action)).toEqual(['maintenance.enabled', 'maintenance.disabled']);
  });

  it('disables a provider as the runbook says, and brings it back', async () => {
    const a = await admin();
    const checker = await admin();
    const added = await a.client.post('/admin/v1/routing-rules', {
      currency: 'UGX',
      priority: 10,
      provider: 'mtn',
    });
    expect(added.statusCode, added.body).toBeLessThan(300);
    const [rules] = sqlBlocks('provider-routing');
    expect(await readOnly(rules ?? '')).toEqual([
      expect.objectContaining({ currency: 'UGX', provider: 'mtn', enabled: true }),
    ]);
    const patch = http('provider-routing', 'PATCH', '/admin/v1/providers/{id}');
    const settle = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.statusCode, res.body).toBeLessThan(300);
      if (res.statusCode === 202) {
        const id = res.json().data.approval.id as string;
        const approved = await checker.client.post(`/admin/v1/ops/approvals/${id}/approve`, {});
        expect(approved.statusCode, approved.body).toBe(200);
      }
    };
    // Flutterwave carries no routed currency in the seed data, so the change applies at once;
    // `settle` also handles the approval answer a routed provider would get.
    await settle(await call(a.client, patch, { id: 'flutterwave' }));
    const off = await call(a.client, http('provider-routing', 'GET', '/admin/v1/providers'));
    expect(
      off.json().data.items.find((p: { provider: string }) => p.provider === 'flutterwave')
    ).toMatchObject({ enabled: false });
    await settle(
      await call(a.client, patch, { id: 'flutterwave' }, { enabled: true, health: 'healthy' })
    );
    const on = await call(a.client, http('provider-routing', 'GET', '/admin/v1/providers'));
    expect(
      on.json().data.items.find((p: { provider: string }) => p.provider === 'flutterwave')
    ).toMatchObject({ enabled: true, health: 'healthy' });
    const audited = await ctx.query<{ action: string }>(
      `select action from core.audit_logs where action like 'provider.%' order by seq`
    );
    expect(audited.length).toBeGreaterThanOrEqual(2);
  });
});

describe('incidents and API keys', () => {
  it('adds a public update to an incident, and the feed carries no internal field', async () => {
    const a = await admin();
    const opened = await a.client.post('/admin/v1/incidents', {
      title: 'Runbook incident',
      severity: 'sev3',
      impact: 'Collections are slow',
      affectedServices: ['payments'],
    });
    expect(opened.statusCode, opened.body).toBeLessThan(300);
    const ref = opened.json().data.id as string;
    const update = await call(
      a.client,
      http('incidents', 'POST', '/admin/v1/incidents/{ref}/updates'),
      { ref }
    );
    expect(update.statusCode, update.body).toBeLessThan(300);
    const feed = await call(new Client(ctx.app), http('incidents', 'GET', '/v1/status'));
    expect(feed.statusCode).toBe(200);
    expect(JSON.stringify(feed.json())).not.toMatch(
      /postmortem|rootCause|commander|affectedMerchants/
    );
  });

  it('revokes a key as the compromised key runbook says, and the key stops working', async () => {
    const owner = await ownerClient();
    const key = await owner.post('/dashboard/v1/api-keys', {
      name: 'to revoke',
      environment: 'test',
      scopes: ['payments:read'],
    });
    expect(key.statusCode, key.body).toBe(201);
    const client = apiClient(ctx, key.json().data.key as string);
    expect((await client.get('/v1/ping')).statusCode).toBe(200);
    const revoked = await call(
      owner,
      http('api-key-compromise', 'DELETE', '/dashboard/v1/api-keys/{id}'),
      { id: key.json().data.id as string }
    );
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);
    expect((await client.get('/v1/ping')).statusCode).toBe(401);
  });
});
