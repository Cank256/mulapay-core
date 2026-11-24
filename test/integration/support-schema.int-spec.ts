/**
 * The database enforces the support and operations rules on its own (migration 0008): fixed
 * identities, final states, append-only history, the requester never deciding their own
 * request, and the grants. Each test tries to break one rule as the application's own database
 * role, bypassing the services, and expects Postgres to refuse.
 */
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { staffSession } from '../support/identity';
import { createTestMerchant, type TestMerchant } from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

let ctx: SupportContext;
let rw: PgClient;
let merchant: TestMerchant;

beforeAll(async () => {
  ctx = await startSupportContext({ overrides: { OPS_FLAG_CHANGE_APPROVAL: 'always' } });
  merchant = await createTestMerchant(ctx, { label: 'support-schema' });
  rw = new PgClient({ connectionString: inject('databaseUrls').rw });
  await rw.connect();
});
afterAll(async () => {
  await rw?.end();
  await ctx?.close();
});

type Step = readonly [text: string, values?: unknown[]];
/**
 * Runs the steps in one transaction as the application role and returns the Postgres error
 * code of the first one that fails, or `ok`. The transaction is always rolled back.
 */
async function codeOf(...steps: Step[]): Promise<string> {
  try {
    await rw.query('begin');
    for (const [text, values] of steps) await rw.query(text, values ?? []);
    await rw.query('rollback');
    return 'ok';
  } catch (error) {
    await rw.query('rollback').catch(() => undefined);
    return (error as { code?: string }).code ?? 'unknown';
  }
}
const CHECK = '23514';
const DENIED = '42501';

const one = async <T>(text: string, values: unknown[] = []) =>
  (await ctx.query<T>(text, values))[0] as T;

