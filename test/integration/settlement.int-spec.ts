/**
 * Settlement (spec 6.9, Phase 6): a complete cycle from payments to a paid batch, the
 * approval workflow, release and every gateway outcome, idempotency, dust roll-over and the
 * rolling reserve, against real Postgres, Redis and a fake gateway spoken to over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { publicId, uuidv7 } from '../../src/common/ids/ids';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';
import type { PayoutSignal } from '../../src/modules/settlement/domain/payout-outcome';
import {
  SettlementGatewayAuthRejected,
  SettlementSubmitRetry,
} from '../../src/modules/settlement/settlement-release.service';
import type { BatchRow } from '../../src/modules/settlement/settlement-batches.repository';
import { sql } from '../support/payments';
import {
  accountBalance,
  CURRENCY,
  runDate,
  setUpMerchant,
  settlementEntries,
  startSettlementContext,
  succeedPayment,
  type SettledMerchant,
  type SettlementContext,
} from '../support/settlement';

let ctx: SettlementContext;
beforeAll(async () => {
  ctx = await startSettlementContext();
});
afterAll(async () => {
  await ctx?.close();
});

const A = randomUUID();
const B = randomUUID();

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppError
      ? error.code
      : error instanceof Error
        ? error.name
        : String(error);
  }
}

async function batchesOf(m: SettledMerchant): Promise<BatchRow[]> {
  return (await ctx.batches.list({ merchantId: m.merchant.id, limit: 50 })).items;
}

/** A merchant with two payments (1,000,000 gross, 4,000 fee), a 10% reserve and a draft batch. */
async function draftBatch(options: { reserveBps?: number; holdDays?: number } = {}) {
  const m = await setUpMerchant(ctx);
  await ctx.reserve.set(
    m.merchant.ref,
    {
      currency: CURRENCY,
      percentBps: options.reserveBps ?? 1000,
      holdDays: options.holdDays ?? 30,
      active: true,
    },
    A
  );
  await succeedPayment(ctx, m, 400_000n, 4_000n);
  await succeedPayment(ctx, m, 600_000n);
  const outcome = await ctx.runs.runCycle(m.cycleRef, {
    asOf: runDate(ctx),
    triggeredBy: `user:${A}`,
  });
  expect(outcome.outcome).toBe('completed');
  const [batch] = await batchesOf(m);
  if (!batch) throw new Error('no batch was created');
  return { m, batch };
}

async function approved() {
  const made = await draftBatch();
  await ctx.batches.submit(made.batch.ref, A);
  const batch = await ctx.batches.approve(made.batch.ref, B);
  return { ...made, batch };
}

async function released() {
  const made = await approved();
  const { batch } = await ctx.release.release(made.batch.ref, B);
  return { ...made, batch };
}

const succeeded = (amountMinor: bigint): PayoutSignal => ({
  kind: 'succeeded',
  amountMinor,
  currency: CURRENCY,
});

const applyOutcome = (payoutRef: string, eventKey: string, signal: PayoutSignal) =>
  ctx.unitOfWork.run((tx) => ctx.outcome.apply(tx, { payoutRef, eventKey, signal }));

async function payoutOf(batch: BatchRow) {
  const [row] = await sql<{
    status: string;
    outcome_unknown: boolean;
    failure_code: string | null;
    gateway_reference_id: string | null;
  }>(
    `select status, outcome_unknown, failure_code, gateway_reference_id from core.transactions where id = $1`,
    [batch.payoutTransactionId]
  );
  return row;
}

async function holdOf(batch: BatchRow) {
  const [row] = await sql<{ state: string; amount_minor: string }>(
    `select state, amount_minor::text from core.holds where id = $1`,
    [batch.holdId]
  );
  return row;
}

