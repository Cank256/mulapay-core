/**
 * The payment lifecycle against real Postgres (spec 6.1, 3.7, 5.5, 8.7, 12): success, failure,
 * expiry, cancellation, ambiguous outcomes, duplicate and repeated terminal events, invalid
 * transitions, late events, concurrency and atomicity with the ledger.
 *
 * The events here are what the gateway event consumer and chase job will send.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import {
  transactionEventRejections,
  transactionStateTransitions,
} from '../../src/common/telemetry/metrics';
import {
  PAYMENT_STATUSES,
  decideTransition,
  type PaymentStatus,
} from '../../src/modules/payments/domain/payment-state-machine';
import type { PaymentSignal } from '../../src/modules/payments/domain/payment-event';
import { observePaymentEvent } from '../../src/modules/payments/payment-metrics';
import {
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  eventKey,
  paymentId,
  sql,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let merchant: TestMerchant;

beforeAll(async () => {
  ctx = await startPaymentsContext();
  merchant = await createTestMerchant(ctx, { active: true, label: 'lifecycle' });
});

afterAll(async () => {
  await ctx?.close();
});

interface Row {
  status: string;
  payment_status: string;
  outcome_unknown: boolean;
  completed_at: Date | null;
  failure_code: string | null;
  provider: string | null;
  fee: string;
  net: string;
  initiated_at: Date | null;
}

async function state(ref: string): Promise<Row> {
  const [row] = await sql<Row>(
    `select t.status, p.status as payment_status, t.outcome_unknown, t.completed_at, t.failure_code,
            t.provider, t.fee_minor::text as fee, t.net_minor::text as net, t.initiated_at
       from core.payments p
       join core.transactions t on t.id = p.transaction_id and t.created_at = p.created_at
      where p.ref = $1`,
    [ref]
  );
  if (!row) throw new Error(`payment ${ref} not found`);
  return row;
}

async function entriesFor(ref: string): Promise<string[]> {
  const rows = await sql<{ entry_ref: string }>(
    `select k.entry_ref from core.journal_entries e
       join core.journal_entry_keys k on k.entry_id = e.id and k.entry_created_at = e.created_at
       join core.transactions t on t.id = e.transaction_id
       join core.payments p on p.transaction_id = t.id
      where p.ref = $1`,
    [ref]
  );
  return rows.map((r) => r.entry_ref);
}

async function linesOf(entryRef: string) {
  return sql<{ code: string; direction: string; amount: string }>(
    `select a.code, l.direction, l.amount_minor::text as amount
       from core.journal_entry_keys k
       join core.journal_entries e on e.id = k.entry_id and e.created_at = k.entry_created_at
       join core.journal_lines l on l.entry_id = e.id and l.created_at = e.created_at
       join core.accounts a on a.id = l.account_id
      where k.entry_ref = $1 order by l.line_no`,
    [entryRef]
  );
}

async function events(ref: string) {
  return sql<{
    event_key: string;
    outcome: string;
    from_status: string | null;
    to_status: string;
    rejection_reason: string | null;
    source: string;
  }>(
    `select e.event_key, e.outcome, e.from_status, e.to_status, e.rejection_reason, e.source
       from core.transaction_events e join core.payments p on p.transaction_id = e.transaction_id
      where p.ref = $1 order by e.created_at, e.id`,
    [ref]
  );
}

async function payableBalance(): Promise<{ debits: bigint; credits: bigint }> {
  const [row] = await sql<{ d: string; c: string }>(
    `select b.posted_debits_minor::text as d, b.posted_credits_minor::text as c
       from core.account_balances b join core.accounts a on a.id = b.account_id
      where a.code = $1 and a.environment = 'test' and b.currency = 'UGX'`,
    [`2000:merchant_payable:${merchant.ref}`]
  );
  return { debits: BigInt(row?.d ?? 0), credits: BigInt(row?.c ?? 0) };
}

const IDS = {
  operationId: '0190e8a0-7c11-7aaa-8bbb-0123456789ab',
  referenceId: 'ref-0001',
  providerTransactionId: 'mtn-tx-0001',
};

async function newPayment(overrides: Record<string, unknown> = {}) {
  const payment = await createPayment(merchant.test, overrides);
  return {
    ref: payment.id,
    id: await paymentId(ctx, merchant, payment.id),
    txn: payment.transactionId,
  };
}

describe('a successful payment', () => {
  it('moves created -> processing -> succeeded and posts the collection in the same transaction', async () => {
    const { ref, id } = await newPayment({ amountMinor: '25000' });
    const before = await payableBalance();

    const processing = await toProcessing(ctx, id, { identifiers: { provider: 'mtn', ...IDS } });
    expect(processing).toMatchObject({ result: 'applied', from: 'created', to: 'processing' });
    expect(await state(ref)).toMatchObject({
      status: 'processing',
      payment_status: 'processing',
      outcome_unknown: false,
      provider: 'mtn',
    });
    expect((await state(ref)).initiated_at).not.toBeNull();
    expect(await entriesFor(ref)).toEqual([]);

    const key = eventKey();
    const done = await applyEvent(
      ctx,
      id,
      event(
        { kind: 'succeeded', amountMinor: 25000n, currency: 'UGX' },
        { eventKey: key, identifiers: { provider: 'mtn', ...IDS } }
      )
    );
    expect(done).toMatchObject({ result: 'applied', from: 'processing', to: 'succeeded' });
    const after = await state(ref);
    expect(after).toMatchObject({
      status: 'succeeded',
      payment_status: 'succeeded',
      outcome_unknown: false,
      failure_code: null,
      provider: 'mtn',
      fee: '0',
      net: '25000',
    });
    expect(after.completed_at).not.toBeNull();

    const entries = await entriesFor(ref);
    expect(entries).toEqual([done.result === 'applied' ? done.ledgerEntryRef : 'unreachable']);
    expect(await linesOf(entries[0]!)).toEqual([
      { code: '1000:provider_clearing:mtn', direction: 'debit', amount: '25000' },
      { code: `2000:merchant_payable:${merchant.ref}`, direction: 'credit', amount: '25000' },
    ]);
    const balance = await payableBalance();
    expect(balance.credits - before.credits).toBe(25000n);
    expect(balance.debits - before.debits).toBe(0n);
    // The ledger entry names the business operation it came from.
    const [entry] = await sql<{ source: string; source_id: string; kind: string }>(
      `select e.source, e.source_id, e.kind from core.journal_entries e
         join core.journal_entry_keys k on k.entry_id = e.id and k.entry_created_at = e.created_at
        where k.entry_ref = $1`,
      [entries[0]]
    );
    expect(entry).toEqual({
      source: 'payment',
      source_id: `${ref}:${key}`,
      kind: 'collection.succeeded',
    });
  });

  it('posts the MulaPay fee and the provider fee when the fee engine supplies them', async () => {
    const { ref, id } = await newPayment({ amountMinor: '10000' });
    await toProcessing(ctx, id);
    const done = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded', feeMinor: 150n, providerFeeMinor: 70n })
    );
    expect(done.result).toBe('applied');
    expect(await state(ref)).toMatchObject({ fee: '150', net: '9850' });
    const [entry] = await entriesFor(ref);
    const lines = await linesOf(entry!);
    const totals = { debit: 0n, credit: 0n };
    for (const l of lines) totals[l.direction as 'debit' | 'credit'] += BigInt(l.amount);
    expect(totals.debit).toBe(totals.credit);
    expect(lines.map((l) => `${l.direction}:${l.code}:${l.amount}`)).toEqual([
      'debit:1000:provider_clearing:mtn:10000',
      `credit:2000:merchant_payable:${merchant.ref}:10000`,
      `debit:2000:merchant_payable:${merchant.ref}:150`,
      'credit:4000:fee_revenue:150',
      'debit:5000:provider_fee_expense:70',
      'credit:1000:provider_clearing:mtn:70',
    ]);
  });

  it('refuses a success that does not say which provider collected the money', async () => {
    const { ref, id } = await newPayment();
    await applyEvent(
      ctx,
      id,
      event({ kind: 'processing', outcomeUnknown: false }) // no provider named yet
    );
    await expect(applyEvent(ctx, id, event({ kind: 'succeeded' }))).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
      details: { reason: 'provider_required' },
    });
    expect((await state(ref)).status).toBe('processing');
    expect(await entriesFor(ref)).toEqual([]);
  });

  it('refuses success straight from created: the payment was never submitted', async () => {
    const { ref, id } = await newPayment();
    const res = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } })
    );
    expect(res).toMatchObject({
      result: 'rejected',
      reason: 'invalid_transition',
      status: 'created',
    });
    expect((await state(ref)).status).toBe('created');
    expect(await entriesFor(ref)).toEqual([]);
  });

  it('is visible to the merchant as a status and a timeline, with no provider detail', async () => {
    const { ref, id, txn } = await newPayment();
    await toProcessing(ctx, id, { identifiers: { provider: 'mtn', ...IDS } });
    await applyEvent(ctx, id, event({ kind: 'succeeded' }));
    const view = await merchant.test.get(`/v1/payments/${ref}`);
    expect(view.json().data).toMatchObject({ status: 'succeeded', provider: 'mtn' });
    const transaction = (await merchant.test.get(`/v1/transactions/${txn}`)).json().data;
    expect(transaction.timeline.map((t: { status: string }) => t.status)).toEqual([
      'created',
      'processing',
      'succeeded',
    ]);
    expect(transaction.providerTransactionId).toBe(IDS.providerTransactionId);
    // Gateway ids and internal ids stay inside.
    expect(JSON.stringify(transaction)).not.toContain(IDS.operationId);
    expect(JSON.stringify(transaction)).not.toContain(IDS.referenceId);
  });
});

describe('a failed payment', () => {
  it('records the failure code, completes the payment and posts nothing', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    const res = await applyEvent(
      ctx,
      id,
      event({
        kind: 'failed',
        failureCode: 'insufficient_funds',
        failureReason: 'MSISDN +256700000001 has insufficient funds',
      })
    );
    expect(res).toMatchObject({ result: 'applied', from: 'processing', to: 'failed' });
    const row = await state(ref);
    expect(row).toMatchObject({
      status: 'failed',
      payment_status: 'failed',
      failure_code: 'insufficient_funds',
      outcome_unknown: false,
    });
    expect(row.completed_at).not.toBeNull();
    expect(await entriesFor(ref)).toEqual([]);
    // The merchant sees the code, never the provider's wording.
    const body = (await merchant.test.get(`/v1/payments/${ref}`)).body;
    expect(JSON.parse(body).data.failureCode).toBe('insufficient_funds');
    expect(body).not.toContain('insufficient funds');
    expect(body).not.toContain('700000001');
  });

  it('refuses a failure without a code', async () => {
    const { id } = await newPayment();
    await toProcessing(ctx, id);
    await expect(
      applyEvent(ctx, id, event({ kind: 'failed', failureCode: '' }))
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUEST_INVALID' });
  });

  it('does not move a failed payment later, however the late event arrives', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'failed', failureCode: 'declined' }));
    const late = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } })
    );
    expect(late).toMatchObject({ result: 'rejected', reason: 'terminal_state', status: 'failed' });
    expect((await state(ref)).status).toBe('failed');
    expect(await entriesFor(ref)).toEqual([]);
    const log = await events(ref);
    expect(log.at(-1)).toMatchObject({
      outcome: 'rejected',
      rejection_reason: 'terminal_state',
      from_status: 'failed',
      to_status: 'succeeded',
    });
  });
});

describe('an expired payment', () => {
  it('expires from processing when the gateway says so, and posts nothing', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    const res = await applyEvent(
      ctx,
      id,
      event({ kind: 'expired', failureCode: 'provider_timeout' })
    );
    expect(res).toMatchObject({ result: 'applied', from: 'processing', to: 'expired' });
    expect(await state(ref)).toMatchObject({
      status: 'expired',
      payment_status: 'expired',
      failure_code: 'provider_timeout',
    });
    expect(await entriesFor(ref)).toEqual([]);
  });

  it('refuses expiry for a payment awaiting customer action: only the gateway-defined moves exist', async () => {
    const { ref, id } = await newPayment();
    await applyEvent(ctx, id, event({ kind: 'requires_action' }));
    const res = await applyEvent(ctx, id, event({ kind: 'expired' }));
    expect(res).toMatchObject({ result: 'rejected', reason: 'invalid_transition' });
    expect((await state(ref)).status).toBe('requires_action');
  });

  it('refuses a success that arrives after expiry and records it for reconciliation', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'expired' }));
    const key = eventKey('late');
    const late = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded' }, { eventKey: key, identifiers: { provider: 'mtn' } })
    );
    expect(late).toMatchObject({ result: 'rejected', reason: 'terminal_state', status: 'expired' });
    expect((await state(ref)).status).toBe('expired');
    expect(await entriesFor(ref)).toEqual([]);
    expect((await events(ref)).at(-1)).toMatchObject({
      event_key: key,
      outcome: 'rejected',
      rejection_reason: 'terminal_state',
      source: 'gateway_event',
    });
  });
});

describe('a cancelled payment', () => {
  it('cancels from requires_action, and from created, and posts nothing', async () => {
    const a = await newPayment();
    await applyEvent(ctx, a.id, event({ kind: 'requires_action' }));
    const res = await applyEvent(
      ctx,
      a.id,
      event({ kind: 'cancelled', failureCode: 'customer_cancelled' })
    );
    expect(res).toMatchObject({ result: 'applied', from: 'requires_action', to: 'cancelled' });
    const b = await newPayment();
    const created = await applyEvent(ctx, b.id, event({ kind: 'cancelled' }));
    expect(created).toMatchObject({ result: 'applied', from: 'created', to: 'cancelled' });
    expect(await state(a.ref)).toMatchObject({
      status: 'cancelled',
      failure_code: 'customer_cancelled',
    });
    expect(await state(b.ref)).toMatchObject({ status: 'cancelled', failure_code: null });
    expect(await entriesFor(a.ref)).toEqual([]);
  });

  it('cannot be cancelled once a provider operation is running', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    const res = await applyEvent(ctx, id, event({ kind: 'cancelled' }));
    expect(res).toMatchObject({
      result: 'rejected',
      reason: 'invalid_transition',
      status: 'processing',
    });
    expect((await state(ref)).status).toBe('processing');
  });

  it('ignores a stale processing event after cancellation', async () => {
    const { ref, id } = await newPayment();
    await applyEvent(ctx, id, event({ kind: 'cancelled' }));
    const stale = await toProcessing(ctx, id);
    expect(stale).toMatchObject({
      result: 'rejected',
      reason: 'terminal_state',
      status: 'cancelled',
    });
    expect((await state(ref)).status).toBe('cancelled');
  });
});

describe('an ambiguous outcome', () => {
  it('leaves the payment processing, flagged, and posts nothing', async () => {
    const { ref, id } = await newPayment();
    const res = await applyEvent(
      ctx,
      id,
      event(
        { kind: 'processing', outcomeUnknown: true },
        { identifiers: { provider: 'mtn', ...IDS } }
      )
    );
    expect(res).toMatchObject({ result: 'applied', from: 'created', to: 'processing' });
    expect(await state(ref)).toMatchObject({
      status: 'processing',
      payment_status: 'processing',
      outcome_unknown: true,
      completed_at: null,
    });
    expect(await entriesFor(ref)).toEqual([]);
    // To the merchant it is simply processing.
    expect((await merchant.test.get(`/v1/payments/${ref}`)).json().data.status).toBe('processing');
  });

  it('records a repeated unknown as a no-op and a later known status as an update', async () => {
    const { ref, id } = await newPayment();
    await applyEvent(ctx, id, event({ kind: 'processing', outcomeUnknown: true }));
    const again = await applyEvent(ctx, id, event({ kind: 'processing', outcomeUnknown: true }));
    expect(again).toMatchObject({ result: 'noop', status: 'processing' });
    const known = await applyEvent(ctx, id, event({ kind: 'processing', outcomeUnknown: false }));
    expect(known).toMatchObject({ result: 'updated', status: 'processing' });
    expect((await state(ref)).outcome_unknown).toBe(false);
    const log = await events(ref);
    expect(log.map((e) => e.outcome)).toEqual(['applied', 'applied', 'noop', 'applied']);
  });

  it('is resolved only by a definite event, which then clears the flag and posts', async () => {
    const { ref, id } = await newPayment();
    await applyEvent(
      ctx,
      id,
      event({ kind: 'processing', outcomeUnknown: true }, { identifiers: { provider: 'mtn' } })
    );
    const done = await applyEvent(ctx, id, event({ kind: 'succeeded', amountMinor: 10000n }));
    expect(done).toMatchObject({ result: 'applied', to: 'succeeded' });
    expect(await state(ref)).toMatchObject({ status: 'succeeded', outcome_unknown: false });
    expect(await entriesFor(ref)).toHaveLength(1);
  });

  it('can be resolved as failed, and stays unresolved when nothing definite arrives', async () => {
    const a = await newPayment();
    await applyEvent(ctx, a.id, event({ kind: 'processing', outcomeUnknown: true }));
    await applyEvent(ctx, a.id, event({ kind: 'failed', failureCode: 'declined' }));
    expect(await state(a.ref)).toMatchObject({ status: 'failed', outcome_unknown: false });
    const b = await newPayment();
    await applyEvent(ctx, b.id, event({ kind: 'processing', outcomeUnknown: true }));
    expect(await state(b.ref)).toMatchObject({ status: 'processing', outcome_unknown: true });
  });

  it('is never expired by the clock: the sweep leaves a payment with an operation at the provider', async () => {
    ctx.clock.set(new Date(Date.now() - 2 * 3600 * 1000));
    const unknown = await newPayment();
    const running = await newPayment();
    const waiting = await newPayment();
    const neverSubmitted = await newPayment();
    ctx.clock.set(new Date());
    await applyEvent(ctx, unknown.id, event({ kind: 'processing', outcomeUnknown: true }));
    await toProcessing(ctx, running.id);
    await applyEvent(ctx, waiting.id, event({ kind: 'requires_action' }));
    await ctx.expiry.sweep(500);
    // The control proves the sweep ran and found these payments past their expiry.
    expect((await state(neverSubmitted.ref)).status).toBe('expired');
    for (const p of [unknown, running, waiting]) {
      expect((await state(p.ref)).status).not.toBe('expired');
    }
    expect((await state(unknown.ref)).status).toBe('processing');
    expect((await state(unknown.ref)).outcome_unknown).toBe(true);
    expect((await state(waiting.ref)).status).toBe('requires_action');
  });
});

describe('repeated and duplicate events', () => {
  it('applies one event key once: a redelivered success posts once', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    const input = event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } });
    const first = await applyEvent(ctx, id, input);
    const second = await applyEvent(ctx, id, input);
    const third = await applyEvent(ctx, id, input);
    expect(first.result).toBe('applied');
    expect(second).toMatchObject({ result: 'duplicate', status: 'succeeded' });
    expect(third).toMatchObject({ result: 'duplicate', status: 'succeeded' });
    expect(await entriesFor(ref)).toHaveLength(1);
    const succeededRows = (await events(ref)).filter((e) => e.event_key === input.eventKey);
    expect(succeededRows).toHaveLength(1);
  });

  it('treats the same terminal outcome from a second source as a no-op, not a second posting', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } }));
    const chase = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded' }, { source: 'chase', eventKey: eventKey('chase') })
    );
    expect(chase).toMatchObject({ result: 'noop', status: 'succeeded' });
    expect(await entriesFor(ref)).toHaveLength(1);
    expect((await events(ref)).at(-1)).toMatchObject({ outcome: 'noop', source: 'chase' });
  });

  it('refuses a different terminal outcome after success and keeps the success intact', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } }));
    const before = await state(ref);
    for (const signal of [
      { kind: 'failed', failureCode: 'declined' },
      { kind: 'expired' },
      { kind: 'cancelled' },
      { kind: 'processing', outcomeUnknown: true },
      { kind: 'requires_action' },
    ] as PaymentSignal[]) {
      const res = await applyEvent(ctx, id, event(signal));
      expect(res, signal.kind).toMatchObject({ result: 'rejected', reason: 'terminal_state' });
    }
    expect(await state(ref)).toEqual(before);
    expect(await entriesFor(ref)).toHaveLength(1);
  });

  it('records a refused event once: its redelivery is a duplicate', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'failed', failureCode: 'declined' }));
    const late = event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } });
    expect((await applyEvent(ctx, id, late)).result).toBe('rejected');
    expect((await applyEvent(ctx, id, late)).result).toBe('duplicate');
    const refused = (await events(ref)).filter((e) => e.outcome === 'rejected');
    expect(refused).toHaveLength(1);
  });

  it('counts applied transitions and refused events after commit', async () => {
    const { id } = await newPayment();
    const counter = async (
      metric: typeof transactionStateTransitions | typeof transactionEventRejections,
      labels: Record<string, string>
    ) => {
      const { values } = await metric.get();
      const match = values.find((v) =>
        Object.entries(labels).every(([k, x]) => (v.labels as Record<string, unknown>)[k] === x)
      );
      return match?.value ?? 0;
    };
    const transitions = (labels: Record<string, string>) =>
      counter(transactionStateTransitions, labels);
    const rejections = (labels: Record<string, string>) =>
      counter(transactionEventRejections, labels);
    const t0 = await transitions({ from: 'created', to: 'processing', source: 'gateway_event' });
    const r0 = await rejections({ reason: 'terminal_state', source: 'gateway_event' });
    const a = await toProcessing(ctx, id);
    observePaymentEvent(a, 'gateway_event');
    const done = await applyEvent(ctx, id, event({ kind: 'failed', failureCode: 'declined' }));
    observePaymentEvent(done, 'gateway_event');
    const late = await applyEvent(ctx, id, event({ kind: 'expired' }));
    observePaymentEvent(late, 'gateway_event');
    observePaymentEvent(late, 'gateway_event');
    expect(await transitions({ from: 'created', to: 'processing', source: 'gateway_event' })).toBe(
      t0 + 1
    );
    expect(await rejections({ reason: 'terminal_state', source: 'gateway_event' })).toBe(r0 + 2);
  });
});

describe('verification of a success', () => {
  async function processing(overrides: Record<string, unknown> = {}) {
    const p = await newPayment(overrides);
    await toProcessing(ctx, p.id, { identifiers: { provider: 'mtn', ...IDS } });
    return p;
  }

  it('refuses a different amount and leaves the payment processing', async () => {
    const { ref, id } = await processing({ amountMinor: '10000' });
    const res = await applyEvent(ctx, id, event({ kind: 'succeeded', amountMinor: 9999n }));
    expect(res).toMatchObject({
      result: 'rejected',
      reason: 'amount_mismatch',
      status: 'processing',
    });
    expect(await state(ref)).toMatchObject({ status: 'processing', provider: 'mtn' });
    expect(await entriesFor(ref)).toEqual([]);
    // The right amount still works afterwards.
    expect(
      (await applyEvent(ctx, id, event({ kind: 'succeeded', amountMinor: 10000n }))).result
    ).toBe('applied');
  });

  it('refuses a different currency', async () => {
    const { ref, id } = await processing();
    const res = await applyEvent(ctx, id, event({ kind: 'succeeded', currency: 'KES' }));
    expect(res).toMatchObject({ result: 'rejected', reason: 'currency_mismatch' });
    expect(await entriesFor(ref)).toEqual([]);
  });

  it('refuses a different provider than the one recorded', async () => {
    const { ref, id } = await processing();
    const res = await applyEvent(
      ctx,
      id,
      event({ kind: 'succeeded' }, { identifiers: { provider: 'airtel' } })
    );
    expect(res).toMatchObject({ result: 'rejected', reason: 'provider_mismatch' });
    expect((await state(ref)).status).toBe('processing');
  });

  it('refuses a different gateway identifier than the one recorded', async () => {
    const { ref, id } = await processing();
    for (const identifiers of [
      { referenceId: 'other-ref' },
      { operationId: '0190e8a0-7c11-7aaa-8bbb-ffffffffffff' },
      { providerTransactionId: 'other-tx' },
    ]) {
      const res = await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers }));
      expect(res, JSON.stringify(identifiers)).toMatchObject({
        result: 'rejected',
        reason: 'identifier_conflict',
      });
    }
    expect((await state(ref)).status).toBe('processing');
  });

  it('refuses a repeated success that names a different amount', async () => {
    const { ref, id } = await processing({ amountMinor: '10000' });
    await applyEvent(ctx, id, event({ kind: 'succeeded', amountMinor: 10000n }));
    const odd = await applyEvent(ctx, id, event({ kind: 'succeeded', amountMinor: 20000n }));
    expect(odd).toMatchObject({ result: 'rejected', reason: 'amount_mismatch' });
    expect(await entriesFor(ref)).toHaveLength(1);
  });
});

describe('every ordered pair of statuses', () => {
  const SIGNALS: Record<Exclude<PaymentStatus, 'created'>, PaymentSignal> = {
    requires_action: { kind: 'requires_action' },
    processing: { kind: 'processing', outcomeUnknown: false },
    succeeded: { kind: 'succeeded' },
    failed: { kind: 'failed', failureCode: 'declined' },
    cancelled: { kind: 'cancelled' },
    expired: { kind: 'expired' },
  };

  async function driveTo(status: PaymentStatus) {
    const p = await newPayment();
    const identifiers = { provider: 'mtn' as const };
    const path: Record<PaymentStatus, PaymentSignal[]> = {
      created: [],
      requires_action: [SIGNALS.requires_action],
      processing: [SIGNALS.processing],
      succeeded: [SIGNALS.processing, SIGNALS.succeeded],
      failed: [SIGNALS.processing, SIGNALS.failed],
      cancelled: [SIGNALS.cancelled],
      expired: [SIGNALS.processing, SIGNALS.expired],
    };
    for (const signal of path[status]) {
      const res = await applyEvent(ctx, p.id, event(signal, { identifiers }));
      expect(res.result).toBe('applied');
    }
    expect((await state(p.ref)).status).toBe(status);
    return p;
  }

  for (const from of PAYMENT_STATUSES) {
    it(`from ${from}: applies the allowed moves and refuses the rest`, async () => {
      for (const to of Object.keys(SIGNALS) as Exclude<PaymentStatus, 'created'>[]) {
        const p = await driveTo(from);
        const entriesBefore = (await entriesFor(p.ref)).length;
        const result = await applyEvent(
          ctx,
          p.id,
          event(SIGNALS[to], { identifiers: { provider: 'mtn' } })
        );
        const decision = decideTransition(from, to);
        const label = `${from} -> ${to}`;
        if (decision.kind === 'apply') {
          expect(result, label).toMatchObject({ result: 'applied', from, to });
          expect((await state(p.ref)).status, label).toBe(to);
        } else if (decision.kind === 'noop') {
          expect(result.result, label).toBe('noop');
          expect((await state(p.ref)).status, label).toBe(from);
        } else {
          expect(result, label).toMatchObject({ result: 'rejected', reason: decision.reason });
          expect((await state(p.ref)).status, label).toBe(from);
        }
        const row = await state(p.ref);
        expect(row.payment_status, label).toBe(row.status);
        // Only a success ever posts, and only once.
        const expectedEntries = row.status === 'succeeded' ? 1 : 0;
        expect((await entriesFor(p.ref)).length, label).toBe(
          decision.kind === 'apply' ? expectedEntries : entriesBefore
        );
        expect(await entriesFor(p.ref), label).toHaveLength(expectedEntries);
      }
    });
  }
});

describe('atomicity with the ledger', () => {
  it('rolls the whole success back when the ledger refuses the posting, and applies it on retry', async () => {
    const other = await createTestMerchant(ctx, { active: true, label: 'atomic' });
    const payment = await createPayment(other.test, { amountMinor: '4000' });
    const id = await paymentId(ctx, other, payment.id);
    await toProcessing(ctx, id);
    const code = `2000:merchant_payable:${other.ref}`;
    await sql(`update core.accounts set active = false where code = $1 and environment = 'test'`, [
      code,
    ]);
    const input = event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } });
    await expect(applyEvent(ctx, id, input)).rejects.toBeInstanceOf(AppError);
    // Nothing of the failed attempt remains: not the status, not the event, not an entry.
    expect(await state(payment.id)).toMatchObject({ status: 'processing', completed_at: null });
    expect((await events(payment.id)).map((e) => e.event_key)).not.toContain(input.eventKey);
    expect(await entriesFor(payment.id)).toEqual([]);
    await sql(`update core.accounts set active = true where code = $1 and environment = 'test'`, [
      code,
    ]);
    // The same event, delivered again, now applies: a failed attempt consumed nothing.
    expect((await applyEvent(ctx, id, input)).result).toBe('applied');
    expect(await entriesFor(payment.id)).toHaveLength(1);
  });
});

describe('concurrent events', () => {
  it('30 deliveries of one event apply it once', async () => {
    const { ref, id } = await newPayment();
    await toProcessing(ctx, id);
    const input = event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } });
    const results = await Promise.all(Array.from({ length: 30 }, () => applyEvent(ctx, id, input)));
    expect(results.filter((r) => r.result === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'duplicate')).toHaveLength(29);
    expect(await entriesFor(ref)).toHaveLength(1);
    expect((await events(ref)).filter((e) => e.event_key === input.eventKey)).toHaveLength(1);
  });

  it('30 different success events for one payment post it once', async () => {
    const { ref, id } = await newPayment({ amountMinor: '3000' });
    await toProcessing(ctx, id);
    const before = await payableBalance();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } }))
      )
    );
    expect(results.filter((r) => r.result === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'noop')).toHaveLength(29);
    expect(await entriesFor(ref)).toHaveLength(1);
    const after = await payableBalance();
    expect(after.credits - before.credits).toBe(3000n);
  });

  it('conflicting terminal events leave exactly one outcome and a consistent ledger', async () => {
    for (let round = 0; round < 5; round++) {
      const { ref, id } = await newPayment();
      await toProcessing(ctx, id);
      const succeeded: PaymentSignal = { kind: 'succeeded' };
      const failed: PaymentSignal = { kind: 'failed', failureCode: 'declined' };
      const expired: PaymentSignal = { kind: 'expired' };
      const signals: PaymentSignal[] = [
        ...Array.from({ length: 8 }, () => succeeded),
        ...Array.from({ length: 8 }, () => failed),
        ...Array.from({ length: 4 }, () => expired),
      ];
      const results = await Promise.all(
        signals.map((signal) =>
          applyEvent(ctx, id, event(signal, { identifiers: { provider: 'mtn' } }))
        )
      );
      const applied = results.filter((r) => r.result === 'applied');
      expect(applied).toHaveLength(1);
      const row = await state(ref);
      expect(['succeeded', 'failed', 'expired']).toContain(row.status);
      expect(row.payment_status).toBe(row.status);
      expect(applied[0]).toMatchObject({ to: row.status });
      // Everything else was a repeat of the winner or refused as a late event.
      for (const r of results) {
        if (r.result === 'applied') continue;
        expect(['noop', 'rejected']).toContain(r.result);
        if (r.result === 'rejected') expect(r.reason).toBe('terminal_state');
      }
      expect(await entriesFor(ref)).toHaveLength(row.status === 'succeeded' ? 1 : 0);
      const terminal = (await events(ref)).filter(
        (e) => e.outcome === 'applied' && ['succeeded', 'failed', 'expired'].includes(e.to_status)
      );
      expect(terminal).toHaveLength(1);
    }
  });

  it('parallel cancels and a processing event give one consistent answer', async () => {
    for (let round = 0; round < 5; round++) {
      const { ref, id } = await newPayment();
      const cancels = Array.from({ length: 10 }, () =>
        merchant.test.post(`/v1/payments/${ref}/cancel`, {})
      );
      const processing = toProcessing(ctx, id);
      const [cancelResponses, processed] = [await Promise.all(cancels), await processing];
      const final = (await state(ref)).status;
      if (final === 'cancelled') {
        // The merchant's cancel won: every cancel answered 200 and the event was refused.
        expect(cancelResponses.every((r) => r.statusCode === 200)).toBe(true);
        expect(processed).toMatchObject({ result: 'rejected', reason: 'terminal_state' });
      } else {
        // The provider operation started first: every cancel answered 409 or 200 for none.
        expect(final).toBe('processing');
        expect(processed.result).toBe('applied');
        const codes = cancelResponses.map((r) => r.statusCode);
        expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
        // A cancel that returned 200 happened before the payment moved on, so there is at
        // most the applied cancel... which cannot coexist with `processing` as final.
        expect(codes.filter((c) => c === 200)).toHaveLength(0);
      }
    }
  });
});

describe('payments through links and sessions', () => {
  it('moves the checkout session with its payment, in the same transaction', async () => {
    const created = await merchant.test.post(
      '/v1/checkout-sessions',
      { amountMinor: '8000', currency: 'UGX' },
      { 'idempotency-key': randomUUID() }
    );
    const { id: sessionRef, clientSecret } = created.json().data as {
      id: string;
      clientSecret: string;
    };
    const started = await ctx.sessions.startPayment(
      clientSecret,
      { channel: 'mobile_money', msisdn: '+256700000009' },
      randomUUID()
    );
    const paymentRef = started.body.id;
    const id = await paymentId(ctx, merchant, paymentRef);
    await toProcessing(ctx, id);
    expect(
      (await merchant.test.get(`/v1/checkout-sessions/${sessionRef}`)).json().data.status
    ).toBe('open');
    await applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } }));
    const session = (await merchant.test.get(`/v1/checkout-sessions/${sessionRef}`)).json().data;
    expect(session).toMatchObject({ status: 'complete', paymentId: paymentRef });
    expect(session.completedAt).not.toBeNull();
  });

  it('expires the session when its payment fails', async () => {
    const created = await merchant.test.post(
      '/v1/checkout-sessions',
      { amountMinor: '8000', currency: 'UGX' },
      { 'idempotency-key': randomUUID() }
    );
    const { id: sessionRef, clientSecret } = created.json().data as {
      id: string;
      clientSecret: string;
    };
    const started = await ctx.sessions.startPayment(
      clientSecret,
      { channel: 'mobile_money', msisdn: '+256700000009' },
      randomUUID()
    );
    const id = await paymentId(ctx, merchant, started.body.id);
    await toProcessing(ctx, id);
    await applyEvent(ctx, id, event({ kind: 'failed', failureCode: 'declined' }));
    expect(
      (await merchant.test.get(`/v1/checkout-sessions/${sessionRef}`)).json().data.status
    ).toBe('expired');
  });

  it('does not deadlock when a payment finishes while its session is being expired', async () => {
    for (let round = 0; round < 8; round++) {
      const created = await merchant.test.post(
        '/v1/checkout-sessions',
        { amountMinor: '8000', currency: 'UGX' },
        { 'idempotency-key': randomUUID() }
      );
      const { id: sessionRef, clientSecret } = created.json().data as {
        id: string;
        clientSecret: string;
      };
      const started = await ctx.sessions.startPayment(
        clientSecret,
        { channel: 'mobile_money', msisdn: '+256700000009' },
        randomUUID()
      );
      const id = await paymentId(ctx, merchant, started.body.id);
      await toProcessing(ctx, id);
      const [expire, success] = await Promise.all([
        merchant.test.post(`/v1/checkout-sessions/${sessionRef}/expire`, {}),
        applyEvent(ctx, id, event({ kind: 'succeeded' }, { identifiers: { provider: 'mtn' } })),
      ]);
      // The payment was running at a provider, so the merchant cannot expire the session out
      // from under it, and the success wins.
      expect(expire.statusCode).toBe(409);
      expect(success.result).toBe('applied');
      expect((await state(started.body.id)).status).toBe('succeeded');
    }
  });
});
