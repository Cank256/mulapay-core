/**
 * Reconciliation (spec 6.8, Phase 6): the four runs, each against a deliberately injected
 * discrepancy, the exception queue with its approvals, and duplicate or concurrent execution.
 *
 * Live runs use airtel/TZS (also used by the settlement suite, so they are scoped to this
 * suite's own merchant) or flutterwave/GHS, which nothing else touches. Ledger integrity runs
 * in the test environment in MWK, which no other suite uses, and removes its corruption after.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../../src/common/telemetry/metrics';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { AppError } from '../../src/common/errors/app-error';
import { publicId } from '../../src/common/ids/ids';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { ledgerIdempotencyKey } from '../../src/modules/ledger/domain/posting';
import { ReconciliationExceptionRecorder } from '../../src/modules/reconciliation/exception-recorder';
import {
  createPayment,
  createTestMerchant,
  sql,
  toProcessing,
  type TestMerchant,
} from '../support/payments';
import {
  CURRENCY,
  setUpMerchant,
  startSettlementContext,
  succeedPayment,
  superuserUrl,
  type SettlementContext,
} from '../support/settlement';

let ctx: SettlementContext;
const U1 = randomUUID();
const U2 = randomUUID();

beforeAll(async () => {
  ctx = await startSettlementContext();
});
afterAll(async () => {
  await ctx?.close();
});

const key = () => `idem-${randomUUID()}`;
const run = (
  kind: 'gateway_gap' | 'ledger_integrity' | 'provider_statement' | 'balance_proof',
  scope: Parameters<SettlementContext['scheduler']['runManual']>[0]['scope'],
  idempotencyKey = key()
) => ctx.scheduler.runManual({ kind, scope, idempotencyKey, userId: U1 });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppError
      ? error.code
      : error instanceof Error
        ? error.message
        : String(error);
  }
}

async function exceptionsOfTransaction(ref: string) {
  return sql<{ kind: string; severity: string; status: string; occurrences: number }>(
    `select e.kind, e.severity, e.status, e.occurrences
       from core.reconciliation_exceptions e join core.transaction_keys k on k.id = e.transaction_id
      where k.ref = $1 order by e.kind`,
    [ref]
  );
}

async function processingPayment(m: TestMerchant, amount = '10000') {
  const created = await createPayment(m.live!, {
    amountMinor: amount,
    currency: CURRENCY,
    paymentMethod: { provider: 'airtel', msisdn: '+255711000002' },
  });
  const detail = await ctx.paymentsRepository.findDetailByRef(m.scope('live'), created.id);
  await toProcessing(ctx, detail!.payment.id, { identifiers: { provider: 'airtel' } });
  return { ref: created.id, txn: created.transactionId, id: detail!.payment.id };
}

async function stateOfPayment(ref: string) {
  const [row] = await sql<{ status: string; entries: string }>(
    `select t.status, (select count(*) from core.journal_entries e where e.transaction_id = t.id)::text as entries
       from core.transactions t join core.transaction_keys k on k.id = t.id where k.ref = $1`,
    [ref]
  );
  return row!;
}

describe('gateway gap reconciliation', () => {
  it('finds stale processing transactions, asks the gateway, and changes no financial state', async () => {
    const setup = await setUpMerchant(ctx);
    const m = setup.merchant;
    const pending = await processingPayment(m);
    const settled = await processingPayment(m);
    const missing = await processingPayment(m);
    const wrongAmount = await processingPayment(m);
    ctx.clock.advanceBy(20 * 60_000);
    const fresh = await processingPayment(m); // not stale yet

    const op = (externalId: string, status: 'pending' | 'successful', amount = '100.00') =>
      ctx.gateway.addOperation({
        externalId,
        operationType: 'collection',
        status,
        amount,
        currency: CURRENCY,
      });
    op(pending.ref, 'pending');
    op(settled.ref, 'successful');
    op(wrongAmount.ref, 'pending', '99.00');
    op(fresh.ref, 'pending');

    const result = await run('gateway_gap', { environment: 'live', merchantId: m.id });
    expect(result.outcome).toBe('completed');
    expect(result.run).toMatchObject({ status: 'completed', checkedCount: 4 });

    expect(await exceptionsOfTransaction(pending.txn)).toEqual([
      { kind: 'stale_processing_transaction', severity: 'medium', status: 'open', occurrences: 1 },
    ]);
    expect((await exceptionsOfTransaction(settled.txn)).map((e) => e.kind)).toEqual([
      'gateway_state_differs',
    ]);
    expect((await exceptionsOfTransaction(missing.txn)).map((e) => e.kind)).toEqual([
      'core_transaction_missing_at_gateway',
    ]);
    expect(
      (await exceptionsOfTransaction(wrongAmount.txn)).map((e) => [e.kind, e.severity])
    ).toEqual([['gateway_amount_mismatch', 'critical']]);
    expect(await exceptionsOfTransaction(fresh.txn)).toEqual([]);

    // The gateway says "successful", yet core's payment is untouched and nothing was posted.
    expect(await stateOfPayment(settled.txn)).toEqual({ status: 'processing', entries: '0' });
    const detail = await sql<{ expected: unknown; actual: { gatewayStatus: string } }>(
      `select e.expected, e.actual from core.reconciliation_exceptions e join core.transaction_keys k on k.id = e.transaction_id where k.ref = $1`,
      [settled.txn]
    );
    expect(detail[0]?.actual.gatewayStatus).toBe('successful');
  });

  it('raises a stale exception when the gateway cannot be asked, and never changes the payment', async () => {
    const m = (await setUpMerchant(ctx)).merchant;
    const p = await processingPayment(m);
    ctx.clock.advanceBy(20 * 60_000);
    ctx.gateway.lookupStatus = 503;
    try {
      const result = await run('gateway_gap', { environment: 'live', merchantId: m.id });
      expect(result.run?.summary).toMatchObject({ lookupsUnavailable: 1 });
    } finally {
      ctx.gateway.lookupStatus = undefined;
    }
    const [e] = await sql<{ kind: string; actual: { gateway: string } }>(
      `select e.kind, e.actual from core.reconciliation_exceptions e join core.transaction_keys k on k.id = e.transaction_id where k.ref = $1`,
      [p.txn]
    );
    expect(e).toMatchObject({
      kind: 'stale_processing_transaction',
      actual: { gateway: 'unavailable' },
    });
    expect((await stateOfPayment(p.txn)).status).toBe('processing');
  });

  it('finds a gateway operation core has no transaction for', async () => {
    const lost = `pay_${'L'.repeat(26)}`.slice(0, 30) + randomUUID().slice(0, 8);
    ctx.gateway.addOperation({
      externalId: lost,
      operationType: 'collection',
      status: 'successful',
      amount: '50.00',
      currency: CURRENCY,
    });
    ctx.clock.advanceBy(5 * 60_000);
    const result = await run('gateway_gap', { environment: 'live', currency: CURRENCY });
    expect(result.outcome).toBe('completed');
    const found = await sql<{
      kind: string;
      severity: string;
      amount_minor: string;
      gateway_operation_id: string;
    }>(
      `select kind, severity, amount_minor::text, gateway_operation_id from core.reconciliation_exceptions where dedupe_key = $1`,
      [`gap:missing_core:collection:${lost}`]
    );
    expect(found).toEqual([
      {
        kind: 'gateway_operation_missing_in_core',
        severity: 'critical',
        amount_minor: '5000',
        gateway_operation_id: expect.any(String),
      },
    ]);
    expect(result.run?.summary).toMatchObject({
      gatewayOperationsMissingInCore: expect.any(Number),
    });
  });

  it('fails the run, visibly, when half the comparison cannot be made, and retakes it under the same key', async () => {
    const idem = key();
    ctx.gateway.listFails = true;
    await expect(
      run('gateway_gap', { environment: 'live', currency: CURRENCY }, idem)
    ).rejects.toThrow(/gateway_list_unavailable/);
    const [failed] = await sql<{ status: string; error: string; attempts: number }>(
      `select status, error, attempts from core.reconciliation_runs where run_key = $1`,
      [`manual:gateway_gap:${idem}:${JSON.stringify({ environment: 'live', currency: CURRENCY })}`]
    );
    expect(failed).toEqual({ status: 'failed', error: 'Error', attempts: 1 });
    ctx.gateway.listFails = false;
    const retried = await run('gateway_gap', { environment: 'live', currency: CURRENCY }, idem);
    expect(retried.outcome).toBe('completed');
    expect(retried.run).toMatchObject({ status: 'completed', attempts: 2 });
  });
});

describe('duplicate and concurrent execution', () => {
  it('the same window is the same run: nothing is raised twice', async () => {
    const m = (await setUpMerchant(ctx)).merchant;
    const p = await processingPayment(m);
    ctx.clock.advanceBy(20 * 60_000);
    const idem = key();
    const scope = { environment: 'live' as const, merchantId: m.id };
    const first = await run('gateway_gap', scope, idem);
    const second = await run('gateway_gap', scope, idem);
    expect(first.outcome).toBe('completed');
    expect(second.outcome).toBe('duplicate');
    expect(second.run?.id).toBe(first.run?.id);
    expect(await exceptionsOfTransaction(p.txn)).toEqual([
      expect.objectContaining({ kind: 'core_transaction_missing_at_gateway', occurrences: 1 }),
    ]);

    // A later window that still sees the same discrepancy counts it; it does not duplicate it.
    const later = await run('gateway_gap', scope);
    expect(later.outcome).toBe('completed');
    expect(await exceptionsOfTransaction(p.txn)).toEqual([
      expect.objectContaining({ kind: 'core_transaction_missing_at_gateway', occurrences: 2 }),
    ]);
  });

  it('scheduled runs are keyed by their time bucket', async () => {
    const m = (await setUpMerchant(ctx)).merchant;
    const scope = { environment: 'live' as const, currency: 'GHS', merchantId: m.id };
    const a = await ctx.scheduler.runScheduled('balance_proof', scope);
    const b = await ctx.scheduler.runScheduled('balance_proof', scope);
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('duplicate');
    expect(b.run?.id).toBe(a.run?.id);
    // The next day is the next window.
    ctx.clock.advanceBy(86_400_000);
    expect((await ctx.scheduler.runScheduled('balance_proof', scope)).outcome).toBe('completed');
  });

  it('one run per kind and scope at a time, until a dead worker’s lease expires', async () => {
    const m = (await setUpMerchant(ctx)).merchant;
    const scope = { environment: 'live' as const, merchantId: m.id };
    // A worker took the slot and died: a running row whose lease has not ended.
    const [dead] = await sql<{ id: string }>(
      `insert into core.reconciliation_runs (id, ref, kind, scope, scope_key, run_key, triggered_by, started_at, lease_expires_at)
       values (gen_random_uuid(), $1, 'gateway_gap', '{}', $2, $3, 'job:dead', now(), now() + interval '1 year') returning id`,
      [publicId('reconRun'), `env=live;ccy=*;mch=${m.id};stm=*`, `dead-${randomUUID()}`]
    );
    const blocked = await run('gateway_gap', scope);
    expect(blocked.outcome).toBe('in_progress');
    expect(blocked.run?.id).toBe(dead!.id);

    await sql(
      `update core.reconciliation_runs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [dead!.id]
    );
    const taken = await run('gateway_gap', scope);
    expect(taken.outcome).toBe('completed');
    const [old] = await sql<{ status: string; error: string }>(
      `select status, error from core.reconciliation_runs where id = $1`,
      [dead!.id]
    );
    expect(old).toEqual({ status: 'failed', error: 'lease_expired' });
  });

  it('parallel runs of one window never run twice', async () => {
    const m = (await setUpMerchant(ctx)).merchant;
    const scope = { environment: 'live' as const, merchantId: m.id };
    const idem = key();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => run('gateway_gap', scope, idem))
    );
    expect(results.filter((r) => r.outcome === 'completed')).toHaveLength(1);
    expect(new Set(results.map((r) => r.run?.id)).size).toBe(1);
  });
});

describe('ledger integrity reconciliation', () => {
  let su: PgClient;
  const injected: string[] = [];
  let tamper: { accountId: string; delta: number } | undefined;
  const hex = (value: string) => createHash('sha256').update(value).digest('hex');

  async function bypass(work: (c: PgClient) => Promise<void>) {
    await su.query('begin');
    try {
      await su.query('set local session_replication_role = replica');
      await work(su);
      await su.query('commit');
    } catch (error) {
      await su.query('rollback');
      throw error;
    }
  }
  const accounts = () => ctx.app.get(AccountsService, { strict: false });
  async function bank(): Promise<string> {
    const row = await ctx.unitOfWork.run((tx) =>
      accounts().openBankAccount(tx, {
        environment: 'test',
        bankKey: `t${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        name: 'integrity test bank',
        currency: 'MWK',
      })
    );
    return row.code;
  }
  async function accountId(code: string) {
    const r = await su.query<{ id: string }>(
      `select id from core.accounts where environment = 'test' and code = $1`,
      [code]
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    su = new PgClient({ connectionString: superuserUrl() });
    await su.connect();
  });
  afterAll(async () => {
    await bypass(async (c) => {
      if (injected.length > 0) {
        await c.query('delete from core.journal_lines where entry_id = any($1)', [injected]);
        await c.query('delete from core.journal_entries where id = any($1)', [injected]);
      }
      if (tamper) {
        await c.query(
          `update core.account_balances set posted_debits_minor = posted_debits_minor - $2 where account_id = $1 and currency = 'MWK'`,
          [tamper.accountId, tamper.delta]
        );
      }
    });
    await su.end();
  });

  const scope = { environment: 'test' as const, currency: 'MWK' };

  it('finds nothing in a healthy ledger and opens no incident', async () => {
    const b = await bank();
    const c = await bank();
    await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', `healthy-${randomUUID()}`),
        environment: 'test',
        currency: 'MWK',
        source: 'adjustment',
        sourceId: `healthy-${randomUUID()}`,
        description: 'healthy',
        lines: [
          { accountCode: b, direction: 'debit', amountMinor: 500n },
          { accountCode: c, direction: 'credit', amountMinor: 500n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    const result = await run('ledger_integrity', scope);
    expect(result.run).toMatchObject({ status: 'completed', exceptionCount: 0, matchedCount: 6 });
    const incidents = await sql(
      `select 1 from core.incidents where dedupe_key = 'ledger_integrity:test:MWK'`
    );
    expect(incidents).toEqual([]);
  });

  it('detects an unbalanced entry and a disagreeing balance, and opens one sev1 incident however often it runs', async () => {
    const a = await bank();
    const a1 = await accountId(a);
    const id = randomUUID();
    const ref = publicId('journalEntry');
    await bypass(async (c) => {
      await c.query(
        `insert into core.journal_entries (id, ref, idempotency_key, request_fingerprint, environment, currency, kind, description, source, source_id, created_by)
         values ($1, $2, $3, $3, 'test', 'MWK', 'corrupt', 'injected by recon test', 'adjustment', $4, 'system:recon-test')`,
        [id, ref, hex(id), id]
      );
      await c.query(
        `insert into core.journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency) values ($1, 1, $2, 'debit', 50, 'MWK')`,
        [id, a1]
      );
      await c.query(
        `insert into core.account_balances (account_id, currency, posted_debits_minor, posted_credits_minor) values ($1, 'MWK', 13, 0)
         on conflict (account_id, currency) do update set posted_debits_minor = core.account_balances.posted_debits_minor + 13`,
        [a1]
      );
    });
    injected.push(id);
    tamper = { accountId: a1, delta: 13 };

    const first = await run('ledger_integrity', scope);
    expect(first.outcome).toBe('completed');
    expect(first.run?.exceptionCount).toBeGreaterThanOrEqual(2);
    const found = await sql<{ kind: string; severity: string; status: string }>(
      `select kind, severity, status from core.reconciliation_exceptions
        where dedupe_key = $1 or dedupe_key = $2 order by kind`,
      [`ledger:entry:${ref}`, `ledger:balance:test:${a}:MWK`]
    );
    expect(found).toEqual([
      { kind: 'ledger_balance_mismatch', severity: 'critical', status: 'open' },
      { kind: 'ledger_unbalanced_entry', severity: 'critical', status: 'open' },
    ]);

    // The run published what it found, for the scrape.
    const metrics = await metricsRegistry.getSingleMetricAsString('core_ledger_integrity_failures');
    expect(metrics).toMatch(
      /core_ledger_integrity_failures\{[^}]*kind="unbalanced_entry"[^}]*\} 1/
    );

    const incident = async () =>
      sql<{ severity: string; status: string; detection_count: number; source: string }>(
        `select severity, status, detection_count, source from core.incidents where dedupe_key = 'ledger_integrity:test:MWK'`
      );
    expect(await incident()).toEqual([
      { severity: 'sev1', status: 'investigating', detection_count: 1, source: 'reconciliation' },
    ]);

    const second = await run('ledger_integrity', scope);
    expect(second.outcome).toBe('completed');
    const seen = await sql<{ occurrences: number }>(
      `select occurrences from core.reconciliation_exceptions where dedupe_key = $1`,
      [`ledger:entry:${ref}`]
    );
    expect(seen).toEqual([{ occurrences: 2 }]);
    expect(await incident()).toEqual([expect.objectContaining({ detection_count: 2 })]);
    const audit = await sql(
      `select 1 from core.audit_logs where action = 'incident.opened' and after ->> 'source' = 'reconciliation' and resource_type = 'incident'`
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('detects suspense drift, and a merchant payable in a debit position', async () => {
    const b = await bank();
    const suspense = await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', `suspense-${randomUUID()}`),
        environment: 'test',
        currency: 'MWK',
        source: 'adjustment',
        sourceId: `suspense-${randomUUID()}`,
        description: 'unidentified money',
        lines: [
          { accountCode: '9000:suspense', direction: 'debit', amountMinor: 700n },
          { accountCode: b, direction: 'credit', amountMinor: 700n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    expect(suspense.entry.ref).toMatch(/^je_/);
    const m = (await createTestMerchant(ctx, { label: 'neg' })).ref;
    const payable = `2000:merchant_payable:${m}`;
    const pid = await accountId(payable);
    await bypass(async (c) => {
      await c.query(
        `insert into core.account_balances (account_id, currency, posted_debits_minor, posted_credits_minor) values ($1, 'MWK', 9, 0)
         on conflict (account_id, currency) do update set posted_debits_minor = core.account_balances.posted_debits_minor + 9`,
        [pid]
      );
    });
    const result = await run('ledger_integrity', scope);
    expect(result.outcome).toBe('completed');
    const kinds = await sql<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor::text from core.reconciliation_exceptions
        where dedupe_key in ('ledger:suspense:test:MWK', $1)`,
      [`ledger:negative:test:${payable}:MWK`]
    );
    expect(kinds.sort((x, y) => x.kind.localeCompare(y.kind))).toEqual(
      expect.arrayContaining([
        { kind: 'ledger_suspense_nonzero', amount_minor: expect.any(String) },
        { kind: 'ledger_negative_merchant_payable', amount_minor: '9' },
      ])
    );
    await bypass(async (c) => {
      await c.query(
        `delete from core.account_balances where account_id = $1 and currency = 'MWK'`,
        [pid]
      );
    });
  });
});

describe('provider statement matching', () => {
  it('matches by reference, flags a mismatch, an unknown row, a duplicate and a missing core transaction', async () => {
    const setup = await setUpMerchant(ctx);
    const refs = [
      await succeedPayment(ctx, setup, 11_100n),
      await succeedPayment(ctx, setup, 22_200n),
      await succeedPayment(ctx, setup, 33_300n),
      await succeedPayment(ctx, setup, 44_400n),
    ];
    const ptis = await sql<{ ref: string; txn: string; pti: string }>(
      `select p.ref, k.ref as txn, t.provider_transaction_id as pti
         from core.payments p join core.transactions t on t.id = p.transaction_id
         join core.transaction_keys k on k.id = t.id where p.ref = any($1)`,
      [refs]
    );
    const pti = (ref: string) => ptis.find((r) => r.ref === ref)!.pti;
    const txn = (ref: string) => ptis.find((r) => r.ref === ref)!.txn;
    const now = ctx.clock.now();
    const at = (ms: number) => new Date(now.getTime() + ms);
    const statement = await ctx.statements.upload(
      {
        provider: 'airtel',
        currency: CURRENCY,
        periodStart: at(-3_600_000),
        periodEnd: at(3_600_000),
        rows: [
          { providerRef: pti(refs[0]!), amountMinor: '11100', occurredAt: at(0) },
          { providerRef: pti(refs[1]!), amountMinor: '22201', occurredAt: at(0) },
          { providerRef: 'UNKNOWN-777', amountMinor: '777', occurredAt: at(0) },
          { providerRef: pti(refs[0]!), amountMinor: '11100', occurredAt: at(1000) },
        ],
      },
      'user:test'
    );
    expect(statement).toMatchObject({
      status: 'uploaded',
      rowCount: 4,
      totalMinor: 11100n + 22201n + 777n + 11100n,
    });
    expect(
      await sql(
        `select 1 from core.outbox where event_type = 'reconciliation.statement_uploaded' and aggregate_id = $1`,
        [statement.id]
      )
    ).toHaveLength(1);

    // The same statement is not stored twice.
    expect(
      await codeOf(
        ctx.statements.upload(
          {
            provider: 'airtel',
            currency: CURRENCY,
            periodStart: at(-3_600_000),
            periodEnd: at(3_600_000),
            rows: [
              { providerRef: 'UNKNOWN-777', amountMinor: '777', occurredAt: at(0) },
              { providerRef: pti(refs[0]!), amountMinor: '11100', occurredAt: at(1000) },
              { providerRef: pti(refs[1]!), amountMinor: '22201', occurredAt: at(0) },
              { providerRef: pti(refs[0]!), amountMinor: '11100', occurredAt: at(0) },
            ],
          },
          'user:test'
        )
      )
    ).toBe('RECONCILIATION_STATEMENT_DUPLICATE');

    const matched = await ctx.scheduler.runStatementMatch(statement.ref);
    expect(matched.outcome).toBe('completed');
    const rows = await ctx.statements.rows(statement.ref, 0, 10);
    expect(rows.items.map((r) => [r.rowNo, r.matchStatus])).toEqual([
      [1, 'matched_reference'],
      [2, 'mismatch'],
      [3, 'unmatched'],
      [4, 'duplicate'],
    ]);
    const stored = await ctx.statements.findByRef(statement.ref);
    expect(stored).toMatchObject({
      status: 'matched',
      matchedCount: 1,
      mismatchCount: 1,
      unmatchedCount: 1,
      duplicateCount: 1,
    });

    const raised = await sql<{ kind: string; transaction: string | null }>(
      `select e.kind, k.ref as transaction from core.reconciliation_exceptions e left join core.transaction_keys k on k.id = e.transaction_id
        where e.dedupe_key like $1 order by e.kind, k.ref`,
      [`stmt:%${statement.ref}%`]
    );
    const kinds = raised.map((r) => r.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'statement_amount_mismatch',
        'statement_duplicate_row',
        'statement_unmatched_row',
      ])
    );
    const unmatchedCore = raised
      .filter((r) => r.kind === 'statement_unmatched_core_transaction')
      .map((r) => r.transaction);
    expect(unmatchedCore).toEqual(expect.arrayContaining([txn(refs[2]!), txn(refs[3]!)]));
    expect(unmatchedCore).not.toContain(txn(refs[0]!));
    expect(unmatchedCore).not.toContain(txn(refs[1]!));
    const mismatch = await sql<{
      expected: { amountMinor: string };
      actual: { amountMinor: string };
    }>(`select expected, actual from core.reconciliation_exceptions where dedupe_key = $1`, [
      `stmt:amount:${statement.ref}:2`,
    ]);
    expect(mismatch[0]).toMatchObject({
      expected: { amountMinor: '22200' },
      actual: { amountMinor: '22201' },
    });

    // Matching the same statement again is the same run.
    expect((await ctx.scheduler.runStatementMatch(statement.ref)).outcome).toBe('duplicate');
    expect(
      await sql(`select 1 from core.reconciliation_exceptions where dedupe_key = $1`, [
        `stmt:row:${statement.ref}:3`,
      ])
    ).toHaveLength(1);

    // A later statement that repeats a reference an earlier statement matched marks it duplicate.
    const later = await ctx.statements.upload(
      {
        provider: 'airtel',
        currency: CURRENCY,
        periodStart: at(-3_600_000),
        periodEnd: at(7_200_000),
        rows: [{ providerRef: pti(refs[0]!), amountMinor: '11100', occurredAt: at(5000) }],
      },
      'user:test'
    );
    await ctx.scheduler.runStatementMatch(later.ref);
    expect((await ctx.statements.rows(later.ref, 0, 10)).items[0]?.matchNote).toBe(
      'matched_by_earlier_statement'
    );
  });

  it('does not amount-match a transaction that has a provider reference of its own', async () => {
    const setup = await setUpMerchant(ctx);
    await succeedPayment(ctx, setup, 55_500n);
    const now = ctx.clock.now();
    const stmt = await ctx.statements.upload(
      {
        provider: 'airtel',
        currency: CURRENCY,
        periodStart: new Date(now.getTime() - 3_600_000),
        periodEnd: new Date(now.getTime() + 3_600_000),
        rows: [{ providerRef: `NOREF-${randomUUID()}`, amountMinor: '55500', occurredAt: now }],
      },
      'user:test'
    );
    await ctx.scheduler.runStatementMatch(stmt.ref);
    expect((await ctx.statements.rows(stmt.ref, 0, 10)).items[0]?.matchStatus).toBe('unmatched');
  });

  it('refuses statements that are not valid', async () => {
    const now = ctx.clock.now();
    const base = {
      provider: 'airtel',
      currency: CURRENCY,
      periodStart: new Date(now.getTime() - 1000),
      periodEnd: new Date(now.getTime() + 1000),
      rows: [{ providerRef: 'R', amountMinor: '5', occurredAt: now }],
    };
    for (const bad of [
      { provider: 'nobody' },
      { currency: 'JPY' },
      { periodEnd: new Date(now.getTime() - 5000) },
      { rows: [] },
      { rows: [{ providerRef: 'R', amountMinor: '0', occurredAt: now }] },
      {
        rows: [
          { providerRef: 'R', amountMinor: '5', occurredAt: new Date(now.getTime() + 60_000) },
        ],
      },
      { rows: [{ providerRef: '', amountMinor: '5', occurredAt: now }] },
    ]) {
      expect(await codeOf(ctx.statements.upload({ ...base, ...bad }, 'user:test'))).toBe(
        'RECONCILIATION_STATEMENT_INVALID'
      );
    }
  });
});

describe('balance proof', () => {
  let m: TestMerchant;
  const accounts = () => ctx.app.get(AccountsService, { strict: false });
  const scope = { environment: 'live' as const, currency: 'GHS' };
  let su: PgClient;
  const undo: string[] = [];

  async function post(lines: [string, 'debit' | 'credit', bigint][]) {
    await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', `proof-${randomUUID()}`),
        environment: 'live',
        currency: 'GHS',
        source: 'adjustment',
        sourceId: `proof-${randomUUID()}`,
        merchantId: m.id,
        description: 'balance proof fixture',
        lines: lines.map(([accountCode, direction, amountMinor]) => ({
          accountCode,
          direction,
          amountMinor,
        })),
        createdBy: { type: 'system', id: 'test' },
      })
    );
  }

  beforeAll(async () => {
    su = new PgClient({ connectionString: superuserUrl() });
    await su.connect();
    m = await createTestMerchant(ctx, { active: true, label: 'proof' });
    await sql(`update core.merchants set default_currency = 'GHS' where ref = $1`, [m.ref]);
    // 5,000 collected for the merchant, 3,000 of the provider's balance moved to float.
    await post([
      ['1000:provider_clearing:flutterwave', 'debit', 5_000n],
      [`2000:merchant_payable:${m.ref}`, 'credit', 5_000n],
    ]);
    await post([
      ['1010:provider_float:flutterwave', 'debit', 3_000n],
      ['1000:provider_clearing:flutterwave', 'credit', 3_000n],
    ]);
    void accounts;
  });
  afterAll(async () => {
    for (const statementSql of undo) await su.query(statementSql);
    await su.end();
  });

  const bypass = async (statementSql: string, params: unknown[] = []) => {
    await su.query('begin');
    try {
      await su.query('set local session_replication_role = replica');
      await su.query(statementSql, params);
      await su.query('commit');
    } catch (error) {
      await su.query('rollback');
      throw error;
    }
  };

  it('is unavailable, not passed, when the gateway cannot report a balance', async () => {
    ctx.gateway.setBalance('flutterwave', 'collection', 'GHS', '20.00'); // clearing: 2,000 minor
    const result = await run('balance_proof', { ...scope, merchantId: m.id });
    expect(result.outcome).toBe('completed');
    const found = await sql<{ kind: string }>(
      `select kind from core.reconciliation_exceptions where dedupe_key = 'proof:unavailable:flutterwave:disbursement:GHS'`
    );
    expect(found).toEqual([{ kind: 'balance_provider_unavailable' }]);
  });

  it('passes when the ledger and the gateway agree, for provider accounts, payables and reserves', async () => {
    ctx.gateway.setBalance('flutterwave', 'disbursement', 'GHS', '30.00'); // float: 3,000 minor
    const result = await run('balance_proof', { ...scope, merchantId: m.id });
    expect(result.run).toMatchObject({ status: 'completed' });
    expect(result.run?.summary).toMatchObject({
      providerComparisons: 2,
      providerSums: { 'flutterwave:GHS': { ledgerMinor: '5000', gatewayMinor: '5000' } },
    });
    const open = await sql(
      `select 1 from core.reconciliation_exceptions where dedupe_key like 'proof:%GHS%' and status = 'open'
          and kind in ('balance_provider_mismatch', 'balance_merchant_mismatch', 'reserve_mismatch')`
    );
    expect(open).toEqual([]);
  });

  it('flags a provider balance that differs from the ledger beyond the tolerance', async () => {
    ctx.gateway.setBalance('flutterwave', 'collection', 'GHS', '25.00'); // 500 more than the ledger
    const result = await run('balance_proof', { ...scope, merchantId: m.id });
    expect(result.outcome).toBe('completed');
    const [e] = await sql<{
      kind: string;
      severity: string;
      amount_minor: string;
      expected: { balanceMinor: string };
      actual: { balanceMinor: string; differenceMinor: string };
    }>(
      `select kind, severity, amount_minor::text, expected, actual from core.reconciliation_exceptions where dedupe_key = 'proof:provider:flutterwave:provider_clearing:GHS'`
    );
    expect(e).toMatchObject({
      kind: 'balance_provider_mismatch',
      severity: 'critical',
      amount_minor: '500',
      expected: { balanceMinor: '2000' },
      actual: { balanceMinor: '2500', differenceMinor: '500' },
    });
  });

  it('accepts a difference within the configured tolerance', async () => {
    const tolerant = await startSettlementContext({ RECON_BALANCE_TOLERANCE_MINOR: '600' });
    try {
      tolerant.gateway.setBalance('flutterwave', 'collection', 'GHS', '25.00');
      tolerant.gateway.setBalance('flutterwave', 'disbursement', 'GHS', '30.00');
      const result = await tolerant.scheduler.runManual({
        kind: 'balance_proof',
        scope: { ...scope, merchantId: m.id },
        idempotencyKey: key(),
        userId: U1,
      });
      expect(result.run?.matchedCount).toBe(result.run?.checkedCount);
    } finally {
      await tolerant.close();
    }
  });

  it('flags a merchant balance that disagrees with the journal, and a reserve that disagrees with its entries', async () => {
    const [payableId] = (
      await su.query<{ id: string }>(
        `select id from core.accounts where environment = 'live' and code = $1`,
        [`2000:merchant_payable:${m.ref}`]
      )
    ).rows;
    const [reserveId] = (
      await su.query<{ id: string }>(
        `select id from core.accounts where environment = 'live' and code = $1`,
        [`2010:merchant_reserve:${m.ref}`]
      )
    ).rows;
    await bypass(
      `update core.account_balances set posted_credits_minor = posted_credits_minor + 50 where account_id = $1 and currency = 'GHS'`,
      [payableId!.id]
    );
    undo.push(
      `set session_replication_role = replica; update core.account_balances set posted_credits_minor = posted_credits_minor - 50 where account_id = '${payableId!.id}' and currency = 'GHS'`
    );
    await bypass(
      `insert into core.account_balances (account_id, currency, posted_debits_minor, posted_credits_minor) values ($1, 'GHS', 0, 70)
       on conflict (account_id, currency) do update set posted_credits_minor = core.account_balances.posted_credits_minor + 70`,
      [reserveId!.id]
    );
    undo.push(
      `delete from core.account_balances where account_id = '${reserveId!.id}' and currency = 'GHS'`
    );

    const result = await run('balance_proof', { ...scope, merchantId: m.id });
    expect(result.outcome).toBe('completed');
    const found = await sql<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor::text from core.reconciliation_exceptions where dedupe_key in ($1, $2) order by kind`,
      [`proof:merchant:${m.ref}:GHS`, `proof:reserve:${m.ref}:GHS`]
    );
    expect(found).toEqual([
      { kind: 'balance_merchant_mismatch', amount_minor: '50' },
      { kind: 'reserve_mismatch', amount_minor: '70' },
    ]);
  });
});

describe('the exception queue', () => {
  async function newException(amountMinor = 1_000n, dedupe = `queue:${randomUUID()}`) {
    const raised = await ctx.unitOfWork.run((tx) =>
      ctx.app.get(ReconciliationExceptionRecorder, { strict: false }).raise(tx, null, {
        kind: 'statement_unmatched_row',
        dedupeKey: dedupe,
        environment: 'live',
        currency: 'GHS',
        amountMinor,
        expected: { reason: 'queue test' },
        actual: { amountMinor },
      })
    );
    return raised.exception;
  }
  const bankCode = async () =>
    (
      await ctx.unitOfWork.run((tx) =>
        ctx.app.get(AccountsService, { strict: false }).openBankAccount(tx, {
          environment: 'live',
          bankKey: `q${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          name: 'queue bank',
          currency: 'GHS',
        })
      )
    ).code;
  const entriesFor = (sourceId: string) =>
    sql<{ ref: string; kind: string }>(
      `select ref, kind from core.journal_entries where source_id = $1`,
      [sourceId]
    );
  const linesOf = (ref: string) =>
    sql<{ code: string; direction: string; amount: string }>(
      `select a.code, l.direction, l.amount_minor::text as amount from core.journal_lines l
         join core.accounts a on a.id = l.account_id join core.journal_entries e on e.id = l.entry_id where e.ref = $1 order by l.direction, a.code`,
      [ref]
    );

  it('assigns, takes notes, and resolves a match without moving money', async () => {
    const e = await newException();
    const assigned = await ctx.exceptions.assign(e.ref, U2, U1);
    ctx.clock.advanceBy(1000);
    expect(assigned).toMatchObject({ status: 'investigating', assignedTo: U2 });
    await ctx.exceptions.addNote(
      e.ref,
      'Called the provider; they confirm the row is a test transaction.',
      U2
    );
    ctx.clock.advanceBy(1000);
    expect(
      await codeOf(ctx.exceptions.resolve(e.ref, { resolution: 'matched_manually', note: 'x' }, U2))
    ).toBe('RECONCILIATION_RESOLUTION_INVALID');
    const resolved = await ctx.exceptions.resolve(
      e.ref,
      { resolution: 'matched_manually', note: 'Confirmed with the provider' },
      U2
    );
    expect(resolved.exception).toMatchObject({
      status: 'resolved',
      resolution: 'matched_manually',
      resolvedBy: U2,
    });
    expect(resolved.request).toBeNull();
    const detail = await ctx.exceptions.get(e.ref);
    expect(detail.notes.map((n) => n.kind)).toEqual(['assignment', 'note', 'resolution']);
    // A resolved exception is final, in the service and in the database.
    expect(await codeOf(ctx.exceptions.assign(e.ref, U2, U1))).toBe(
      'RECONCILIATION_EXCEPTION_STATE'
    );
    await expect(
      sql(`update core.reconciliation_exceptions set severity = 'low' where id = $1`, [e.id])
    ).rejects.toThrow();
    await expect(
      sql(`delete from core.reconciliation_exception_notes where exception_id = $1`, [e.id])
    ).rejects.toThrow();
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [e.ref]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'reconciliation.exception.assigned',
      'reconciliation.exception.noted',
      'reconciliation.exception.resolved',
    ]);
  });

  it('an approved write-off debits 5100:loss_writeoff and credits the account, once', async () => {
    const e = await newException(1_000n);
    const bank = await bankCode();
    const requested = await ctx.exceptions.resolve(
      e.ref,
      {
        resolution: 'written_off',
        note: 'Provider fee never refunded',
        accountCode: bank,
        amountMinor: '600',
      },
      U1
    );
    expect(requested.request).toMatchObject({
      status: 'pending',
      kind: 'written_off',
      amountMinor: 600n,
    });
    expect(requested.exception.status).toBe('investigating');
    expect(await entriesFor(`writeoff:${requested.request!.ref}`)).toEqual([]);
    // Still waiting: nobody may start a second resolution, or close it by hand.
    expect(
      await codeOf(
        ctx.exceptions.resolve(e.ref, { resolution: 'matched_manually', note: 'ignore it' }, U1)
      )
    ).toBe('RECONCILIATION_EXCEPTION_STATE');

    // Maker-checker, in the service and in the database.
    expect(await codeOf(ctx.exceptions.decide(requested.request!.ref, 'approve', null, U1))).toBe(
      'RECONCILIATION_APPROVER_IS_REQUESTER'
    );
    await expect(
      sql(
        `update core.reconciliation_resolution_requests set status = 'approved', decided_by = requested_by, decided_at = now(), entry_ref = 'x' where id = $1`,
        [requested.request!.id]
      )
    ).rejects.toThrow();

    const decided = await ctx.exceptions.decide(requested.request!.ref, 'approve', 'Agreed', U2);
    expect(decided.exception).toMatchObject({
      status: 'written_off',
      resolution: 'written_off',
      resolvedBy: U2,
    });
    const entries = await entriesFor(`writeoff:${requested.request!.ref}`);
    expect(entries).toHaveLength(1);
    expect(await linesOf(entries[0]!.ref)).toEqual([
      { code: '1100:bank:' + bank.split(':')[2], direction: 'credit', amount: '600' },
      { code: '5100:loss_writeoff', direction: 'debit', amount: '600' },
    ]);
    expect(decided.exception.resolutionEntryRef).toBe(entries[0]!.ref);
    // A second decision is refused and posts nothing more.
    expect(await codeOf(ctx.exceptions.decide(requested.request!.ref, 'approve', null, U2))).toBe(
      'RECONCILIATION_EXCEPTION_STATE'
    );
    expect(await entriesFor(`writeoff:${requested.request!.ref}`)).toHaveLength(1);
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [e.ref]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'reconciliation.resolution.requested',
      'reconciliation.exception.written_off',
    ]);
  });

  it('a rejected write-off posts nothing and leaves the exception open for another resolution', async () => {
    const e = await newException(1_000n);
    const bank = await bankCode();
    const requested = await ctx.exceptions.resolve(
      e.ref,
      { resolution: 'written_off', note: 'Write it off', accountCode: bank, amountMinor: '1000' },
      U1
    );
    const rejected = await ctx.exceptions.decide(
      requested.request!.ref,
      'reject',
      'Evidence missing',
      U2
    );
    expect(rejected.request).toMatchObject({
      status: 'rejected',
      decisionNote: 'Evidence missing',
    });
    expect(rejected.exception.status).toBe('investigating');
    expect(await entriesFor(`writeoff:${requested.request!.ref}`)).toEqual([]);
    expect(await codeOf(ctx.exceptions.decide(requested.request!.ref, 'approve', null, U2))).toBe(
      'RECONCILIATION_EXCEPTION_STATE'
    );
    // It can be resolved another way afterwards.
    const done = await ctx.exceptions.resolve(
      e.ref,
      { resolution: 'matched_manually', note: 'Found the missing row' },
      U1
    );
    expect(done.exception.status).toBe('resolved');
  });

  it('refuses write-offs that could hurt a merchant, exceed the discrepancy or have no amount', async () => {
    const e = await newException(1_000n);
    const merchant = (await createTestMerchant(ctx, { label: 'wo' })).ref;
    const bank = await bankCode();
    const attempt = (accountCode: string, amountMinor: string) =>
      codeOf(
        ctx.exceptions.resolve(
          e.ref,
          { resolution: 'written_off', note: 'try it', accountCode, amountMinor },
          U1
        )
      );
    expect(await attempt(`2000:merchant_payable:${merchant}`, '10')).toBe(
      'RECONCILIATION_RESOLUTION_INVALID'
    );
    expect(await attempt('4000:fee_revenue', '10')).toBe('RECONCILIATION_RESOLUTION_INVALID');
    expect(await attempt(bank, '1001')).toBe('RECONCILIATION_RESOLUTION_INVALID');
    expect(await attempt(bank, '0')).toBe('RECONCILIATION_RESOLUTION_INVALID');
    expect(
      await sql(`select 1 from core.reconciliation_resolution_requests where exception_id = $1`, [
        e.id,
      ])
    ).toEqual([]);
  });

  it('corrects with a reversing entry once approved, and refuses to reverse a reversal', async () => {
    const bank = await bankCode();
    const bank2 = await bankCode();
    const original = await ctx.unitOfWork.run((tx) =>
      ctx.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('adjustment', `wrong-${randomUUID()}`),
        environment: 'live',
        currency: 'GHS',
        source: 'adjustment',
        sourceId: `wrong-${randomUUID()}`,
        description: 'a posting made in error',
        lines: [
          { accountCode: bank, direction: 'debit', amountMinor: 400n },
          { accountCode: bank2, direction: 'credit', amountMinor: 400n },
        ],
        createdBy: { type: 'system', id: 'test' },
      })
    );
    const e = await newException(400n);
    const requested = await ctx.exceptions.resolve(
      e.ref,
      { resolution: 'corrected_with_reversal', note: 'Posted twice', entryRef: original.entry.ref },
      U1
    );
    expect(requested.request).toMatchObject({ kind: 'corrected_with_reversal', status: 'pending' });
    expect(await codeOf(ctx.exceptions.decide(requested.request!.ref, 'approve', null, U1))).toBe(
      'RECONCILIATION_APPROVER_IS_REQUESTER'
    );
    const decided = await ctx.exceptions.decide(requested.request!.ref, 'approve', null, U2);
    expect(decided.exception).toMatchObject({
      status: 'resolved',
      resolution: 'corrected_with_reversal',
    });
    const [reversal] = await sql<{ source: string; reverses: string | null; id: string }>(
      `select e.source, e.reverses_entry_id as reverses, e.id from core.journal_entries e where e.ref = $1`,
      [decided.exception.resolutionEntryRef]
    );
    expect(reversal).toMatchObject({ source: 'reversal' });
    expect(reversal?.reverses).not.toBeNull();
    expect(await linesOf(decided.exception.resolutionEntryRef as string)).toEqual(
      [
        { code: bank2.replace(/^/, ''), direction: 'debit', amount: '400' },
        { code: bank, direction: 'credit', amount: '400' },
      ].sort((a, b) => a.direction.localeCompare(b.direction) || a.code.localeCompare(b.code))
    );

    const again = await newException(400n);
    expect(
      await codeOf(
        ctx.exceptions.resolve(
          again.ref,
          {
            resolution: 'corrected_with_reversal',
            note: 'again',
            entryRef: decided.exception.resolutionEntryRef as string,
          },
          U1
        )
      )
    ).toBe('RECONCILIATION_RESOLUTION_INVALID');
    expect(
      await codeOf(
        ctx.exceptions.resolve(
          again.ref,
          { resolution: 'corrected_with_reversal', note: 'nope', entryRef: 'je_missing' },
          U1
        )
      )
    ).toBe('RECONCILIATION_RESOLUTION_INVALID');
  });

  it('two approvals racing post one entry', async () => {
    const e = await newException(900n);
    const bank = await bankCode();
    const requested = await ctx.exceptions.resolve(
      e.ref,
      { resolution: 'written_off', note: 'race', accountCode: bank, amountMinor: '900' },
      U1
    );
    const U3 = randomUUID();
    const results = await Promise.allSettled([
      ctx.exceptions.decide(requested.request!.ref, 'approve', null, U2),
      ctx.exceptions.decide(requested.request!.ref, 'approve', null, U3),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await entriesFor(`writeoff:${requested.request!.ref}`)).toHaveLength(1);
  });

  it('reports run status, unresolved discrepancies, resolution history and open counts', async () => {
    const e = await newException(5n);
    const status = await ctx.reconReports.status();
    expect(status.latestRuns.map((r) => r.kind)).toEqual([
      'gateway_gap',
      'ledger_integrity',
      'provider_statement',
      'balance_proof',
    ]);
    expect(status.openTotal).toBeGreaterThan(0);
    expect(status.openExceptions.some((c) => c.kind === 'statement_unmatched_row')).toBe(true);
    expect(status.oldestOpenAgeSeconds).not.toBeNull();
    const unresolved = await ctx.reconReports.unresolved({
      kind: 'statement_unmatched_row',
      limit: 200,
    });
    expect(unresolved.items.map((x) => x.ref)).toContain(e.ref);
    expect(unresolved.items.every((x) => x.status === 'open' || x.status === 'investigating')).toBe(
      true
    );
    const history = await ctx.reconReports.history(100);
    expect(history.every((x) => x.status === 'resolved' || x.status === 'written_off')).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    const runs = await ctx.reconReports.listRuns({ kind: 'gateway_gap', limit: 5 });
    expect(runs.items.length).toBeGreaterThan(0);
    expect(await codeOf(ctx.reconReports.getRun('rcr_missing'))).toBe('NOT_FOUND');
    void UnitOfWork;
  });
});