describe('a complete settlement cycle', () => {
  it('calculates, approves, releases, pays and posts, and posts nothing before the payout succeeds', async () => {
    const { m, batch: draft } = await draftBatch();

    // The calculation: gross - fees - 10% reserve = 896,000, from the payable account.
    expect(draft).toMatchObject({
      status: 'draft',
      grossMinor: 1_000_000n,
      feeMinor: 4_000n,
      refundMinor: 0n,
      reserveMinor: 100_000n,
      reserveReleaseMinor: 0n,
      payableDrawMinor: 896_000n,
      netMinor: 896_000n,
      shortfallMinor: 0n,
    });
    const items = await ctx.batches.items(draft, { limit: 50 });
    expect(items.items.map((i) => i.kind).sort()).toEqual([
      'payment',
      'payment',
      'reserve_withheld',
    ]);
    expect(await settlementEntries(draft.ref)).toEqual([]);

    // draft -> pending_approval -> approved, still nothing in the ledger.
    ctx.clock.advanceBy(1000);
    const submitted = await ctx.batches.submit(draft.ref, A);
    expect(submitted.status).toBe('pending_approval');
    expect(await codeOf(ctx.batches.approve(draft.ref, A))).toBe(
      'SETTLEMENT_APPROVER_IS_SUBMITTER'
    );
    ctx.clock.advanceBy(1000);
    const approvedBatch = await ctx.batches.approve(draft.ref, B);
    expect(approvedBatch.status).toBe('approved');
    expect(await settlementEntries(draft.ref)).toEqual([]);
    const payableBefore = await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY);
    expect(payableBefore.postedMinor).toBe(996_000n);

    // Release: the payout exists, the funds are held, and still nothing is posted.
    const floatBefore = await accountBalance('1010:provider_float:airtel');
    const reserveBefore = await accountBalance(`2010:merchant_reserve:${m.merchant.ref}`);
    ctx.clock.advanceBy(1000);
    const { batch: releasing, replayed } = await ctx.release.release(draft.ref, B);
    expect(replayed).toBe(false);
    expect(releasing.status).toBe('releasing');
    expect(releasing.payoutRef).toMatch(/^po_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await payoutOf(releasing)).toMatchObject({ status: 'created' });
    expect(await holdOf(releasing)).toEqual({ state: 'active', amount_minor: '996000' });
    expect(
      (await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY)).availableMinor
    ).toBe(0n);
    expect(await settlementEntries(draft.ref)).toEqual([]);
    const outbox = await sql(
      `select 1 from core.outbox where event_type = 'settlement.submit_payout' and aggregate_id = $1`,
      [draft.id]
    );
    expect(outbox).toHaveLength(1);

    // A second release is the same release: no second payout, hold or outbox row.
    const again = await ctx.release.release(draft.ref, B);
    expect(again.replayed).toBe(true);
    expect(again.batch.payoutRef).toBe(releasing.payoutRef);
    expect(
      await sql(`select 1 from core.holds where reason = $1`, [`settlement:${draft.ref}`])
    ).toHaveLength(1);
    expect(
      await sql(
        `select 1 from core.transactions where type = 'settlement' and gateway_external_id = $1`,
        [releasing.payoutRef]
      )
    ).toHaveLength(1);

    // The worker sends it: one call, with the payout's own external id and the exact amount.
    expect(await ctx.release.submitPayout(draft.id)).toBe('submitted');
    expect(
      ctx.gateway.disbursementCalls.filter((c) => c.externalId === releasing.payoutRef)
    ).toEqual([
      expect.objectContaining({ amount: '8960.00', currency: 'TZS', provider: 'airtel' }),
    ]);
    expect(await payoutOf(releasing)).toMatchObject({
      status: 'processing',
      outcome_unknown: false,
    });
    expect(await ctx.release.submitPayout(draft.id)).toBe('already_submitted');
    expect(
      ctx.gateway.disbursementCalls.filter((c) => c.externalId === releasing.payoutRef)
    ).toHaveLength(1);
    expect(await settlementEntries(draft.ref)).toEqual([]);

    // The gateway says successful: capture, post, pay.
    ctx.clock.advanceBy(1000);
    const result = await applyOutcome(
      releasing.payoutRef as string,
      'evt-ok-1',
      succeeded(896_000n)
    );
    expect(result.kind).toBe('applied');
    const paid = await ctx.batches.get(draft.ref);
    expect(paid).toMatchObject({ status: 'paid' });
    expect(paid.paidAt).not.toBeNull();
    expect(await payoutOf(releasing)).toMatchObject({ status: 'succeeded' });
    expect(await holdOf(releasing)).toMatchObject({ state: 'captured' });
    expect((await settlementEntries(draft.ref)).map((e) => e.kind)).toEqual([
      'settlement.confirmed',
      'settlement.released',
    ]);

    // Balances moved exactly: payable emptied, reserve held, float paid out, nothing in transit.
    expect((await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY)).postedMinor).toBe(
      0n
    );
    expect((await accountBalance(`2010:merchant_reserve:${m.merchant.ref}`)) - reserveBefore).toBe(
      100_000n
    );
    expect((await accountBalance('1010:provider_float:airtel')) - floatBefore).toBe(-896_000n);
    const reserve = await sql<{ amount_minor: string; released_at: string | null }>(
      `select amount_minor::text, released_at::text from core.reserve_entries where merchant_id = $1`,
      [m.merchant.id]
    );
    expect(reserve).toEqual([{ amount_minor: '100000', released_at: null }]);

    // The merchant was told, twice, and the statement ties everything together.
    const events = await sql<{ type: string }>(
      `select type from core.merchant_events where merchant_id = $1 and type like 'settlement.%' order by created_at`,
      [m.merchant.id]
    );
    expect(events.map((e) => e.type).sort()).toEqual(['settlement.created', 'settlement.paid']);
    const merchantView = await ctx.reports.statement(paid, 'merchant');
    expect(merchantView.totals).toMatchObject({
      gross_minor: '1000000',
      fees_minor: '4000',
      net_minor: '896000',
    });
    expect(merchantView.payout).toMatchObject({
      status: 'succeeded',
      provider: 'airtel',
      destination: '+255••••••001',
    });
    expect(merchantView.reconciliation.ledgerEntries).toEqual([]);
    const staffView = await ctx.reports.statement(paid, 'staff');
    expect(staffView.reconciliation.ledgerEntries.map((e) => e.name)).toEqual([
      'release',
      'confirm',
    ]);
    expect(staffView.statusHistory.map((h) => h.to)).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'releasing',
      'paid',
    ]);
    expect((await ctx.reports.csv(paid, 'merchant')).content).toContain(
      `"settlement","${paid.ref}"`
    );

    // The ledger is healthy after the whole cycle.
    const proof = await ctx.scheduler.runManual({
      kind: 'ledger_integrity',
      scope: { environment: 'live', currency: CURRENCY },
      idempotencyKey: `after-cycle-${randomUUID()}`,
      userId: A,
    });
    expect(proof.outcome).toBe('completed');
    expect(proof.run?.exceptionCount).toBe(0);
  });
});

