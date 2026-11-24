/**
 * Disputes on the support surface (spec 6.14, Phase 8): the dispute queue with investigators,
 * append-only investigation notes, evidence deadlines tracked and warned about, and resolution
 * through the financial services (a lost dispute still posts to the ledger, a won one releases
 * the hold) with the merchant told by notification.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffSession } from '../support/identity';
import {
  balanceOf,
  DISPUTE_CURRENCY as CUR,
  entryLines,
  merchantWithPayment,
  openDispute,
} from '../support/disputes';
import { startSupportContext, type SupportContext } from '../support/support-ops';

let ctx: SupportContext;

beforeAll(async () => {
  ctx = await startSupportContext();
});
afterAll(async () => {
  await ctx?.close();
});

const idOf = async (ref: string) =>
  (await ctx.query<{ id: string }>(`select id from core.users where ref = $1`, [ref]))[0]!.id;
const notificationsOf = async (staffRef: string, template: string, resource: string) =>
  ctx.query<{ channel: string }>(
    `select channel from core.notifications where recipient_id = $1 and template_code = $2 and resource_key = $3`,
    [await idOf(staffRef), template, resource]
  );

describe('investigators and notes', () => {
  it('assigns a dispute, tells the investigator, and filters the queue by assignee', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const ops = await staffSession(ctx, 'operations');
    const investigator = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(ops, merchant, txnRef, '40000')).json().data;
    expect(dispute.assignee).toBeNull();

    const assigned = await ops.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
      assignee: investigator.admin.userId,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().data).toMatchObject({
      assignee: investigator.admin.userId,
      status: 'open',
    });
    expect(
      await notificationsOf(investigator.admin.userId, 'dispute.assigned', dispute.id)
    ).toHaveLength(1);

    const mine = await ops.client.get(
      `/admin/v1/disputes?assignee=${investigator.admin.userId}&limit=200`
    );
    expect(mine.json().data.items.map((d: { id: string }) => d.id)).toContain(dispute.id);
    const unassigned = await ops.client.get('/admin/v1/disputes?unassigned=true&limit=200');
    expect(unassigned.json().data.items.map((d: { id: string }) => d.id)).not.toContain(dispute.id);

    // Only staff can investigate: a merchant user's ref is "not found", and a read-only role is refused.
    const merchantUserRef = merchant.owner.userId;
    expect(
      (
        await ops.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
          assignee: merchantUserRef,
        })
      ).statusCode
    ).toBe(404);
    const auditor = await staffSession(ctx, 'auditor');
    expect(
      (
        await auditor.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
          assignee: investigator.admin.userId,
        })
      ).statusCode
    ).toBe(403);
    const actions = await ctx.query<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [dispute.id]
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['dispute.created', 'dispute.assigned'])
    );
  });

  it('records append-only notes the merchant never sees', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '10000')).json().data;
    const first = await staff.client.post(`/admin/v1/disputes/${dispute.id}/notes`, {
      body: 'Called the scheme, ref 7781.',
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({
      author: staff.admin.userId,
      body: 'Called the scheme, ref 7781.',
    });
    ctx.clock.advanceBy(1000);
    await staff.client.post(`/admin/v1/disputes/${dispute.id}/notes`, {
      body: 'Scheme wants the receipt.',
    });
    const notes = await staff.client.get(`/admin/v1/disputes/${dispute.id}/notes`);
    expect(notes.json().data.items.map((n: { body: string }) => n.body)).toEqual([
      'Called the scheme, ref 7781.',
      'Scheme wants the receipt.',
    ]);
    const asMerchant = await merchant.owner.client.get(`/merchant/v1/disputes/${dispute.id}`);
    expect(asMerchant.statusCode).toBe(200);
    expect(asMerchant.body).not.toContain('scheme');
    await expect(ctx.query(`update core.dispute_notes set body = 'edited'`)).rejects.toThrow();
    await expect(ctx.query(`delete from core.dispute_notes`)).rejects.toThrow();
    const agent = await staffSession(ctx, 'support_agent');
    expect(
      (await agent.client.post(`/admin/v1/disputes/${dispute.id}/notes`, { body: 'x' })).statusCode
    ).toBe(403);
  });
});

describe('evidence deadlines', () => {
  it('warns before the deadline and when it passes, once each, and filters the queue by deadline', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'operations');
    const investigator = await staffSession(ctx, 'compliance');
    const due = new Date(ctx.clock.now().getTime() + 24 * 3_600_000);
    const dispute = (
      await openDispute(staff, merchant, txnRef, '20000', { evidenceDueAt: due.toISOString() })
    ).json().data;
    await staff.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
      assignee: investigator.admin.userId,
    });

    // 24 hours away is inside the 48 hour warning window.
    const fresh = await staffSession(ctx, 'operations');
    const soon = await fresh.client.get('/admin/v1/disputes?deadline=due_soon&limit=200');
    expect(soon.json().data.items.map((d: { id: string }) => d.id)).toContain(dispute.id);
    const overdueBefore = await fresh.client.get('/admin/v1/disputes?deadline=overdue&limit=200');
    expect(overdueBefore.json().data.items.map((d: { id: string }) => d.id)).not.toContain(
      dispute.id
    );

    await ctx.disputesService.sweepDeadlines();
    await ctx.disputesService.sweepDeadlines();
    expect(
      await notificationsOf(investigator.admin.userId, 'dispute.deadline_due_soon', dispute.id)
    ).toHaveLength(2);
    expect(
      await notificationsOf(investigator.admin.userId, 'dispute.deadline_overdue', dispute.id)
    ).toHaveLength(0);

    ctx.clock.advanceBy(25 * 3_600_000);
    await Promise.all([ctx.disputesService.sweepDeadlines(), ctx.disputesService.sweepDeadlines()]);
    await ctx.disputesService.sweepDeadlines();
    // Required notifications go on both channels, once.
    expect(
      await notificationsOf(investigator.admin.userId, 'dispute.deadline_overdue', dispute.id)
    ).toHaveLength(2);
    expect(
      await notificationsOf(investigator.admin.userId, 'dispute.deadline_due_soon', dispute.id)
    ).toHaveLength(2);
    const later = await staffSession(ctx, 'operations');
    const overdue = await later.client.get('/admin/v1/disputes?deadline=overdue&limit=200');
    expect(overdue.json().data.items.map((d: { id: string }) => d.id)).toContain(dispute.id);

    // Resolving takes it out of the deadline queue.
    const resolver = await staffSession(ctx, 'super_admin');
    const done = await resolver.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'withdrawn',
      note: 'Scheme withdrew',
    });
    expect(done.statusCode).toBe(200);
    const after = await later.client.get('/admin/v1/disputes?deadline=overdue&limit=200');
    expect(after.json().data.items.map((d: { id: string }) => d.id)).not.toContain(dispute.id);
  });

  it('warns the whole dispute team when nobody is assigned', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'operations');
    const peer = await staffSession(ctx, 'compliance');
    const due = new Date(ctx.clock.now().getTime() + 3_600_000);
    const dispute = (
      await openDispute(staff, merchant, txnRef, '5000', { evidenceDueAt: due.toISOString() })
    ).json().data;
    await ctx.disputesService.sweepDeadlines();
    expect(
      await notificationsOf(peer.admin.userId, 'dispute.deadline_due_soon', dispute.id)
    ).toHaveLength(2);
  });
});

describe('resolution still goes through the financial services', () => {
  it('captures the hold and posts to the ledger for a lost dispute, then tells the merchant', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 100_000n);
    const staff = await staffSession(ctx, 'super_admin');
    const dispute = (await openDispute(staff, merchant, txnRef, '100000')).json().data;
    await staff.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
      assignee: staff.admin.userId,
    });
    expect((await balanceOf(ctx, merchant)).availableMinor).toBe(0n);

    const lost = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'Scheme ruled for the cardholder',
    });
    expect(lost.statusCode).toBe(200);
    const entry = lost.json().data.resolutionEntry as string;
    const lines = await entryLines(entry);
    const debit = lines
      .filter((l) => l.direction === 'debit')
      .reduce((n, l) => n + BigInt(l.amount_minor), 0n);
    const credit = lines
      .filter((l) => l.direction === 'credit')
      .reduce((n, l) => n + BigInt(l.amount_minor), 0n);
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0n);
    expect((await balanceOf(ctx, merchant)).postedMinor).toBe(0n);

    // A resolved dispute can no longer be assigned, but may still take a note.
    expect(
      (
        await staff.client.post(`/admin/v1/disputes/${dispute.id}/assign`, {
          assignee: staff.admin.userId,
        })
      ).statusCode
    ).toBe(409);
    expect(
      (await staff.client.post(`/admin/v1/disputes/${dispute.id}/notes`, { body: 'Closed out.' }))
        .statusCode
    ).toBe(201);

    await ctx.pump();
    const told = await ctx.query<{ template_code: string }>(
      `select template_code from core.notifications where recipient_id = $1 and resource_key = $2 and channel = 'in_app'`,
      [await idOf(merchant.owner.userId), dispute.id]
    );
    expect(told.map((t) => t.template_code).sort()).toEqual([
      'dispute.created',
      'dispute.resolved',
    ]);
    expect(CUR).toBe('XOF');
  });
});
