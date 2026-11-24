/**
 * Disputes and chargebacks, opening and investigation (spec 6.14): opening a dispute holds the
 * disputed amount and tells the merchant; the merchant answers with evidence until the due
 * date; staff move it into review. Live money in XOF.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addTeamMember, loginMerchantUser, staffSession } from '../support/identity';
import { sql } from '../support/payments';
import {
  activeMerchant,
  startComplianceContext,
  type ComplianceContext,
} from '../support/compliance';
import {
  auditActionsOf,
  balanceOf,
  DISPUTE_CURRENCY as CUR,
  entryCount,
  merchantEventTypes,
  merchantWithPayment,
  openDispute,
} from '../support/disputes';

let ctx: ComplianceContext;
beforeAll(async () => {
  ctx = await startComplianceContext();
});
afterAll(async () => {
  await ctx?.close();
});

const reserve = (merchantId: string, amountMinor: bigint) =>
  ctx.unitOfWork.run((tx) =>
    ctx.holds.place(tx, {
      merchantId,
      environment: 'live',
      currency: CUR,
      amountMinor,
      reason: 'payout reserve',
      idempotencyKey: `t:${randomUUID()}`,
      createdBy: 'system:test',
    })
  );

describe('opening a dispute', () => {
  it('holds the disputed amount on the merchant balance and tells the merchant', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    expect((await balanceOf(ctx, merchant)).availableMinor).toBe(100_000n);
    const entriesBefore = await entryCount(merchant.id);

    const res = await openDispute(staff, merchant, txnRef, '100000', {
      evidenceDueAt: new Date(ctx.clock.now().getTime() + 7 * 86_400_000).toISOString(),
      internalNote: 'Scheme notice 2025-03-02',
    });
    expect(res.statusCode).toBe(201);
    const dispute = res.json().data;
    expect(dispute).toMatchObject({
      status: 'open',
      kind: 'chargeback',
      amountMinor: '100000',
      currency: CUR,
      transaction: txnRef,
      merchant: merchant.ref,
      heldMinor: '100000',
      shortfallMinor: '0',
      outcome: null,
      internalNote: 'Scheme notice 2025-03-02',
    });

    const balance = await balanceOf(ctx, merchant);
    expect(balance.heldMinor).toBe(100_000n);
    expect(balance.availableMinor).toBe(0n);
    expect(balance.postedMinor).toBe(100_000n);
    const holds = await sql<{ reason: string; state: string; amount_minor: string }>(
      'select reason, state, amount_minor::text from core.holds where merchant_id = $1',
      [merchant.id]
    );
    expect(holds).toEqual([
      { reason: `dispute:${dispute.id}`, state: 'active', amount_minor: '100000' },
    ]);
    // Holding moves no money in the ledger.
    expect(await entryCount(merchant.id)).toBe(entriesBefore);
    expect(await merchantEventTypes(merchant.id)).toEqual(
      expect.arrayContaining(['dispute.created', 'hold.created'])
    );
    expect(await auditActionsOf(dispute.id)).toEqual(['dispute.created']);

    // The merchant sees the dispute, not the staff's note or the hold.
    const owner = merchant.owner.client;
    const seen = await owner.get(`/merchant/v1/disputes/${dispute.id}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().data).toMatchObject({
      id: dispute.id,
      status: 'open',
      amountMinor: '100000',
    });
    expect(JSON.stringify(seen.json())).not.toContain('Scheme notice');
    expect(seen.json().data.heldMinor).toBeUndefined();
    const list = (await owner.get('/merchant/v1/disputes')).json().data;
    expect(list.items.map((d: { id: string }) => d.id)).toEqual([dispute.id]);
  });

  it('holds what is available and records the rest as the shortfall', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    await reserve(merchant.id, 80_000n); // already reserved for something else
    const res = await openDispute(staff, merchant, txnRef, '100000');
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ heldMinor: '20000', shortfallMinor: '80000' });
    expect((await balanceOf(ctx, merchant)).availableMinor).toBe(0n);

    // With nothing available the dispute is still recorded, with nothing held.
    const second = await merchantWithPayment(ctx, 10_000n);
    await reserve(second.merchant.id, 10_000n);
    const none = await openDispute(staff, second.merchant, second.txnRef, '10000');
    expect(none.json().data).toMatchObject({ heldMinor: '0', shortfallMinor: '10000' });
  });

  it('refuses what cannot be disputed, and a second dispute on the same payment', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 50_000n);
    const staff = await staffSession(ctx, 'compliance');
    const reasonOf = (r: { json(): { error?: { details?: { reason?: string } } } }) =>
      r.json().error?.details?.reason;

    expect(reasonOf(await openDispute(staff, merchant, txnRef, '50001'))).toBe(
      'amount_exceeds_payment'
    );
    expect((await openDispute(staff, merchant, txnRef, '0')).statusCode).toBe(400);
    expect(
      (await openDispute(staff, merchant, 'txn_00000000000000000000000000', '100')).statusCode
    ).toBe(404);

    // Another merchant's payment, and a payment that has not succeeded.
    const other = await merchantWithPayment(ctx, 5_000n);
    expect(reasonOf(await openDispute(staff, merchant, other.txnRef, '1000'))).toBe(
      'transaction_not_found'
    );
    const pending = await merchant.live!.post(
      '/v1/payments',
      {
        amountMinor: '1000',
        currency: CUR,
        paymentMethod: { provider: 'mtn', msisdn: '+256700000099' },
      },
      { 'idempotency-key': `i-${randomUUID()}` }
    );
    const [pendingTxn] = await sql<{ ref: string }>(
      `select k.ref from core.transaction_keys k join core.payments p on p.transaction_id = k.id where p.ref = $1`,
      [pending.json().data.id]
    );
    expect(reasonOf(await openDispute(staff, merchant, pendingTxn?.ref as string, '500'))).toBe(
      'payment_not_succeeded'
    );

    expect((await openDispute(staff, merchant, txnRef, '20000')).statusCode).toBe(201);
    expect(reasonOf(await openDispute(staff, merchant, txnRef, '10000'))).toBe('already_disputed');
    expect(
      await sql('select 1 from core.disputes where merchant_id = $1', [merchant.id])
    ).toHaveLength(1);
  });

  it('keeps recording to staff with the permission', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 20_000n);
    const support = await staffSession(ctx, 'support_agent');
    expect((await openDispute(support, merchant, txnRef, '1000')).statusCode).toBe(403);
    expect((await support.client.get('/admin/v1/disputes')).statusCode).toBe(200);
    const operations = await staffSession(ctx, 'operations');
    expect((await openDispute(operations, merchant, txnRef, '1000')).statusCode).toBe(201);
    const pending = (
      await operations.client.get(`/admin/v1/disputes?merchant=${merchant.ref}`)
    ).json().data;
    expect(pending.items).toHaveLength(1);
  });
});

describe('investigation and evidence', () => {
  it('moves into review, lets the merchant respond until the due date, and refuses afterwards', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 30_000n);
    const staff = await staffSession(ctx, 'compliance');
    const dueAt = new Date(ctx.clock.now().getTime() + 86_400_000);
    const dispute = (
      await openDispute(staff, merchant, txnRef, '30000', { evidenceDueAt: dueAt.toISOString() })
    ).json().data;

    const reviewing = await staff.client.patch(`/admin/v1/disputes/${dispute.id}`, {
      status: 'under_review',
    });
    expect(reviewing.json().data.status).toBe('under_review');
    expect(
      (await staff.client.patch(`/admin/v1/disputes/${dispute.id}`, { status: 'under_review' }))
        .statusCode
    ).toBe(409);

    const owner = merchant.owner.client;
    const added = await owner.post(`/merchant/v1/disputes/${dispute.id}/evidence`, {
      text: 'Delivered on 2 March; courier receipt DHL-889102.',
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().data.evidence).toHaveLength(1);
    expect(
      (await owner.post(`/merchant/v1/disputes/${dispute.id}/evidence`, { text: '' })).statusCode
    ).toBe(400);
    const audit = await sql(
      'select after from core.audit_logs where resource_id = $1 and action = $2',
      [dispute.id, 'dispute.evidence_added']
    );
    expect(JSON.stringify(audit)).not.toContain('DHL-889102');

    // A viewer may read but not respond; another merchant cannot see the dispute at all.
    const viewer = await addTeamMember(ctx, merchant.owner, 'viewer');
    expect((await viewer.client.get(`/merchant/v1/disputes/${dispute.id}`)).statusCode).toBe(200);
    expect(
      (await viewer.client.post(`/merchant/v1/disputes/${dispute.id}/evidence`, { text: 'x' }))
        .statusCode
    ).toBe(403);
    const stranger = await activeMerchant(ctx, 'stranger');
    const theirs = stranger.owner.client;
    expect((await theirs.get(`/merchant/v1/disputes/${dispute.id}`)).statusCode).toBe(404);
    expect(
      (await theirs.post(`/merchant/v1/disputes/${dispute.id}/evidence`, { text: 'mine' }))
        .statusCode
    ).toBe(404);
    expect((await theirs.get('/merchant/v1/disputes')).json().data.items).toEqual([]);

    // After the due date the merchant can add nothing more.
    ctx.clock.advanceBy(2 * 86_400_000);
    await loginMerchantUser(owner, merchant.owner.email);
    const late = await owner.post(`/merchant/v1/disputes/${dispute.id}/evidence`, {
      text: 'too late',
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details.reason).toBe('evidence_period_over');
  });

  it('caps the evidence at twenty items', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 30_000n);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '30000')).json().data;
    for (let i = 0; i < 20; i++) {
      const res = await merchant.owner.client.post(
        `/merchant/v1/disputes/${dispute.id}/evidence`,
        {
          text: `item ${i}`,
        }
      );
      expect(res.statusCode).toBe(200);
    }
    const over = await merchant.owner.client.post(`/merchant/v1/disputes/${dispute.id}/evidence`, {
      text: 'one more',
    });
    expect(over.json().error.details.reason).toBe('too_much_evidence');
  });
});