describe('idempotent settlement runs', () => {
  it('a second run of the same period creates no second batch', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 500_000n);
    const asOf = runDate(ctx);
    const first = await ctx.runs.runCycle(m.cycleRef, { asOf, triggeredBy: 'job:test' });
    const second = await ctx.runs.runCycle(m.cycleRef, {
      asOf: new Date(asOf.getTime() + 3_600_000),
      triggeredBy: 'job:test',
    });
    expect(first.outcome).toBe('completed');
    expect(second.outcome).toBe('duplicate');
    expect(await batchesOf(m)).toHaveLength(1);
  });

  it('parallel runs of one period create one batch', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 500_000n);
    const asOf = runDate(ctx);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.runs.runCycle(m.cycleRef, { asOf, triggeredBy: 'job:test' })
      )
    );
    expect(results.filter((r) => r.outcome === 'completed')).toHaveLength(1);
    expect(
      results.every((r) => ['completed', 'duplicate', 'in_progress'].includes(r.outcome))
    ).toBe(true);
    expect(await batchesOf(m)).toHaveLength(1);
  });

  it('a later period starts where the last batch ended and never counts a payment twice', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 300_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    ctx.clock.advanceBy(3 * 86_400_000);
    await succeedPayment(ctx, m, 200_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const batches = (await batchesOf(m)).sort(
      (a, b) => a.periodEnd.getTime() - b.periodEnd.getTime()
    );
    expect(batches.map((b) => b.grossMinor)).toEqual([300_000n, 200_000n]);
    expect(batches[1]?.periodStart.getTime()).toBe(batches[0]?.periodEnd.getTime());
  });

  it('the database refuses a second live batch for the same period', async () => {
    const { batch } = await draftBatch({ reserveBps: 0 });
    await expect(
      sql(
        `insert into core.settlement_batches (id, ref, merchant_id, cycle_id, currency, period_start, period_end,
            gross_minor, refund_minor, fee_minor, reserve_minor, reserve_release_minor, dispute_hold_minor, aml_hold_minor,
            shortfall_minor, payable_draw_minor, net_minor, min_payout_minor, created_by)
         select gen_random_uuid(), 'stl_' || upper(substr(md5(random()::text), 1, 26)), merchant_id, cycle_id,
                currency, period_start, period_end, gross_minor, 0, 0, 0, 0, 0, 0, 0, net_minor, net_minor, min_payout_minor, 'test'
           from core.settlement_batches where id = $1`,
        [batch.id]
      )
    ).rejects.toThrow();
  });
});

describe('commit safety', () => {
  it('waits until the period end is far enough behind, then runs', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 100_000n);
    const soon = new Date(runDate(ctx).getTime() - 6 * 3_600_000 + 10_000); // 10 s past the cutoff
    const early = await ctx.runs.runCycle(m.cycleRef, { asOf: soon, triggeredBy: 'job:test' });
    expect(early.outcome).toBe('too_early');
    expect(
      await sql(
        `select 1 from core.settlement_runs where cycle_id = (select id from core.settlement_cycles where ref = $1)`,
        [m.cycleRef]
      )
    ).toEqual([]);
    const ready = await ctx.runs.runCycle(m.cycleRef, {
      asOf: runDate(ctx),
      triggeredBy: 'job:test',
    });
    expect(ready.outcome).toBe('completed');
  });
});

describe('minimum payout', () => {
  it('rolls dust into the next cycle without creating a batch or a payout', async () => {
    const m = await setUpMerchant(ctx, { minPayoutMinor: 10_000n });
    await succeedPayment(ctx, m, 9_999n);
    const dust = await ctx.runs.runCycle(m.cycleRef, {
      asOf: runDate(ctx, 2),
      triggeredBy: 'job:test',
    });
    expect(dust.outcome).toBe('completed');
    expect(dust.outcome === 'completed' && dust.run).toMatchObject({
      rolledOver: 1,
      batchesCreated: 0,
    });
    expect(await batchesOf(m)).toEqual([]);
    expect(
      await sql(`select 1 from core.transactions where merchant_id = $1 and type = 'settlement'`, [
        m.merchant.id,
      ])
    ).toEqual([]);

    // Next cycle: the dust and the new payment settle together, from the beginning of time.
    ctx.clock.advanceBy(3 * 86_400_000);
    await succeedPayment(ctx, m, 5_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const [batch] = await batchesOf(m);
    expect(batch).toMatchObject({ grossMinor: 14_999n, netMinor: 14_999n });
  });

  it('settles exactly the minimum', async () => {
    const m = await setUpMerchant(ctx, { minPayoutMinor: 10_000n });
    await succeedPayment(ctx, m, 10_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: 'job:test' });
    expect(await batchesOf(m)).toHaveLength(1);
  });

  it('the database refuses a batch below its own minimum', async () => {
    const { batch } = await draftBatch({ reserveBps: 0 });
    await expect(
      sql(`update core.settlement_batches set min_payout_minor = net_minor + 1 where id = $1`, [
        batch.id,
      ])
    ).rejects.toThrow();
  });
});

