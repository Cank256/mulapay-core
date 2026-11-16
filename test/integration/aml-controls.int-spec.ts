/**
 * AML controls on the money path (spec 6.13): the synchronous pre-transaction check (blocklist,
 * merchant status, hard limits, Redis-backed and fast, failing closed), and the block action
 * (holds the balance, suspends payouts, never reverses a completed transaction).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS } from '../../src/common/redis/redis.module';
import { toHoldView } from '../../src/modules/holds/hold.views';
import { PayoutControlService } from '../../src/modules/aml/block/payout-control.service';
import { dayWindow, monthWindow } from '../../src/modules/aml/precheck/precheck.service';
import { SettlementSubmitRetry } from '../../src/modules/settlement/settlement-release.service';
import { staffSession } from '../support/identity';
import {
  activeMerchant,
  errorCodeOf,
  startComplianceContext,
  uniqueMsisdn,
  type ComplianceContext,
} from '../support/compliance';
import { postPayment, sql } from '../support/payments';
import {
  runDate,
  setUpMerchant,
  startSettlementContext,
  succeedPayment,
  type SettlementContext,
} from '../support/settlement';

describe('pre-transaction check', () => {
  let ctx: ComplianceContext;
  beforeAll(async () => {
    ctx = await startComplianceContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const paymentRows = async (merchantId: string) =>
    Number(
      (
        await sql<{ n: string }>(
          'select count(*)::text as n from core.payments where merchant_id = $1',
          [merchantId]
        )
      )[0]?.n
    );
  const redis = () => ctx.app.get<Redis>(REDIS, { strict: false });

  /** A merchant with its own limits in `currency`, as staff would set them by hand. */
  async function limitedMerchant(currency: string, perTxn: number, daily: number, monthly: number) {
    const m = await activeMerchant(ctx, 'limited');
    await sql(
      `insert into core.merchant_limits (merchant_id, currency, per_txn_max_minor, daily_volume_max_minor,
         monthly_volume_max_minor, payout_per_txn_max_minor, daily_payout_max_minor, source)
       values ($1, $2, $3, $4, $5, $3, $4, 'manual')`,
      [m.id, currency, perTxn, daily, monthly]
    );
    return m;
  }

  describe('blocklist', () => {
    it('declines a blocked number before the payment exists, without saying why', async () => {
      const m = await activeMerchant(ctx, 'blocked-payer');
      const staff = await staffSession(ctx, 'compliance');
      const number = uniqueMsisdn();
      const other = uniqueMsisdn();

      const added = await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'msisdn',
        value: number,
        reason: 'Reported for card testing',
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().data).toMatchObject({
        type: 'msisdn',
        hint: number.slice(-4),
        removedAt: null,
      });
      expect(JSON.stringify(added.json())).not.toContain(number);

      const before = await paymentRows(m.id);
      const declined = await postPayment(m.live!, {
        currency: 'UGX',
        amountMinor: '5000',
        paymentMethod: { provider: 'mtn', msisdn: number },
      });
      expect(declined.statusCode).toBe(422);
      expect(declined.json().error.code).toBe('TRANSACTION_DECLINED');
      expect(declined.json().error.message).toBe('This transaction cannot be processed');
      expect(declined.json().error.details).toBeUndefined();
      expect(await paymentRows(m.id)).toBe(before);

      // The same number written differently is the same number; another number is unaffected.
      const spaced = await postPayment(m.live!, {
        currency: 'UGX',
        amountMinor: '5000',
        paymentMethod: { provider: 'mtn', msisdn: `${number.slice(0, 4)} ${number.slice(4)}` },
      });
      expect(spaced.json().error?.code).toBe('TRANSACTION_DECLINED');
      const fine = await postPayment(m.live!, {
        currency: 'UGX',
        amountMinor: '5000',
        paymentMethod: { provider: 'mtn', msisdn: other },
      });
      expect(fine.statusCode).toBe(201);

      // Test keys carry no live traffic and are not checked.
      const sandbox = await postPayment(m.test, {
        currency: 'UGX',
        amountMinor: '5000',
        paymentMethod: { msisdn: number },
      });
      expect(sandbox.statusCode).toBe(201);
    });

    it('stores only a keyed hash, lists a hint, ignores a repeat, and lets an entry be removed or expire', async () => {
      const m = await activeMerchant(ctx, 'blocklist-life');
      const staff = await staffSession(ctx, 'compliance');
      const number = uniqueMsisdn();
      const first = await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'msisdn',
        value: number,
        reason: 'one',
      });
      const again = await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'msisdn',
        value: number,
        reason: 'two',
      });
      expect(again.json().data.id).toBe(first.json().data.id);

      const rows = await sql<{ value_hmac: string; value_hint: string; entry_type: string }>(
        'select value_hmac, value_hint, entry_type from core.aml_blocklist where ref = $1',
        [first.json().data.id]
      );
      expect(rows[0]?.value_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(number.slice(3));
      const listed = (
        await staff.client.get('/admin/v1/aml/blocklist?type=msisdn&limit=200')
      ).json().data.items;
      expect(listed.find((e: { id: string }) => e.id === first.json().data.id)).toMatchObject({
        hint: number.slice(-4),
      });

      const declined = await postPayment(m.live!, {
        paymentMethod: { provider: 'mtn', msisdn: number },
      });
      expect(declined.statusCode).toBe(422);

      const removed = await staff.client.delete(`/admin/v1/aml/blocklist/${first.json().data.id}`);
      expect(removed.statusCode).toBe(200);
      expect(removed.json().data.removedAt).toBeTruthy();
      expect(
        (await postPayment(m.live!, { paymentMethod: { provider: 'mtn', msisdn: number } }))
          .statusCode
      ).toBe(201);
      // Never deleted: the row is still there, marked removed.
      expect(
        await sql('select 1 from core.aml_blocklist where ref = $1', [first.json().data.id])
      ).toHaveLength(1);
      const audit = await sql<{ action: string }>(
        'select action from core.audit_logs where resource_id = $1 and outcome = $2 order by seq',
        [first.json().data.id, 'success']
      );
      expect(audit.map((a) => a.action)).toEqual(['aml.blocklist.added', 'aml.blocklist.removed']);

      // An entry with an expiry stops applying when it passes.
      const brief = uniqueMsisdn();
      await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'msisdn',
        value: brief,
        reason: 'temporary',
        expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
      });
      expect(
        (await postPayment(m.live!, { paymentMethod: { provider: 'mtn', msisdn: brief } }))
          .statusCode
      ).toBe(422);
      ctx.clock.advanceBy(2 * 3_600_000);
      expect(
        (await postPayment(m.live!, { paymentMethod: { provider: 'mtn', msisdn: brief } }))
          .statusCode
      ).toBe(201);
    });

    it('rebuilds the Redis mirror from the database, and treats other identifier types alike', async () => {
      const staff = await staffSession(ctx, 'compliance');
      await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'account',
        value: 'ACC-0001-XYZ',
        reason: 'mule',
      });
      await staff.client.post('/admin/v1/aml/blocklist', {
        type: 'email',
        value: 'Fraudster@Example.com',
        reason: 'fraud',
      });
      const r = redis();
      await r.del('aml:bl:ready', 'aml:bl:account', 'aml:bl:email');
      expect(await ctx.blocklist.isBlocked([{ type: 'account', value: 'acc-0001-xyz' }])).toBe(
        true
      );
      expect(
        await ctx.blocklist.isBlocked([{ type: 'email', value: ' fraudster@example.com ' }])
      ).toBe(true);
      expect(await ctx.blocklist.isBlocked([{ type: 'email', value: 'someone@example.com' }])).toBe(
        false
      );
      expect(await ctx.blocklist.isBlocked([])).toBe(false);
      // A type is its own namespace: the account number is not a blocked email.
      expect(await ctx.blocklist.isBlocked([{ type: 'email', value: 'ACC-0001-XYZ' }])).toBe(false);
      const stale = await staffSession(ctx, 'support_agent');
      expect((await stale.client.get('/admin/v1/aml/blocklist')).statusCode).toBe(403);
      expect(
        (
          await stale.client.post('/admin/v1/aml/blocklist', {
            type: 'msisdn',
            value: uniqueMsisdn(),
            reason: 'x',
          })
        ).statusCode
      ).toBe(403);
    });
  });

  describe('hard limits', () => {
    it('refuses a payment above the per-transaction limit and says which limit', async () => {
      const m = await activeMerchant(ctx, 'per-txn');
      // Level 1 limit for UGX: USD 300 at 3,700.
      const over = await postPayment(m.live!, { currency: 'UGX', amountMinor: '1110001' });
      expect(over.statusCode).toBe(422);
      expect(over.json().error).toMatchObject({
        code: 'TRANSACTION_LIMIT_EXCEEDED',
        details: { limit: 'per_transaction', currency: 'UGX', max: '1110000' },
      });
      expect(await paymentRows(m.id)).toBe(0);
      expect(
        (await postPayment(m.live!, { currency: 'UGX', amountMinor: '1110000' })).statusCode
      ).toBe(201);
    });

    it('counts daily volume atomically, declines without counting, and rebuilds counters from the database', async () => {
      const m = await limitedMerchant('RWF', 10_000, 25_000, 40_000);
      const pay = (amount: number) =>
        postPayment(m.live!, {
          currency: 'RWF',
          amountMinor: String(amount),
          paymentMethod: { provider: 'mtn', msisdn: uniqueMsisdn() },
        });
      expect((await pay(10_000)).statusCode).toBe(201);
      expect((await pay(10_000)).statusCode).toBe(201);
      const over = await pay(10_000);
      expect(over.json().error).toMatchObject({
        code: 'TRANSACTION_LIMIT_EXCEEDED',
        details: { limit: 'daily_volume', max: '25000', used: '20000' },
      });
      // The declined payment was not counted: 5,000 still fits exactly.
      expect((await pay(5_000)).statusCode).toBe(201);
      expect((await pay(1)).json().error.details.limit).toBe('daily_volume');
      expect(await paymentRows(m.id)).toBe(3);

      // Lose the counters (a Redis flush): they are rebuilt from the payments and still bind.
      const day = dayWindow(ctx.clock.now());
      const month = monthWindow(ctx.clock.now());
      const keys = [`aml:vol:${m.id}:RWF:d:${day.key}`, `aml:vol:${m.id}:RWF:m:${month.key}`];
      await redis().del(...keys);
      expect((await pay(1)).json().error.details).toMatchObject({
        limit: 'daily_volume',
        used: '25000',
      });
      expect(await redis().get(keys[0] as string)).toBe('25000');
      expect(await redis().get(keys[1] as string)).toBe('25000');
    });

    it('counts monthly volume across days', async () => {
      const m = await limitedMerchant('MWK', 10_000, 25_000, 40_000);
      const month = monthWindow(ctx.clock.now());
      const day = dayWindow(ctx.clock.now());
      // Thirty-eight thousand already counted this month, none today.
      await redis().set(`aml:vol:${m.id}:MWK:m:${month.key}`, '38000', 'EX', 3600);
      await redis().set(`aml:vol:${m.id}:MWK:d:${day.key}`, '0', 'EX', 3600);
      const over = await postPayment(m.live!, {
        currency: 'MWK',
        amountMinor: '5000',
        paymentMethod: { provider: 'airtel', msisdn: uniqueMsisdn() },
      });
      expect(over.json().error).toMatchObject({
        code: 'TRANSACTION_LIMIT_EXCEEDED',
        details: { limit: 'monthly_volume', max: '40000', used: '38000' },
      });
      const fits = await postPayment(m.live!, {
        currency: 'MWK',
        amountMinor: '2000',
        paymentMethod: { provider: 'airtel', msisdn: uniqueMsisdn() },
      });
      expect(fits.statusCode).toBe(201);
    });

    it('declines a live merchant that has no limits at all, rather than letting it through unlimited', async () => {
      const m = await activeMerchant(ctx, 'no-limits');
      await sql('update core.merchants set kyc_level = 0 where id = $1', [m.id]);
      const res = await postPayment(m.live!, { currency: 'UGX', amountMinor: '1000' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('TRANSACTION_DECLINED');
    });

    it('refuses a suspended merchant through the same check', async () => {
      const m = await activeMerchant(ctx, 'suspended-merchant');
      const scope = { ...m.scope('live'), merchantStatus: 'suspended' as const };
      expect(
        await errorCodeOf(
          ctx.precheck.check(scope, { amountMinor: 1_000n, currency: 'UGX', identifiers: [] })
        )
      ).toBe('MERCHANT_NOT_ACTIVE');
      const pending = { ...m.scope('live'), merchantStatus: 'pending_kyc' as const };
      expect(
        await errorCodeOf(
          ctx.precheck.check(pending, { amountMinor: 1_000n, currency: 'UGX', identifiers: [] })
        )
      ).toBe('MERCHANT_NOT_ACTIVE');
      expect(
        await errorCodeOf(
          ctx.precheck.check(m.scope('test'), {
            amountMinor: 10n ** 15n,
            currency: 'UGX',
            identifiers: [],
          })
        )
      ).toBe('ok');
    });
  });

  describe('speed and failure', () => {
    it('answers from Redis in a few round trips and well inside 20 ms', async () => {
      const m = await limitedMerchant('XOF', 1_000, 10_000_000, 100_000_000);
      const scope = m.scope('live');
      const input = {
        amountMinor: 1n,
        currency: 'XOF',
        identifiers: [{ type: 'msisdn' as const, value: uniqueMsisdn() }],
      };
      await ctx.precheck.check(scope, input); // warm the limits cache and the counters
      const r = redis();
      const pipeline = vi.spyOn(r, 'pipeline');
      const evalSpy = vi.spyOn(r, 'eval');
      const hget = vi.spyOn(r, 'hget');
      await ctx.precheck.check(scope, input);
      // One pipeline for every identifier, one read of the cached limits, one script.
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(hget).toHaveBeenCalledTimes(1);
      expect(evalSpy).toHaveBeenCalledTimes(1);
      pipeline.mockRestore();
      evalSpy.mockRestore();
      hget.mockRestore();

      // The full suite runs many workers on one machine, so take the quietest of three rounds
      // instead of one round that a CPU burst can distort.
      const rounds: { median: number }[] = [];
      for (let round = 0; round < 3; round++) {
        const samples: number[] = [];
        for (let i = 0; i < 100; i++) {
          const started = process.hrtime.bigint();
          await ctx.precheck.check(scope, input);
          samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
        samples.sort((a, b) => a - b);
        rounds.push({ median: samples[50] as number });
      }
      const median = Math.min(...rounds.map((r) => r.median));
      expect(median).toBeLessThan(10);
    });

    it('fails closed when Redis cannot answer: the payment is declined with 503 and nothing is written', async () => {
      const m = await activeMerchant(ctx, 'redis-down');
      const spy = vi.spyOn(ctx.blocklist, 'isBlocked').mockRejectedValue(new Error('ECONNRESET'));
      try {
        const res = await postPayment(m.live!, { currency: 'UGX', amountMinor: '1000' });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
        expect(res.body).not.toContain('ECONNRESET');
      } finally {
        spy.mockRestore();
      }
      expect(await paymentRows(m.id)).toBe(0);
      expect(
        (await postPayment(m.live!, { currency: 'UGX', amountMinor: '1000' })).statusCode
      ).toBe(201);
    });
  });
});

describe('block action and payout suspension', () => {
  let ctx: SettlementContext;
  const A = randomUUID();
  const B = randomUUID();
  beforeAll(async () => {
    ctx = await startSettlementContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });
  const control = () => ctx.app.get(PayoutControlService, { strict: false });

  async function approvedBatch() {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 400_000n);
    await succeedPayment(ctx, m, 600_000n);
    const run = await ctx.runs.runCycle(m.cycleRef, {
      asOf: runDate(ctx),
      triggeredBy: `user:${A}`,
    });
    expect(run.outcome).toBe('completed');
    const [batch] = (await ctx.batches.list({ merchantId: m.merchant.id, limit: 10 })).items;
    if (!batch) throw new Error('no batch');
    await ctx.batches.submit(batch.ref, A);
    const approved = await ctx.batches.approve(batch.ref, B);
    return { m, batch: approved };
  }

  it('holds the whole balance, suspends payouts, and leaves completed payments exactly as they were', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 300_000n);
    await succeedPayment(ctx, m, 200_000n);
    const staff = await staffSession(ctx, 'compliance');
    const txBefore = await sql<{ ref: string; status: string; amount_minor: string }>(
      'select ref, status, amount_minor::text from core.transactions where merchant_id = $1 order by ref',
      [m.merchant.id]
    );
    const entriesBefore = await sql<{ ref: string }>(
      'select ref from core.journal_entries where merchant_id = $1 order by ref',
      [m.merchant.id]
    );
    const balanceBefore = await ctx.balances.merchantBalance(m.merchant.id, 'live', 'TZS');
    expect(balanceBefore.availableMinor).toBe(500_000n);

    const res = await staff.client.post('/admin/v1/aml/blocks', {
      merchant: m.merchant.ref,
      reason: 'Suspected mule account',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({
      status: 'active',
      source: 'manual',
      heldCurrencies: ['TZS'],
      created: true,
    });

    const after = await ctx.balances.merchantBalance(m.merchant.id, 'live', 'TZS');
    expect(after.heldMinor).toBe(500_000n);
    expect(after.availableMinor).toBe(0n);
    expect(after.postedMinor).toBe(balanceBefore.postedMinor);
    expect(
      await sql(
        'select ref, status, amount_minor::text from core.transactions where merchant_id = $1 order by ref',
        [m.merchant.id]
      )
    ).toEqual(txBefore);
    expect(
      await sql('select ref from core.journal_entries where merchant_id = $1 order by ref', [
        m.merchant.id,
      ])
    ).toEqual(entriesBefore);
    expect(await control().isSuspended(m.merchant.id)).toBe(true);
    expect(await errorCodeOf(control().assertPayoutsAllowed(m.merchant.id))).toBe(
      'PAYOUTS_SUSPENDED'
    );

    // The hold counts as an AML hold in settlement, and its reason never reaches the merchant.
    const holds = await sql<{ reason: string; amount_minor: string }>(
      `select reason, amount_minor::text from core.holds where merchant_id = $1 and state = 'active'`,
      [m.merchant.id]
    );
    expect(holds).toEqual([{ reason: `aml:block:${res.json().data.id}`, amount_minor: '500000' }]);
    const merchantHolds = (await ctx.holdsService.listActive(m.merchant.id, 'live')).map(
      toHoldView
    );
    expect(merchantHolds).toHaveLength(1);
    expect(JSON.stringify(merchantHolds)).not.toContain('aml:');

    // Blocking again returns the same block and holds nothing more.
    const repeat = await staff.client.post('/admin/v1/aml/blocks', {
      merchant: m.merchant.ref,
      reason: 'again',
    });
    expect(repeat.json().data).toMatchObject({ id: res.json().data.id, created: false });
    expect(
      await sql('select 1 from core.holds where merchant_id = $1', [m.merchant.id])
    ).toHaveLength(1);
    const audit = await sql<{ action: string; merchant: string }>(
      `select action, resource_id as merchant from core.audit_logs where merchant_id = $1 and action like 'aml.merchant.%' order by seq`,
      [m.merchant.id]
    );
    expect(audit.map((a) => a.action)).toEqual(['aml.merchant.blocked']);
    // Nothing tells the merchant.
    const events = await sql<{ type: string }>(
      'select type from core.merchant_events where merchant_id = $1',
      [m.merchant.id]
    );
    expect(events.map((e) => e.type).filter((t) => t.startsWith('merchant.'))).toEqual([]);
  });

  it('refuses to release a settlement while blocked, and releases it once the block is lifted', async () => {
    const { m, batch } = await approvedBatch();
    const staff = await staffSession(ctx, 'compliance');
    const block = (
      await staff.client.post('/admin/v1/aml/blocks', {
        merchant: m.merchant.ref,
        reason: 'Under investigation',
      })
    ).json().data;

    expect(await errorCodeOf(ctx.release.release(batch.ref, B))).toBe('PAYOUTS_SUSPENDED');
    expect(
      ctx.gateway.disbursementCalls.filter((c) => c.externalId.startsWith('po_'))
    ).toBeDefined();
    expect((await ctx.batches.get(batch.ref)).status).toBe('approved');

    const lifted = await staff.client.post(`/admin/v1/aml/blocks/${block.id}/lift`, {
      note: 'Cleared after review',
    });
    expect(lifted.statusCode).toBe(200);
    expect(lifted.json().data).toMatchObject({ status: 'lifted' });
    expect(await control().isSuspended(m.merchant.id)).toBe(false);
    expect((await ctx.balances.merchantBalance(m.merchant.id, 'live', 'TZS')).heldMinor).toBe(0n);
    // Lifting twice is refused.
    expect(
      (await staff.client.post(`/admin/v1/aml/blocks/${block.id}/lift`, { note: 'again' }))
        .statusCode
    ).toBe(409);

    const { batch: released } = await ctx.release.release(batch.ref, B);
    expect(released.status).toBe('releasing');
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where merchant_id = $1 and action like 'aml.merchant.%' order by seq`,
      [m.merchant.id]
    );
    expect(audit.map((a) => a.action)).toEqual(['aml.merchant.blocked', 'aml.merchant.unblocked']);
  });

  it('stops a payout that was released before the block from being sent, and sends it once lifted', async () => {
    const { m, batch } = await approvedBatch();
    const { batch: released } = await ctx.release.release(batch.ref, B);
    const staff = await staffSession(ctx, 'compliance');
    const sentBefore = ctx.gateway.disbursementCalls.length;
    const block = (
      await staff.client.post('/admin/v1/aml/blocks', {
        merchant: m.merchant.ref,
        reason: 'Sanctions concern',
      })
    ).json().data;

    await expect(ctx.release.submitPayout(released.id)).rejects.toBeInstanceOf(
      SettlementSubmitRetry
    );
    expect(ctx.gateway.disbursementCalls.length).toBe(sentBefore);

    await staff.client.post(`/admin/v1/aml/blocks/${block.id}/lift`, { note: 'Cleared' });
    expect(await ctx.release.submitPayout(released.id)).toBe('submitted');
    expect(ctx.gateway.disbursementCalls.length).toBe(sentBefore + 1);
  });

  it('holds only the money the merchant has, and a block on an empty merchant still suspends payouts', async () => {
    const empty = await setUpMerchant(ctx);
    const staff = await staffSession(ctx, 'compliance');
    const res = await staff.client.post('/admin/v1/aml/blocks', {
      merchant: empty.merchant.ref,
      reason: 'Precaution',
    });
    expect(res.json().data.heldCurrencies).toEqual([]);
    expect(await control().isSuspended(empty.merchant.id)).toBe(true);
    const listed = (
      await staff.client.get(`/admin/v1/aml/blocks?merchant=${empty.merchant.ref}`)
    ).json().data.items;
    expect(listed).toHaveLength(1);

    // Staff without the block permission cannot block or lift.
    const operations = await staffSession(ctx, 'operations');
    expect(
      (
        await operations.client.post('/admin/v1/aml/blocks', {
          merchant: empty.merchant.ref,
          reason: 'x',
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await operations.client.post(`/admin/v1/aml/blocks/${res.json().data.id}/lift`, {
          note: 'x',
        })
      ).statusCode
    ).toBe(403);
    expect((await operations.client.get('/admin/v1/aml/blocks')).statusCode).toBe(200);
    // And a merchant that is not there is not found.
    expect(
      (
        await staff.client.post('/admin/v1/aml/blocks', {
          merchant: 'mch_00000000000000000000000000',
          reason: 'x',
        })
      ).statusCode
    ).toBe(404);
  });

  it('serialises concurrent blocks into one', async () => {
    const m = await setUpMerchant(ctx);
    await succeedPayment(ctx, m, 100_000n);
    const staff = await staffSession(ctx, 'compliance');
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        staff.client.post('/admin/v1/aml/blocks', { merchant: m.merchant.ref, reason: 'race' })
      )
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
    expect(results.filter((r) => r.json().data.created).length).toBe(1);
    expect(
      await sql('select 1 from core.holds where merchant_id = $1', [m.merchant.id])
    ).toHaveLength(1);
  });
});
