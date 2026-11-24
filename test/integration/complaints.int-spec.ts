/**
 * Complaints (spec 6.14): merchant and customer complaints, category-driven SLA deadlines, the
 * message thread with internal-only notes, transaction association, assignment, escalation,
 * resolution, SLA breach detection with notifications, and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addTeamMember,
  loginMerchantUser,
  staffSession,
  type MerchantUser,
} from '../support/identity';
import { createPayment, createTestMerchant, type TestMerchant } from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

let ctx: SupportContext;
let merchant: TestMerchant;
let other: TestMerchant;
let viewer: MerchantUser;
let transactionRef: string;

beforeAll(async () => {
  ctx = await startSupportContext();
  merchant = await createTestMerchant(ctx, { label: 'complainer' });
  other = await createTestMerchant(ctx, { label: 'bystander' });
  viewer = await addTeamMember(ctx, merchant.owner, 'viewer');
  await createPayment(merchant.test, { amountMinor: '5000', currency: 'UGX' });
  transactionRef = (
    await ctx.query<{ ref: string }>(
      `select ref from core.transaction_keys where merchant_id = $1 limit 1`,
      [merchant.id]
    )
  )[0]!.ref;
});
afterAll(async () => {
  await ctx?.close();
});

const file = (user: MerchantUser, body: Record<string, unknown> = {}) =>
  user.client.post('/merchant/v1/complaints', {
    category: 'payment_issue',
    subject: 'Payment stuck',
    description: 'A customer paid and nothing happened.',
    ...body,
  });
const idOf = async (ref: string) =>
  (await ctx.query<{ id: string }>(`select id from core.users where ref = $1`, [ref]))[0]!.id;
const audit = (resourceId: string) =>
  ctx.query<{ action: string; outcome: string }>(
    `select action, outcome from core.audit_logs where resource_id = $1 order by seq`,
    [resourceId]
  );
const staffNotifications = async (staffRef: string, template: string, resource: string) =>
  ctx.query(
    `select 1 from core.notifications where recipient_id = $1 and template_code = $2 and resource_key = $3`,
    [await idOf(staffRef), template, resource]
  );

describe('filing a complaint', () => {
  it('sets the deadline from the category, tells support staff, and audits it', async () => {
    const agent = await staffSession(ctx, 'support_agent');
    const before = ctx.clock.now();
    const res = await file(merchant.owner, { transaction: transactionRef, priority: undefined });
    expect(res.statusCode).toBe(201);
    const c = res.json().data;
    expect(c).toMatchObject({
      category: 'payment_issue',
      status: 'open',
      priority: 'high',
      transaction: transactionRef,
      resolution: null,
    });
    // payment_issue is answered within 24 hours, in calendar time.
    expect(new Date(c.slaDueAt).getTime() - before.getTime()).toBe(24 * 3_600_000);
    expect(await staffNotifications(agent.admin.userId, 'complaint.created', c.id)).toHaveLength(1);
    expect((await audit(c.id)).map((a) => a.action)).toEqual(['complaint.created']);
    // The merchant's own listing and detail show it.
    const list = await merchant.owner.client.get('/merchant/v1/complaints');
    expect(list.json().data.items.map((i: { id: string }) => i.id)).toContain(c.id);
  });

  it('rejects an unknown category, a missing subject, and another merchant’s transaction', async () => {
    const unknown = await file(merchant.owner, { category: 'nonsense' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe('COMPLAINT_INVALID');
    expect((await file(merchant.owner, { subject: '' })).statusCode).toBe(400);
    const foreign = await ctx.query<{ ref: string }>(
      `select ref from core.transaction_keys where merchant_id <> $1 limit 1`,
      [merchant.id]
    );
    const stranger = await file(merchant.owner, { transaction: foreign[0]?.ref ?? 'txn_missing' });
    expect(stranger.statusCode).toBe(422);
    expect(stranger.json().error.details.reason).toBe('transaction_not_found');
  });

  it('needs the permission to file, though not to read', async () => {
    expect((await file(viewer)).statusCode).toBe(403);
    expect((await viewer.client.get('/merchant/v1/complaints')).statusCode).toBe(200);
    const categories = await viewer.client.get('/merchant/v1/complaints/categories');
    expect(categories.json().data.items.map((c: { code: string }) => c.code)).toContain(
      'unauthorized_transaction'
    );
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/merchant/v1/complaints',
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the thread and the work', () => {
  it('runs assign, reply, internal note, awaiting customer, escalation, resolution and close', async () => {
    const agent = await staffSession(ctx, 'support_agent');
    const lead = await staffSession(ctx, 'super_admin');
    const c = (await file(merchant.owner)).json().data;

    const assigned = await agent.client.post(`/admin/v1/complaints/${c.id}/assign`, {
      assignee: agent.admin.userId,
    });
    expect(assigned.json().data).toMatchObject({
      status: 'in_progress',
      assignee: agent.admin.userId,
    });

    const note = await agent.client.post(`/admin/v1/complaints/${c.id}/messages`, {
      body: 'INTERNAL: looks like a gateway timeout, ask ops',
      internal: true,
    });
    expect(note.statusCode).toBe(200);
    // The clock is fixed in tests: messages written in one millisecond have no order.
    ctx.clock.advanceBy(1000);
    const reply = await agent.client.post(`/admin/v1/complaints/${c.id}/messages`, {
      body: 'We are looking into it. Can you share the customer’s phone number?',
      awaitCustomer: true,
    });
    expect(reply.json().data.status).toBe('awaiting_customer');

    // The merchant sees the reply and never the internal note.
    const asMerchant = await merchant.owner.client.get(`/merchant/v1/complaints/${c.id}`);
    expect(asMerchant.json().data.messages.map((m: { body: string }) => m.body)).toEqual([
      'We are looking into it. Can you share the customer’s phone number?',
    ]);
    expect(asMerchant.body).not.toContain('INTERNAL');
    const asStaff = await agent.client.get(`/admin/v1/complaints/${c.id}`);
    expect(asStaff.json().data.messages).toHaveLength(2);
    expect(asStaff.json().data.messages[0]).toMatchObject({
      internal: true,
      author: agent.admin.userId,
    });

    // The merchant is told of the reply; the merchant answers and the complaint resumes.
    await ctx.pump();
    const owner = await idOf(merchant.owner.userId);
    const told = await ctx.query(
      `select 1 from core.notifications where recipient_id = $1 and template_code = 'complaint.message_received' and resource_key = $2`,
      [owner, c.id]
    );
    expect(told.length).toBeGreaterThanOrEqual(1);
    const answer = await merchant.owner.client.post(`/merchant/v1/complaints/${c.id}/messages`, {
      body: '+256700000009',
    });
    expect(answer.json().data.status).toBe('in_progress');
    const staffOnly = await merchant.owner.client.post(
      `/merchant/v1/complaints/${c.id}/messages`,
      {
        body: 'x',
        internal: true,
      }
    );
    expect(staffOnly.statusCode).toBe(400);

    const escalated = await agent.client.post(`/admin/v1/complaints/${c.id}/escalate`, {
      reason: 'Customer is a large merchant',
    });
    expect(escalated.json().data).toMatchObject({
      status: 'escalated',
      escalationReason: 'Customer is a large merchant',
    });
    // Required, so on both channels the template has.
    expect(await staffNotifications(lead.admin.userId, 'complaint.escalated', c.id)).toHaveLength(
      2
    );
    // An escalated complaint cannot be escalated again.
    expect(
      (await agent.client.post(`/admin/v1/complaints/${c.id}/escalate`, { reason: 'again' }))
        .statusCode
    ).toBe(409);

    const resolved = await lead.client.post(`/admin/v1/complaints/${c.id}/resolve`, {
      resolution: 'Refunded by hand.',
    });
    expect(resolved.json().data).toMatchObject({
      status: 'resolved',
      resolution: 'Refunded by hand.',
      breached: false,
    });
    const scored = await merchant.owner.client.post(`/merchant/v1/complaints/${c.id}/close`, {
      satisfactionScore: 5,
    });
    expect(scored.json().data).toMatchObject({ status: 'closed', satisfactionScore: 5 });

    // Closed is final.
    const late = await agent.client.post(`/admin/v1/complaints/${c.id}/messages`, {
      body: 'too late',
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('COMPLAINT_TRANSITION_INVALID');
    const actions = (await audit(c.id)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'complaint.created',
        'complaint.assigned',
        'complaint.message_added',
        'complaint.escalated',
        'complaint.resolved',
        'complaint.closed',
      ])
    );
  });

  it('keeps the SLA deadline and the status machine in the database too', async () => {
    const c = (await file(merchant.owner)).json().data;
    await expect(
      ctx.query(
        `update core.complaints set sla_due_at = sla_due_at + interval '1 day' where ref = $1`,
        [c.id]
      )
    ).rejects.toThrow(/never change/);
    await expect(
      ctx.query(`update core.complaints set status = 'resolved' where ref = $1`, [c.id])
    ).rejects.toThrow(/resolved_check/);
    await ctx.query(
      `update core.complaints set status = 'closed', closed_at = now() where ref = $1`,
      [c.id]
    );
    await expect(
      ctx.query(`update core.complaints set status = 'open', closed_at = null where ref = $1`, [
        c.id,
      ])
    ).rejects.toThrow(/final/);
    await expect(ctx.query(`update core.complaint_messages set body = 'x'`)).rejects.toThrow();
  });
});

describe('customer complaints and other merchants', () => {
  it('records a customer complaint with an encrypted contact, hidden from the merchant', async () => {
    const agent = await staffSession(ctx, 'support_agent');
    const res = await agent.client.post('/admin/v1/complaints', {
      source: 'customer',
      category: 'unauthorized_transaction',
      subject: 'I did not make this payment',
      description: 'Caller says the payment was not theirs.',
      transaction: transactionRef,
      customerContact: '+256700555123',
    });
    expect(res.statusCode).toBe(201);
    const c = res.json().data;
    // The complaint is about the merchant that took the payment; urgent by category.
    expect(c).toMatchObject({
      source: 'customer',
      merchant: merchant.ref,
      priority: 'urgent',
      hasCustomerContact: true,
    });
    expect(JSON.stringify(res.json())).not.toContain('555123');
    const stored = await ctx.query<{ customer_contact_enc: string }>(
      `select customer_contact_enc from core.complaints where ref = $1`,
      [c.id]
    );
    expect(stored[0]?.customer_contact_enc).not.toContain('555123');

    // Not in the merchant's list, and "not found" if asked for.
    expect((await merchant.owner.client.get(`/merchant/v1/complaints/${c.id}`)).statusCode).toBe(
      404
    );
    const merchantList = await merchant.owner.client.get('/merchant/v1/complaints?limit=100');
    expect(merchantList.json().data.items.map((i: { id: string }) => i.id)).not.toContain(c.id);
    expect(
      (await merchant.owner.client.post(`/merchant/v1/complaints/${c.id}/messages`, { body: 'x' }))
        .statusCode
    ).toBe(404);

    // Staff read the contact through its own audited route.
    const contact = await agent.client.get(`/admin/v1/complaints/${c.id}/contact`);
    expect(contact.json().data).toEqual({ contact: '+256700555123' });
    expect((await audit(c.id)).map((a) => a.action)).toContain('complaint.contact_viewed');
    // A read-only role cannot.
    const auditor = await staffSession(ctx, 'auditor');
    expect((await auditor.client.get(`/admin/v1/complaints/${c.id}/contact`)).statusCode).toBe(403);
    expect((await auditor.client.get(`/admin/v1/complaints/${c.id}`)).statusCode).toBe(200);
  });

  it('never lets one merchant read, answer or close another’s complaint', async () => {
    const c = (await file(merchant.owner)).json().data;
    for (const [method, path, body] of [
      ['get', `/merchant/v1/complaints/${c.id}`, undefined],
      ['post', `/merchant/v1/complaints/${c.id}/messages`, { body: 'hello' }],
      ['post', `/merchant/v1/complaints/${c.id}/close`, {}],
    ] as const) {
      const res = await other.owner.client[method](path, body);
      expect(res.statusCode).toBe(404);
    }
    const theirs = await other.owner.client.get('/merchant/v1/complaints?limit=100');
    expect(theirs.json().data.items.map((i: { id: string }) => i.id)).not.toContain(c.id);
  });

  it('enforces staff permissions on the queue', async () => {
    const compliance = await staffSession(ctx, 'compliance');
    expect((await compliance.client.get('/admin/v1/complaints')).statusCode).toBe(200);
    const denied = await compliance.client.post('/admin/v1/complaints/cmp_x/assign', {
      assignee: 'usr_x',
    });
    expect(denied.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/v1/complaints' })).statusCode).toBe(
      401
    );
  });
});

describe('SLA breach detection', () => {
  it('marks an overdue complaint breached once, queues it, and notifies staff once', async () => {
    const agent = await staffSession(ctx, 'support_agent');
    const lead = await staffSession(ctx, 'super_admin');
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = (await file(merchant.owner, { category: 'unauthorized_transaction' })).json().data;
    expect(new Date(c.slaDueAt).getTime() - ctx.clock.now().getTime()).toBe(8 * 3_600_000);

    const breachedNow = async () =>
      (
        await ctx.query<{ breached: boolean }>(
          `select breached from core.complaints where ref = $1`,
          [c.id]
        )
      )[0]!.breached;
    ctx.clock.advanceBy(8 * 3_600_000 - 1000);
    await ctx.complaintsService.sweepSla();
    expect(await breachedNow()).toBe(false);
    ctx.clock.advanceBy(2000);
    // Two sweeps at once, as two workers would run: one breach, one notification.
    await Promise.all([ctx.complaintsService.sweepSla(), ctx.complaintsService.sweepSla()]);
    expect(await breachedNow()).toBe(true);
    await ctx.complaintsService.sweepSla();

    const row = await ctx.query<{
      breached: boolean;
      breached_at: Date;
      breach_notified_at: Date | null;
    }>(`select breached, breached_at, breach_notified_at from core.complaints where ref = $1`, [
      c.id,
    ]);
    expect(row[0]?.breached).toBe(true);
    expect(row[0]?.breached_at.toISOString()).toBe(c.slaDueAt);
    expect(row[0]?.breach_notified_at).not.toBeNull();

    const fresh = await staffSession(ctx, 'support_agent');
    const queue = await fresh.client.get('/admin/v1/complaints/sla-breaches');
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.items.map((i: { id: string }) => i.id)).toContain(c.id);
    expect(queue.json().data.items.find((i: { id: string }) => i.id === c.id)).toMatchObject({
      breached: true,
    });

    // Staff are told once on each channel they have, and the notification is required.
    const told = await ctx.query<{ channel: string }>(
      `select channel from core.notifications where recipient_id = $1 and template_code = 'complaint.sla_breached' and resource_key = $2`,
      [await idOf(agent.admin.userId), c.id]
    );
    expect(told.map((t) => t.channel).sort()).toEqual(['email', 'in_app']);
    expect(
      await staffNotifications(lead.admin.userId, 'complaint.sla_breached', c.id)
    ).toHaveLength(2);
    expect((await audit(c.id)).filter((a) => a.action === 'complaint.sla_breached')).toHaveLength(
      1
    );

    // Resolving it takes it off the queue, but the breach stays on record.
    const resolver = await staffSession(ctx, 'support_agent');
    await resolver.client.post(`/admin/v1/complaints/${c.id}/resolve`, {
      resolution: 'Late, but done.',
    });
    const after = await resolver.client.get('/admin/v1/complaints/sla-breaches?limit=200');
    expect(after.json().data.items.map((i: { id: string }) => i.id)).not.toContain(c.id);
    expect((await resolver.client.get(`/admin/v1/complaints/${c.id}`)).json().data).toMatchObject({
      status: 'resolved',
      breached: true,
    });
  });

  it('counts a complaint resolved after its deadline as breached, even before a sweep saw it', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = (await file(merchant.owner)).json().data;
    ctx.clock.advanceBy(25 * 3_600_000);
    const agent = await staffSession(ctx, 'support_agent');
    const res = await agent.client.post(`/admin/v1/complaints/${c.id}/resolve`, {
      resolution: 'Done',
    });
    expect(res.json().data).toMatchObject({ status: 'resolved', breached: true });
  });

  it('does not breach a complaint resolved in time', async () => {
    await loginMerchantUser(merchant.owner.client, merchant.owner.email, merchant.owner.merchantId);
    const c = (await file(merchant.owner)).json().data;
    const agent = await staffSession(ctx, 'support_agent');
    await agent.client.post(`/admin/v1/complaints/${c.id}/resolve`, { resolution: 'Quick' });
    ctx.clock.advanceBy(48 * 3_600_000);
    await ctx.complaintsService.sweepSla();
    const row = await ctx.query<{ breached: boolean }>(
      `select breached from core.complaints where ref = $1`,
      [c.id]
    );
    expect(row[0]?.breached).toBe(false);
  });
});