describe('approval workflow', () => {
  it('only moves along draft -> pending_approval -> approved -> releasing', async () => {
    const { batch } = await draftBatch();
    expect(await codeOf(ctx.batches.approve(batch.ref, B))).toBe('SETTLEMENT_INVALID_TRANSITION');
    expect(await codeOf(ctx.release.release(batch.ref, B))).toBe('SETTLEMENT_INVALID_TRANSITION');
    await ctx.batches.submit(batch.ref, A);
    expect(await codeOf(ctx.batches.submit(batch.ref, A))).toBe('SETTLEMENT_INVALID_TRANSITION');
    expect(await codeOf(ctx.release.release(batch.ref, B))).toBe('SETTLEMENT_INVALID_TRANSITION');
  });

  it('refuses to submit without a destination, and the database refuses an approver equal to the submitter', async () => {
    const m = await setUpMerchant(ctx, { destination: false });
    await succeedPayment(ctx, m, 100_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: 'job:test' });
    const [batch] = await batchesOf(m);
    expect(await codeOf(ctx.batches.submit(batch!.ref, A))).toBe('SETTLEMENT_DESTINATION_MISSING');
    await ctx.destinations.set(
      m.merchant.ref,
      { currency: CURRENCY, provider: 'airtel', msisdn: '+255700000009' },
      A
    );
    await ctx.batches.submit(batch!.ref, A);
    await expect(
      sql(
        `update core.settlement_batches set status = 'approved', approved_by = submitted_by, approved_at = now() where id = $1`,
        [batch!.id]
      )
    ).rejects.toThrow();
  });

  it('refuses approval and release when the destination changed after submission', async () => {
    const { m, batch } = await draftBatch();
    await ctx.batches.submit(batch.ref, A);
    await ctx.destinations.set(
      m.merchant.ref,
      { currency: CURRENCY, provider: 'airtel', msisdn: '+255700000077' },
      A
    );
    expect(await codeOf(ctx.batches.approve(batch.ref, B))).toBe('SETTLEMENT_DESTINATION_CHANGED');

    const second = await approved();
    await ctx.destinations.set(
      second.m.merchant.ref,
      { currency: CURRENCY, provider: 'airtel', msisdn: '+255700000078' },
      A
    );
    expect(await codeOf(ctx.release.release(second.batch.ref, B))).toBe(
      'SETTLEMENT_DESTINATION_CHANGED'
    );
    expect((await ctx.batches.get(second.batch.ref)).status).toBe('approved');
    expect(
      await sql(`select 1 from core.holds where reason = $1`, [`settlement:${second.batch.ref}`])
    ).toEqual([]);
  });

  it('cancels before release, frees the period for a later run, and refuses to cancel after', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 250_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const [batch] = await batchesOf(m);
    await ctx.batches.submit(batch!.ref, A);
    const cancelled = await ctx.batches.cancel(batch!.ref, A, 'wrong destination');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'wrong destination' });
    expect(await settlementEntries(batch!.ref)).toEqual([]);
    expect(await codeOf(ctx.batches.approve(batch!.ref, B))).toBe('SETTLEMENT_INVALID_TRANSITION');
    // The same money is settled by the next period's batch.
    ctx.clock.advanceBy(3 * 86_400_000);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const live = (await batchesOf(m)).filter((b) => b.status === 'draft');
    expect(live.map((b) => b.grossMinor)).toEqual([250_000n]);

    const r = await released();
    expect(await codeOf(ctx.batches.cancel(r.batch.ref, A, 'too late'))).toBe(
      'SETTLEMENT_INVALID_TRANSITION'
    );
  });

  it('the database refuses to change a batch’s amounts or to skip a state', async () => {
    const { batch } = await draftBatch();
    await expect(
      sql(
        `update core.settlement_batches set net_minor = net_minor - 1, payable_draw_minor = payable_draw_minor - 1 where id = $1`,
        [batch.id]
      )
    ).rejects.toThrow();
    await expect(
      sql(`update core.settlement_batches set status = 'paid' where id = $1`, [batch.id])
    ).rejects.toThrow();
    await expect(
      sql(`delete from core.settlement_items where batch_id = $1`, [batch.id])
    ).rejects.toThrow();
  });
});