describe('complaints', () => {
  it('keeps what a complaint is about and its deadline fixed, and closes for good', async () => {
    const filed = await merchant.owner.client.post('/merchant/v1/complaints', {
      category: 'other',
      subject: 'Schema complaint',
      description: 'd',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const ref = filed.json().data.id as string;
    const set = (sql: string): Step => [`update core.complaints set ${sql} where ref = $1`, [ref]];
    expect(await codeOf(set(`sla_due_at = sla_due_at + interval '1 day'`))).toBe(CHECK);
    expect(await codeOf(set(`subject = 'changed'`))).toBe(CHECK);
    expect(await codeOf(set(`merchant_id = '${randomUUID()}'`))).toBe(CHECK);
    expect(await codeOf(set(`status = 'nonsense'`))).toBe(CHECK);
    // open -> resolved -> closed is the legal path; nothing leaves closed; resolved only closes.
    const resolved = set(`status = 'resolved', resolved_at = now()`);
    const closed = set(`status = 'closed', closed_at = now()`);
    expect(await codeOf(resolved, closed)).toBe('ok');
    expect(await codeOf(closed, set(`status = 'open'`))).toBe(CHECK);
    expect(await codeOf(resolved, set(`status = 'in_progress'`))).toBe(CHECK);
    expect(await codeOf(set(`status = 'resolved'`))).toBe(CHECK); // no resolution time
    expect(
      await codeOf(
        set(`breached = true, breached_at = now()`),
        set(`breached = false, breached_at = null`)
      )
    ).toBe(CHECK);
  });

  it('never changes a message once written', async () => {
    const filed = await merchant.owner.client.post('/merchant/v1/complaints', {
      category: 'other',
      subject: 'Thread',
      description: 'first message',
    });
    const ref = filed.json().data.id as string;
    const reply = await merchant.owner.client.post(`/merchant/v1/complaints/${ref}/messages`, {
      body: 'a reply',
    });
    expect(reply.statusCode, reply.body).toBeLessThan(300);
    const message = await one<{ id: string }>(
      `select m.id from core.complaint_messages m join core.complaints c on c.id = m.complaint_id where c.ref = $1`,
      [ref]
    );
    expect(
      await codeOf([`update core.complaint_messages set body = 'x' where id = $1`, [message.id]])
    ).not.toBe('ok');
    expect(
      await codeOf([`delete from core.complaint_messages where id = $1`, [message.id]])
    ).not.toBe('ok');
    expect(await codeOf([`truncate core.complaint_messages`])).not.toBe('ok');
  });
});

describe('reports', () => {
  it('keeps a report what it was asked to be, and moves it along its states only', async () => {
    const now = Date.now();
    const res = await merchant.owner.client.post('/merchant/v1/reports', {
      type: 'payments',
      environment: 'test',
      params: {
        from: new Date(now - 86_400_000).toISOString(),
        to: new Date(now + 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const ref = res.json().data.id as string;
    const set = (sql: string): Step => [`update core.reports set ${sql} where ref = $1`, [ref]];
    expect(await codeOf(set(`type = 'fees'`))).toBe(CHECK);
    expect(await codeOf(set(`params = '{}'::jsonb`))).toBe(CHECK);
    expect(await codeOf(set(`status = 'ready'`))).toBe(CHECK); // queued -> ready skips running
    expect(await codeOf(set(`status = 'running'`), set(`status = 'queued'`))).toBe('ok'); // a lapsed lease
    expect(await codeOf(set(`status = 'failed'`), set(`status = 'queued'`))).toBe(CHECK);
    expect(await codeOf(set(`status = 'failed'`), set(`status = 'running'`))).toBe(CHECK);
    // A ready or expired report has its file and counts; a queued one has none.
    expect(
      await codeOf(set(`status = 'running'`), set(`status = 'ready'`)) // no file columns
    ).toBe(CHECK);
    expect(await codeOf(set(`attempts = 2`), set(`attempts = 1`))).toBe(CHECK);
    expect(await codeOf([`delete from core.reports where ref = $1`, [ref]])).toBe(DENIED);
  });
});

describe('approvals', () => {
  it('fixes the request, finalises the decision, and never lets the requester decide', async () => {
    const staff = await staffSession(ctx, 'super_admin');
    const flag = `schema.flag_${randomUUID().slice(0, 8)}`;
    const created = await staff.client.post('/admin/v1/ops/feature-flags', {
      key: flag,
      description: 'schema test',
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const asked = await staff.client.patch(`/admin/v1/ops/feature-flags/${flag}`, {
      enabled: true,
      reason: 'schema test',
    });
    expect(asked.statusCode, asked.body).toBe(202);
    const ref = asked.json().data.approval.id as string;
    const approval = await one<{ id: string; requested_by: string }>(
      `select id, requested_by from core.approvals where ref = $1`,
      [ref]
    );
    const set = (sql: string): Step => [`update core.approvals set ${sql} where ref = $1`, [ref]];
    expect(await codeOf(set(`payload = '{}'::jsonb`))).toBe(CHECK);
    expect(await codeOf(set(`requested_by = '${randomUUID()}'`))).not.toBe('ok');
    expect(await codeOf(set(`status = 'approved'`))).toBe(CHECK); // decided_at is required
    expect(await codeOf(set(`status = 'approved', decided_at = now()`))).toBe('ok');
    expect(
      await codeOf(
        set(`status = 'rejected', decided_at = now()`),
        set(`status = 'approved', decided_at = now()`)
      )
    ).toBe(CHECK);
    // The requester is never the decider, even when the service is bypassed.
    expect(
      await codeOf([
        `insert into core.approval_decisions (id, approval_id, approver_id, decision, decided_at)
         values ($1, $2, $3, 'approve', now())`,
        [randomUUID(), approval.id, approval.requested_by],
      ])
    ).toBe(CHECK);
    const other = await one<{ id: string }>(`select id from core.users where id <> $1 limit 1`, [
      approval.requested_by,
    ]);
    const decision = randomUUID();
    expect(
      await codeOf(
        [
          `insert into core.approval_decisions (id, approval_id, approver_id, decision, decided_at)
           values ($1, $2, $3, 'approve', now())`,
          [decision, approval.id, other.id],
        ],
        [`update core.approval_decisions set decision = 'reject' where id = $1`, [decision]]
      )
    ).not.toBe('ok');
  });
});

describe('notifications', () => {
  it('only ever marks a notification read, once, and never changes a delivery’s identity or retries a final one', async () => {
    const owner = await one<{ id: string }>(`select id from core.users where ref = $1`, [
      merchant.owner.userId,
    ]);
    const key = `schema-${randomUUID()}`;
    await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'complaint.resolved',
        audience: { kind: 'user', userId: owner.id },
        resourceKey: key,
        variables: { complaint_ref: key, subject: 's' },
      })
    );
    await ctx.dispatcher.dispatch();
    const notification = await one<{ id: string }>(
      `select id from core.notifications where recipient_id = $1 and resource_key = $2 and channel = 'in_app'`,
      [owner.id, key]
    );
    const nset = (sql: string): Step => [
      `update core.notifications set ${sql} where id = $1`,
      [notification.id],
    ];
    // The application role may write `read_at` only; the guard also stops anyone with wider rights.
    expect(await codeOf(nset(`title = 'changed'`))).toBe(DENIED);
    expect(await codeOf(nset(`recipient_id = '${randomUUID()}'`))).toBe(DENIED);
    expect(await codeOf(nset(`read_at = now()`))).toBe('ok');
    expect(await codeOf(nset(`read_at = now()`), nset(`read_at = now() + interval '1 hour'`))).toBe(
      CHECK
    );

    const delivery = await one<{ id: string; created_at: string }>(
      `select d.id, d.created_at::text from core.notification_deliveries d
        join core.notifications n on n.id = d.notification_id
       where n.resource_key = $1 and d.channel = 'email'`,
      [key]
    );
    const dset = (sql: string): Step => [
      `update core.notification_deliveries set ${sql} where id = $1 and created_at = $2`,
      [delivery.id, delivery.created_at],
    ];
    expect([CHECK, DENIED]).toContain(await codeOf(dset(`channel = 'sms'`)));
    expect([CHECK, DENIED]).toContain(await codeOf(dset(`template_code = 'other'`)));
    expect(await codeOf(dset(`status = 'failed'`), dset(`status = 'pending'`))).toBe(CHECK);
    expect(await codeOf(dset(`status = 'sent'`), dset(`status = 'failed'`))).toBe(CHECK);
    expect(await codeOf(dset(`status = 'sent'`), dset(`status = 'delivered'`))).toBe('ok');
    expect(await codeOf(dset(`attempts = 2`), dset(`attempts = 1`))).toBe(CHECK);
    expect(
      await codeOf([`delete from core.notification_deliveries where id = $1`, [delivery.id]])
    ).toBe(DENIED);
  });
});

describe('incidents and disputes', () => {
  it('keeps the timeline append-only and a public incident worded', async () => {
    const staff = await staffSession(ctx, 'super_admin');
    const opened = await staff.client.post('/admin/v1/incidents', {
      title: 'Schema incident',
      severity: 'sev3',
      impact: 'None',
      affectedServices: ['payments'],
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const ref = opened.json().data.id as string;
    const update = await one<{ id: string }>(
      `select u.id from core.incident_updates u join core.incidents i on i.id = u.incident_id where i.ref = $1 limit 1`,
      [ref]
    );
    expect(
      await codeOf([`update core.incident_updates set body = 'x' where id = $1`, [update.id]])
    ).not.toBe('ok');
    expect(await codeOf([`delete from core.incident_updates where id = $1`, [update.id]])).not.toBe(
      'ok'
    );
    expect(
      await codeOf([
        `update core.incidents set public = true, public_message = null where ref = $1`,
        [ref],
      ])
    ).toBe(CHECK);
    expect(
      await codeOf([
        `update core.incidents set public = true, public_message = 'Payments are slow' where ref = $1`,
        [ref],
      ])
    ).toBe('ok');
    const post = await staff.client.post(`/admin/v1/incidents/${ref}/postmortem`, {
      summary: 's',
      rootCause: 'r',
    });
    expect(post.statusCode, post.body).toBeLessThan(300);
    expect(
      await codeOf([
        `update core.incident_postmortems set incident_id = $2 where incident_id = (select id from core.incidents where ref = $1)`,
        [ref, randomUUID()],
      ])
    ).not.toBe('ok');
  });

  it('keeps dispute notes append-only', async () => {
    expect(await codeOf([`update core.dispute_notes set body = 'x'`])).not.toBe('ok');
    expect(await codeOf([`delete from core.dispute_notes`])).not.toBe('ok');
    expect(await codeOf([`truncate core.dispute_notes`])).not.toBe('ok');
  });
});
