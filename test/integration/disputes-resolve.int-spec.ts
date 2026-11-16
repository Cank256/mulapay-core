/**
 * Disputes and chargebacks, resolution (spec 6.14): a won or withdrawn dispute releases its
 * hold and posts nothing; a lost one captures the hold and posts to the ledger, as a reversal
 * of the payment's entry when the whole payment is disputed and as a compensating entry for
 * a part. Debits equal credits, a lost dispute never silently overdraws, and a resolved
 * dispute is final. Live money in XOF.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  merchantAccountCode,
  providerAccountCode,
} from '../../src/modules/accounts/domain/chart-of-accounts';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { staffSession } from '../support/identity';
import { sql } from '../support/payments';
import {
  startComplianceContext,
  succeedLivePayment,
  type ComplianceContext,
} from '../support/compliance';
import {
  auditActionsOf,
  balanceOf,
  DISPUTE_CURRENCY as CUR,
  entryCount,
  entryLines,
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

const holdStates = async (merchantId: string) =>
  (
    await sql<{ state: string }>(
      'select state from core.holds where merchant_id = $1 order by created_at',
      [merchantId]
    )
  ).map((h) => h.state);

describe('the merchant wins or the dispute is withdrawn', () => {
  it('releases the hold, posts nothing, and the dispute is final', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '100000')).json().data;
    const entries = await entryCount(merchant.id);

    const resolved = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_won',
      note: 'Proof of delivery accepted by the scheme.',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data).toMatchObject({
      status: 'resolved',
      outcome: 'merchant_won',
      resolutionEntry: null,
      resolutionNote: 'Proof of delivery accepted by the scheme.',
    });
    const balance = await balanceOf(ctx, merchant);
    expect(balance.availableMinor).toBe(100_000n);
    expect(balance.heldMinor).toBe(0n);
    expect(await entryCount(merchant.id)).toBe(entries);
    expect(await holdStates(merchant.id)).toEqual(['released']);
    expect(await merchantEventTypes(merchant.id)).toEqual(
      expect.arrayContaining(['dispute.resolved', 'hold.released'])
    );
    expect(await auditActionsOf(dispute.id)).toEqual(['dispute.created', 'dispute.resolved']);

    // Final: nothing more can be done with it.
    const attempts = await Promise.all([
      staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
        outcome: 'merchant_lost',
        note: 'no',
      }),
      staff.client.patch(`/admin/v1/disputes/${dispute.id}`, { internalNote: 'x' }),
      merchant.owner.client.post(`/dashboard/v1/disputes/${dispute.id}/evidence`, { text: 'x' }),
    ]);
    expect(attempts.map((a) => a.statusCode)).toEqual([409, 409, 409]);
    expect(await entryCount(merchant.id)).toBe(entries);
    // The payment can be disputed again once the first dispute is over.
    expect((await openDispute(staff, merchant, txnRef, '1000')).statusCode).toBe(201);
  });

  it('releases the hold when the dispute is withdrawn', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 40_000n);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '40000')).json().data;
    const resolved = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'withdrawn',
      note: 'The cardholder withdrew the claim.',
    });
    expect(resolved.json().data.outcome).toBe('withdrawn');
    expect((await balanceOf(ctx, merchant)).availableMinor).toBe(40_000n);
  });
});

describe('the merchant loses', () => {
  it('captures the hold and reverses the whole payment in the ledger', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '100000')).json().data;
    const [collection] = await sql<{ ref: string }>(
      `select ref from core.journal_entries where merchant_id = $1 and kind = 'collection.succeeded'`,
      [merchant.id]
    );
    const entries = await entryCount(merchant.id);

    const resolved = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'Chargeback upheld.',
    });
    expect(resolved.statusCode).toBe(200);
    const entryRef = resolved.json().data.resolutionEntry as string;
    expect(entryRef).toMatch(/^je_/);
    expect(await entryCount(merchant.id)).toBe(entries + 1);

    // A reversal: the collection entry's lines with every direction flipped; debits equal credits.
    const original = await entryLines(collection?.ref as string);
    const reversal = await entryLines(entryRef);
    expect(reversal.map((l) => [l.source, l.kind])).toEqual(
      reversal.map(() => ['reversal', 'reversal'])
    );
    expect(
      reversal.map((l) => [l.code, l.direction === 'debit' ? 'credit' : 'debit', l.amount_minor])
    ).toEqual(original.map((l) => [l.code, l.direction, l.amount_minor]));
    const debits = reversal
      .filter((l) => l.direction === 'debit')
      .reduce((s, l) => s + BigInt(l.amount_minor), 0n);
    const credits = reversal
      .filter((l) => l.direction === 'credit')
      .reduce((s, l) => s + BigInt(l.amount_minor), 0n);
    expect(debits).toBe(credits);

    const balance = await balanceOf(ctx, merchant);
    expect(balance.postedMinor).toBe(0n);
    expect(balance.heldMinor).toBe(0n);
    expect(await holdStates(merchant.id)).toEqual(['captured']);
    const [row] = await sql<{ outcome: string; resolution_entry_ref: string }>(
      'select outcome, resolution_entry_ref from core.disputes where ref = $1',
      [dispute.id]
    );
    expect(row).toEqual({ outcome: 'merchant_lost', resolution_entry_ref: entryRef });
    expect(await auditActionsOf(dispute.id)).toEqual(['dispute.created', 'dispute.resolved']);
    // The original entry is untouched: there is still exactly one collection entry, now reversed.
    expect(
      await sql(
        `select 1 from core.journal_entries where merchant_id = $1 and kind = 'collection.succeeded'`,
        [merchant.id]
      )
    ).toHaveLength(1);
  });

  it('posts a compensating entry for a disputed part of the payment', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '30000')).json().data;
    expect((await balanceOf(ctx, merchant)).availableMinor).toBe(70_000n);

    const resolved = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'Partial chargeback upheld.',
    });
    expect(resolved.statusCode).toBe(200);
    const lines = await entryLines(resolved.json().data.resolutionEntry);
    expect(lines).toEqual([
      expect.objectContaining({
        code: merchantAccountCode('merchant_payable', merchant.ref),
        direction: 'debit',
        amount_minor: '30000',
        kind: 'dispute.lost',
        source: 'adjustment',
      }),
      expect.objectContaining({
        code: providerAccountCode('provider_clearing', 'mtn'),
        direction: 'credit',
        amount_minor: '30000',
      }),
    ]);
    const balance = await balanceOf(ctx, merchant);
    expect(balance.postedMinor).toBe(70_000n);
    expect(balance.availableMinor).toBe(70_000n);
    expect(await holdStates(merchant.id)).toEqual(['captured']);
  });

  it('refuses to overdraw the merchant unless staff accept the deficit, and changes nothing when it refuses', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    // Most of the merchant's money has already left (a payout).
    const posting = ctx.app.get(PostingService, { strict: false });
    await ctx.unitOfWork.run((tx) =>
      posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('payout', `test:${randomUUID()}`),
        environment: 'live',
        currency: CUR,
        source: 'payout',
        sourceId: `test:${randomUUID()}`,
        merchantId: merchant.id,
        description: 'earlier payout',
        lines: [
          {
            accountCode: merchantAccountCode('merchant_payable', merchant.ref),
            direction: 'debit',
            amountMinor: 70_000n,
          },
          {
            accountCode: providerAccountCode('provider_float', 'mtn'),
            direction: 'credit',
            amountMinor: 70_000n,
          },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    const dispute = (await openDispute(staff, merchant, txnRef, '100000')).json().data;
    expect(dispute).toMatchObject({ heldMinor: '30000', shortfallMinor: '70000' });
    const entries = await entryCount(merchant.id);

    const refused = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'Upheld.',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await entryCount(merchant.id)).toBe(entries);
    expect(await holdStates(merchant.id)).toEqual(['active']);
    const still = (await staff.client.get(`/admin/v1/disputes/${dispute.id}`)).json().data;
    expect(still.status).toBe('open');

    const accepted = await staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'Upheld; the deficit is a receivable from the merchant.',
      acceptDeficit: true,
    });
    expect(accepted.statusCode).toBe(200);
    expect((await balanceOf(ctx, merchant)).postedMinor).toBe(-70_000n);
    expect(await holdStates(merchant.id)).toEqual(['captured']);
    // Put the account right again, so the ledger integrity checks of other suites stay clean.
    await succeedLivePayment(ctx, merchant, { amountMinor: 70_000n, currency: CUR });
    expect((await balanceOf(ctx, merchant)).postedMinor).toBe(0n);
  });

  it('applies a resolution once, however many staff press the button', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '100000')).json().data;
    const entries = await entryCount(merchant.id);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        staff.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
          outcome: 'merchant_lost',
          note: 'Upheld.',
        })
      )
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect(await entryCount(merchant.id)).toBe(entries + 1);
    expect((await balanceOf(ctx, merchant)).postedMinor).toBe(0n);
  });

  it('keeps resolving to staff with the permission', async () => {
    const { merchant, txnRef } = await merchantWithPayment(ctx, 20_000n);
    const staff = await staffSession(ctx, 'compliance');
    const dispute = (await openDispute(staff, merchant, txnRef, '20000')).json().data;
    const operations = await staffSession(ctx, 'operations');
    const denied = await operations.client.post(`/admin/v1/disputes/${dispute.id}/resolve`, {
      outcome: 'merchant_lost',
      note: 'x',
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await operations.client.patch(`/admin/v1/disputes/${dispute.id}`, {
          status: 'under_review',
        })
      ).statusCode
    ).toBe(200);
    expect((await balanceOf(ctx, merchant)).heldMinor).toBe(20_000n);
    expect(
      (
        await staff.client.post('/admin/v1/disputes/dsp_00000000000000000000000000/resolve', {
          outcome: 'withdrawn',
          note: 'x',
        })
      ).statusCode
    ).toBe(404);
  });
});