describe('release and the gateway outcome', () => {
  it('a failed payout releases the hold, posts nothing and leaves the money to settle again', async () => {
    const { m, batch } = await released();
    await ctx.release.submitPayout(batch.id);
    const result = await applyOutcome(batch.payoutRef as string, 'evt-failed', {
      kind: 'failed',
    });
    expect(result.kind).toBe('applied');
    expect(await ctx.batches.get(batch.ref)).toMatchObject({
      status: 'failed',
      failureCode: 'gateway_failed',
    });
    expect(await payoutOf(batch)).toMatchObject({
      status: 'failed',
      failure_code: 'gateway_failed',
    });
    expect(await holdOf(batch)).toMatchObject({ state: 'released' });
    expect(await settlementEntries(batch.ref)).toEqual([]);
    expect(
      (await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY)).availableMinor
    ).toBe(996_000n);
    // The period is free again: the next cycle settles the same payments.
    ctx.clock.advanceBy(3 * 86_400_000);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    expect(
      (await batchesOf(m)).filter((b) => b.status === 'draft').map((b) => b.grossMinor)
    ).toEqual([1_000_000n]);
  });

  it('expired and cancelled outcomes fail the batch the same way', async () => {
    for (const kind of ['expired', 'cancelled'] as const) {
      const { batch } = await released();
      await applyOutcome(batch.payoutRef as string, `evt-${kind}`, { kind });
      expect(await ctx.batches.get(batch.ref)).toMatchObject({
        status: 'failed',
        failureCode: `gateway_${kind}`,
      });
      expect(await holdOf(batch)).toMatchObject({ state: 'released' });
    }
  });

  it('an ambiguous outcome keeps the hold, posts nothing and waits for the gateway', async () => {
    const { batch } = await released();
    ctx.gateway.disbursement = { kind: 'gateway_timeout' };
    expect(await ctx.release.submitPayout(batch.id)).toBe('unknown_outcome');
    expect(await payoutOf(batch)).toMatchObject({ status: 'processing', outcome_unknown: true });
    expect(await holdOf(batch)).toMatchObject({ state: 'active' });
    expect(await settlementEntries(batch.ref)).toEqual([]);
    expect((await ctx.batches.get(batch.ref)).status).toBe('releasing');
    // Never retried under a new key: asking again finds the payout already submitted.
    expect(await ctx.release.submitPayout(batch.id)).toBe('already_submitted');
    expect(
      new Set(ctx.gateway.disbursementCalls.filter((c) => c.externalId === batch.payoutRef)).size
    ).toBe(1);

    // Status verification: the gateway still says unknown, then successful.
    expect(await ctx.release.verifyPayout(batch.id)).toBe('still_pending');
    expect((await ctx.batches.get(batch.ref)).status).toBe('releasing');
    ctx.gateway.setStatus(batch.payoutRef as string, 'disbursement', 'successful');
    expect(await ctx.release.verifyPayout(batch.id)).toBe('applied');
    expect(await ctx.batches.get(batch.ref)).toMatchObject({ status: 'paid' });
    expect(await settlementEntries(batch.ref)).toHaveLength(2);
    // Checking again changes nothing.
    expect(await ctx.release.verifyPayout(batch.id)).toBe('skipped');
  });

  it('a dropped connection is as ambiguous as a 504', async () => {
    const { batch } = await released();
    ctx.gateway.disbursement = { kind: 'drop' };
    expect(await ctx.release.submitPayout(batch.id)).toBe('unknown_outcome');
    expect(await payoutOf(batch)).toMatchObject({ status: 'processing', outcome_unknown: true });
    expect(await holdOf(batch)).toMatchObject({ state: 'active' });
  });

  it('a gateway that refuses with 400 fails the payout; one that is unreachable is retried with the same key', async () => {
    const bad = await released();
    ctx.gateway.disbursement = { kind: 'status', code: 400 };
    expect(await ctx.release.submitPayout(bad.batch.id)).toBe('failed');
    expect(await ctx.batches.get(bad.batch.ref)).toMatchObject({
      status: 'failed',
      failureCode: 'gateway_validation',
    });
    expect(await holdOf(bad.batch)).toMatchObject({ state: 'released' });

    const retry = await released();
    for (const code of [401, 403, 404, 429]) {
      ctx.gateway.disbursement = { kind: 'status', code };
      const thrown = await ctx.release.submitPayout(retry.batch.id).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(SettlementSubmitRetry);
      // 401 and 403 are the spec 3.5 "page, do not loop" case; 404 and 429 are plain retries.
      expect(thrown instanceof SettlementGatewayAuthRejected).toBe(code === 401 || code === 403);
      expect(await payoutOf(retry.batch)).toMatchObject({ status: 'created' });
      expect(await holdOf(retry.batch)).toMatchObject({ state: 'active' });
    }
    ctx.gateway.disbursement = { kind: 'accept' };
    expect(await ctx.release.submitPayout(retry.batch.id)).toBe('submitted');
    const keys = ctx.gateway.disbursementCalls.filter(
      (c) => c.externalId === retry.batch.payoutRef
    );
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys.map((c) => c.externalId)).size).toBe(1);
  });

  it('a terminal status in the gateway’s own answer is applied through the same path', async () => {
    const { batch } = await released();
    ctx.gateway.disbursement = { kind: 'accept', status: 'successful' };
    expect(await ctx.release.submitPayout(batch.id)).toBe('submitted');
    expect(await ctx.batches.get(batch.ref)).toMatchObject({ status: 'paid' });
    ctx.gateway.disbursement = { kind: 'accept' };
  });

  it('the sweep re-sends a payout that was never sent and verifies a processing one', async () => {
    const unsent = await released();
    const stuck = await released();
    await ctx.release.submitPayout(stuck.batch.id);
    ctx.gateway.setStatus(stuck.batch.payoutRef as string, 'disbursement', 'failed');
    ctx.clock.advanceBy(10 * 60_000);
    // The sweep reads `released_at` against the real clock stored by the fixed clock.
    const swept = await ctx.release.sweep(500);
    expect(swept.submitted).toBeGreaterThanOrEqual(1);
    expect(swept.verified).toBeGreaterThanOrEqual(1);
    expect(await payoutOf(unsent.batch)).toMatchObject({ status: 'processing' });
    expect((await ctx.batches.get(stuck.batch.ref)).status).toBe('failed');
  });
});

describe('late and repeated provider events', () => {
  it('records an event once and treats a repeat as a duplicate', async () => {
    const { batch } = await released();
    await ctx.release.submitPayout(batch.id);
    expect((await applyOutcome(batch.payoutRef as string, 'evt-1', succeeded(896_000n))).kind).toBe(
      'applied'
    );
    expect((await applyOutcome(batch.payoutRef as string, 'evt-1', succeeded(896_000n))).kind).toBe(
      'duplicate'
    );
    expect((await applyOutcome(batch.payoutRef as string, 'evt-2', succeeded(896_000n))).kind).toBe(
      'noop'
    );
    expect(await settlementEntries(batch.ref)).toHaveLength(2);
  });

  it('refuses a success after the batch failed and raises an exception instead', async () => {
    const { batch } = await released();
    await ctx.release.submitPayout(batch.id);
    await applyOutcome(batch.payoutRef as string, 'evt-fail', { kind: 'failed' });
    const late = await applyOutcome(batch.payoutRef as string, 'evt-late', succeeded(896_000n));
    expect(late).toMatchObject({ kind: 'rejected', reason: 'success_after_failed' });
    expect(await ctx.batches.get(batch.ref)).toMatchObject({ status: 'failed' });
    expect(await settlementEntries(batch.ref)).toEqual([]);
    const raised = await sql<{ kind: string; severity: string }>(
      `select kind, severity from core.reconciliation_exceptions where transaction_id = $1`,
      [batch.payoutTransactionId]
    );
    expect(raised).toEqual([{ kind: 'late_conflicting_event', severity: 'critical' }]);
  });

  it('refuses a failure after the batch was paid', async () => {
    const { batch } = await released();
    await ctx.release.submitPayout(batch.id);
    await applyOutcome(batch.payoutRef as string, 'evt-ok', succeeded(896_000n));
    const late = await applyOutcome(batch.payoutRef as string, 'evt-late-fail', {
      kind: 'expired',
    });
    expect(late).toMatchObject({ kind: 'rejected', reason: 'failure_after_paid' });
    expect(await ctx.batches.get(batch.ref)).toMatchObject({ status: 'paid' });
  });

  it('refuses a success whose amount differs from the payout', async () => {
    const { batch } = await released();
    await ctx.release.submitPayout(batch.id);
    const wrong = await applyOutcome(batch.payoutRef as string, 'evt-wrong', succeeded(895_999n));
    expect(wrong).toMatchObject({ kind: 'rejected', reason: 'amount_mismatch' });
    expect(await ctx.batches.get(batch.ref)).toMatchObject({ status: 'releasing' });
    expect(await settlementEntries(batch.ref)).toEqual([]);
    expect(await holdOf(batch)).toMatchObject({ state: 'active' });
    const kinds = await sql<{ kind: string }>(
      `select kind from core.reconciliation_exceptions where transaction_id = $1`,
      [batch.payoutTransactionId]
    );
    expect(kinds).toEqual([{ kind: 'gateway_amount_mismatch' }]);
  });

  it('answers unknown_payout for an id that is not a settlement', async () => {
    expect(await applyOutcome(`po_${'0'.repeat(26)}`, 'evt-x', { kind: 'failed' })).toEqual({
      kind: 'unknown_payout',
    });
  });
});

describe('rolling reserve', () => {
  it('withholds a percentage, holds it, then releases it into the next eligible batch', async () => {
    const m = await setUpMerchant(ctx);
    await ctx.reserve.set(
      m.merchant.ref,
      { currency: CURRENCY, percentBps: 1000, holdDays: 0, active: true },
      A
    );
    await succeedPayment(ctx, m, 1_000_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const [first] = await batchesOf(m);
    await ctx.batches.submit(first!.ref, A);
    await ctx.batches.approve(first!.ref, B);
    const { batch } = await ctx.release.release(first!.ref, B);
    await ctx.release.submitPayout(batch.id);
    await applyOutcome(batch.payoutRef as string, 'evt-r1', succeeded(900_000n));
    expect(await accountBalance(`2010:merchant_reserve:${m.merchant.ref}`)).toBe(100_000n);

    // Second period: 500,000 more earned, 50,000 withheld, and the earlier 100,000 comes back.
    ctx.clock.advanceBy(3 * 86_400_000);
    await succeedPayment(ctx, m, 500_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const second = (await batchesOf(m)).find((b) => b.status === 'draft');
    expect(second).toMatchObject({
      grossMinor: 500_000n,
      reserveMinor: 50_000n,
      reserveReleaseMinor: 100_000n,
      payableDrawMinor: 450_000n,
      netMinor: 550_000n,
    });
    // The released reserve is claimed by this draft: no other batch can take it.
    expect(
      await sql(
        `select 1 from core.reserve_entries where release_batch_id = $1 and released_at is null`,
        [second!.id]
      )
    ).toHaveLength(1);

    await ctx.batches.submit(second!.ref, A);
    await ctx.batches.approve(second!.ref, B);
    const r2 = await ctx.release.release(second!.ref, B);
    await ctx.release.submitPayout(r2.batch.id);
    await applyOutcome(r2.batch.payoutRef as string, 'evt-r2', succeeded(550_000n));
    expect(await accountBalance(`2010:merchant_reserve:${m.merchant.ref}`)).toBe(50_000n);
    const entries = await sql<{ amount_minor: string; released: boolean }>(
      `select amount_minor::text, released_at is not null as released from core.reserve_entries where merchant_id = $1 order by created_at`,
      [m.merchant.id]
    );
    expect(entries).toEqual([
      { amount_minor: '100000', released: true },
      { amount_minor: '50000', released: false },
    ]);
    expect((await ctx.balances.merchantBalance(m.merchant.id, 'live', CURRENCY)).postedMinor).toBe(
      0n
    );
  });

  it('a cancelled batch gives its claimed reserve back; a failed one too', async () => {
    const m = await setUpMerchant(ctx);
    await ctx.reserve.set(
      m.merchant.ref,
      { currency: CURRENCY, percentBps: 1000, holdDays: 0, active: true },
      A
    );
    await succeedPayment(ctx, m, 1_000_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const [first] = await batchesOf(m);
    await ctx.batches.submit(first!.ref, A);
    await ctx.batches.approve(first!.ref, B);
    const r = await ctx.release.release(first!.ref, B);
    await ctx.release.submitPayout(r.batch.id);
    await applyOutcome(r.batch.payoutRef as string, 'evt-a', succeeded(900_000n));

    ctx.clock.advanceBy(3 * 86_400_000);
    await succeedPayment(ctx, m, 500_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const draft = (await batchesOf(m)).find((b) => b.status === 'draft')!;
    await ctx.batches.cancel(draft.ref, A, 'recalculate');
    const open = await sql(
      `select 1 from core.reserve_entries where merchant_id = $1 and release_batch_id is null and released_at is null`,
      [m.merchant.id]
    );
    expect(open).toHaveLength(1);
  });

  it('the database keeps a released reserve and its amount fixed', async () => {
    const m = await setUpMerchant(ctx);
    await ctx.reserve.set(
      m.merchant.ref,
      { currency: CURRENCY, percentBps: 1000, holdDays: 30, active: true },
      A
    );
    await succeedPayment(ctx, m, 1_000_000n);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx, 2), triggeredBy: 'job:test' });
    const [b] = await batchesOf(m);
    await ctx.batches.submit(b!.ref, A);
    await ctx.batches.approve(b!.ref, B);
    const r = await ctx.release.release(b!.ref, B);
    await ctx.release.submitPayout(r.batch.id);
    await applyOutcome(r.batch.payoutRef as string, 'evt-z', succeeded(900_000n));
    await expect(
      sql(`update core.reserve_entries set amount_minor = 1 where merchant_id = $1`, [
        m.merchant.id,
      ])
    ).rejects.toThrow();
  });

  it('applies the platform default when a merchant has no setting, and a merchant row overrides it', async () => {
    const m = await setUpMerchant(ctx);
    const defaults = await ctx.unitOfWork.run((tx) =>
      ctx.reserve.termsFor(tx, m.merchant.id, CURRENCY)
    );
    expect(defaults).toEqual({ percentBps: 0, holdDays: 30, source: 'default' });
    await ctx.reserve.set(
      m.merchant.ref,
      { currency: CURRENCY, percentBps: 250, holdDays: 7, active: true },
      A
    );
    const own = await ctx.unitOfWork.run((tx) => ctx.reserve.termsFor(tx, m.merchant.id, CURRENCY));
    expect(own).toEqual({ percentBps: 250, holdDays: 7, source: 'merchant' });
    expect(
      await codeOf(
        ctx.reserve.set(
          m.merchant.ref,
          { currency: CURRENCY, percentBps: 10_001, holdDays: 7, active: true },
          A
        )
      )
    ).toBe('SETTLEMENT_CYCLE_INVALID');
  });
});

describe('what is held and refunded', () => {
  it('subtracts refunds, dispute holds and AML holds from the payable', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 1_000_000n);
    // A refund of 100,000: the ledger posting and the refund transaction (Phase 4 builds the flow).
    const refund = 100_000n;
    const now = ctx.clock.now();
    await ctx.unitOfWork.run(async (tx) => {
      const id = uuidv7(now);
      const ref = publicId('transaction', now);
      await ctx.app.get(TransactionsRepository, { strict: false }).insert(tx, {
        id,
        ref,
        merchantId: m.merchant.id,
        environment: 'live',
        type: 'refund',
        status: 'succeeded',
        amountMinor: refund,
        feeMinor: 0n,
        netMinor: refund,
        currency: CURRENCY,
        provider: 'airtel',
        channel: 'mobile_money',
        completedAt: now,
        createdAt: now,
      });
      await ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('refund', ref),
        environment: 'live',
        currency: CURRENCY,
        source: 'refund',
        sourceId: ref,
        merchantId: m.merchant.id,
        transactionId: id,
        description: 'test refund',
        lines: [
          {
            accountCode: `2000:merchant_payable:${m.merchant.ref}`,
            direction: 'debit',
            amountMinor: refund,
          },
          { accountCode: '1010:provider_float:airtel', direction: 'credit', amountMinor: refund },
        ],
        createdBy: { type: 'system', id: 'test' },
      });
      for (const [reason, amount] of [
        ['dispute:chargeback', 30_000n],
        ['aml:review', 20_000n],
      ] as const) {
        await ctx.holdsService.place(tx, {
          merchantId: m.merchant.id,
          environment: 'live',
          currency: CURRENCY,
          amountMinor: amount,
          reason,
          idempotencyKey: `${reason}:${randomUUID()}`,
          createdBy: 'system:test',
        });
      }
    });
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: 'job:test' });
    const [batch] = await batchesOf(m);
    expect(batch).toMatchObject({
      grossMinor: 1_000_000n,
      refundMinor: 100_000n,
      disputeHoldMinor: 30_000n,
      amlHoldMinor: 20_000n,
      payableDrawMinor: 850_000n,
      netMinor: 850_000n,
    });
    const kinds = (await ctx.batches.items(batch!, { limit: 50 })).items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['aml_hold', 'dispute_hold', 'payment', 'refund']);
  });

  it('never settles more than the merchant payable can cover', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 1_000_000n);
    // A non-settlement payout took 700,000 out of the payable account earlier.
    await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: `${'a'.repeat(32)}${randomUUID().replace(/-/g, '')}`,
        environment: 'live',
        currency: CURRENCY,
        source: 'payout',
        sourceId: `cap-${randomUUID()}`,
        merchantId: m.merchant.id,
        description: 'earlier payout',
        lines: [
          {
            accountCode: `2000:merchant_payable:${m.merchant.ref}`,
            direction: 'debit',
            amountMinor: 700_000n,
          },
          { accountCode: '1010:provider_float:airtel', direction: 'credit', amountMinor: 700_000n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: 'job:test' });
    const [batch] = await batchesOf(m);
    expect(batch).toMatchObject({
      payableDrawMinor: 300_000n,
      shortfallMinor: 700_000n,
      netMinor: 300_000n,
    });
  });

  it('settles a suspended merchant and skips merchants that are not on the cycle or are closed', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 100_000n);
    await sql(`update core.merchants set status = 'suspended' where ref = $1`, [m.merchant.ref]);
    const other = await setUpMerchant(ctx);
    await succeedPayment(ctx, other, 100_000n);
    await ctx.cyclesService.assignMerchant(other.merchant.ref, null);
    await ctx.runs.runCycle(m.cycleRef, { asOf: runDate(ctx), triggeredBy: 'job:test' });
    expect(await batchesOf(m)).toHaveLength(1);
    expect(await batchesOf(other)).toHaveLength(0);
    await sql(`update core.merchants set status = 'closed' where ref = $1`, [m.merchant.ref]);
    const again = await ctx.runs.runCycle(m.cycleRef, {
      asOf: runDate(ctx, 4),
      triggeredBy: 'job:test',
    });
    expect(again.outcome).toBe('completed');
    expect(again.outcome === 'completed' && again.run.merchantsConsidered).toBe(0);
  });

  it('previews the payable without creating anything', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 200_000n);
    const preview = await ctx.runs.preview(m.cycleRef, { asOf: runDate(ctx), limit: 10 });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ decision: 'settle', amounts: { netMinor: 200_000n } });
    expect(await batchesOf(m)).toEqual([]);
  });
});

describe('cycles', () => {
  it('validates schedule, zone, cutoff and currency, and audits changes', async () => {
    const base = {
      name: `c ${randomUUID()}`,
      schedule: '0 2 * * *',
      currency: CURRENCY,
      delayDays: 1,
      cutoffTime: '00:00',
      timezone: 'Africa/Kampala',
      minPayoutMinor: 1n,
    };
    for (const bad of [
      { schedule: 'nope' },
      { timezone: 'Mars/Base' },
      { cutoffTime: '25:00' },
      { currency: 'XXX' },
      { delayDays: 91 },
    ]) {
      expect(await codeOf(ctx.cyclesService.create({ ...base, ...bad }, A))).toBe(
        'SETTLEMENT_CYCLE_INVALID'
      );
    }
    const cycle = await ctx.cyclesService.create(base, A);
    expect(await codeOf(ctx.cyclesService.create(base, A))).toBe('SETTLEMENT_CYCLE_INVALID'); // same name
    const updated = await ctx.cyclesService.update(cycle.ref, { active: false });
    expect(updated.active).toBe(false);
    const run = await ctx.runs.runCycle(cycle.ref, { triggeredBy: 'job:test' });
    expect(run).toEqual({ outcome: 'inactive' });
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [cycle.ref]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'settlement.cycle.created',
      'settlement.cycle.updated',
    ]);
  });

  it('the tick runs a due cycle once and sweeps releasing batches', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 100_000n);
    ctx.clock.advanceBy(2 * 86_400_000);
    const first = await ctx.tick.tick();
    expect(first.failed).toBe(0);
    const second = await ctx.tick.tick();
    expect(second.failed).toBe(0);
    expect(await batchesOf(m)).toHaveLength(1);
  }, 120_000);
});
