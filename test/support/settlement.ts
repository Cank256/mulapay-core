/**
 * Fixtures for the settlement and reconciliation suites: the payments context pointed at a
 * fake gateway over real HTTP, merchants whose payments really succeeded (so the ledger holds
 * their money), a cycle per test, and the services under test.
 *
 * Test files run in parallel against one database, so every test creates its own merchant,
 * cycle and destination. Live money uses airtel and TZS, which no other suite touches, so the
 * provider float and clearing accounts, and the balance proof, are this suite's alone.
 */
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { HoldsService } from '../../src/modules/holds/holds.service';
import { ReconciliationExceptionsService } from '../../src/modules/reconciliation/exceptions.service';
import { ReconciliationScheduler } from '../../src/modules/reconciliation/reconciliation-scheduler.service';
import { ReconciliationReportsService } from '../../src/modules/reconciliation/reconciliation-reports.service';
import { StatementsService } from '../../src/modules/reconciliation/statements.service';
import { RollingReserveService } from '../../src/modules/settlement/rolling-reserve.service';
import { SettlementBatchService } from '../../src/modules/settlement/settlement-batch.service';
import { SettlementBatchesRepository } from '../../src/modules/settlement/settlement-batches.repository';
import { SettlementCyclesService } from '../../src/modules/settlement/settlement-cycles.service';
import { SettlementDestinationsService } from '../../src/modules/settlement/settlement-destinations.service';
import { SettlementOutcomeService } from '../../src/modules/settlement/settlement-outcome.service';
import { SettlementReleaseService } from '../../src/modules/settlement/settlement-release.service';
import { SettlementReportsService } from '../../src/modules/settlement/settlement-reports.service';
import { SettlementRunService } from '../../src/modules/settlement/settlement-run.service';
import { SettlementTickService } from '../../src/modules/settlement/settlement-tick.service';
import { SettlementModule } from '../../src/modules/settlement/settlement.module';
import { ReconciliationModule } from '../../src/modules/reconciliation/reconciliation.module';
import { FAKE_GATEWAY_KEY, startFakeGatewayOps, type FakeGatewayOps } from './fake-gateway-ops';
import {
  createPayment,
  createTestMerchant,
  event,
  applyEvent,
  sql,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from './payments';

export const CURRENCY = 'TZS';
export const PROVIDER = 'airtel' as const;
const DAY_MS = 86_400_000;

export interface SettlementContext extends PaymentsContext {
  readonly gateway: FakeGatewayOps;
  readonly balances: BalancesService;
  readonly holdsService: HoldsService;
  readonly cyclesService: SettlementCyclesService;
  readonly destinations: SettlementDestinationsService;
  readonly reserve: RollingReserveService;
  readonly runs: SettlementRunService;
  readonly batches: SettlementBatchService;
  readonly batchRepo: SettlementBatchesRepository;
  readonly release: SettlementReleaseService;
  readonly outcome: SettlementOutcomeService;
  readonly reports: SettlementReportsService;
  readonly tick: SettlementTickService;
  readonly scheduler: ReconciliationScheduler;
  readonly exceptions: ReconciliationExceptionsService;
  readonly reconReports: ReconciliationReportsService;
  readonly statements: StatementsService;
  readonly posting: PostingService;
}

export async function startSettlementContext(
  overrides: Record<string, string> = {}
): Promise<SettlementContext> {
  const gateway = await startFakeGatewayOps();
  const base = await startPaymentsContext({
    GATEWAY_BASE_URL: gateway.baseUrl,
    GATEWAY_API_KEY: FAKE_GATEWAY_KEY,
    GATEWAY_TIMEOUT_MS: '3000',
    RECON_STALE_MINUTES: '5',
    ...overrides,
  });
  const get = <T>(token: new (...args: never[]) => T): T => base.app.get(token, { strict: false });
  void SettlementModule;
  void ReconciliationModule;
  return {
    ...base,
    gateway,
    balances: get(BalancesService),
    holdsService: get(HoldsService),
    cyclesService: get(SettlementCyclesService),
    destinations: get(SettlementDestinationsService),
    reserve: get(RollingReserveService),
    runs: get(SettlementRunService),
    batches: get(SettlementBatchService),
    batchRepo: get(SettlementBatchesRepository),
    release: get(SettlementReleaseService),
    outcome: get(SettlementOutcomeService),
    reports: get(SettlementReportsService),
    tick: get(SettlementTickService),
    scheduler: get(ReconciliationScheduler),
    exceptions: get(ReconciliationExceptionsService),
    reconReports: get(ReconciliationReportsService),
    statements: get(StatementsService),
    posting: get(PostingService),
    close: async () => {
      await base.close();
      await gateway.close();
    },
  };
}

export interface SettledMerchant {
  readonly merchant: TestMerchant;
  readonly cycleRef: string;
  readonly staffId: string;
  /** Payment refs, in the order they succeeded. */
  readonly payments: string[];
}

/** A staff user id: settlement records who acted, not their credentials. */
export const staffId = () => randomUUID();

/** An active live merchant in TZS on a fresh cycle, with an active airtel destination. */
export async function setUpMerchant(
  ctx: SettlementContext,
  options: { minPayoutMinor?: bigint; destination?: boolean } = {}
): Promise<SettledMerchant> {
  const merchant = await createTestMerchant(ctx, { active: true, label: 'settled' });
  await sql('update core.merchants set default_currency = $2 where ref = $1', [
    merchant.ref,
    CURRENCY,
  ]);
  const staff = staffId();
  const cycle = await ctx.cyclesService.create(
    {
      name: `cycle ${randomUUID()}`,
      schedule: '0 2 * * *',
      currency: CURRENCY,
      delayDays: 0,
      cutoffTime: '00:00',
      timezone: 'UTC',
      minPayoutMinor: options.minPayoutMinor ?? 1_000n,
    },
    staff
  );
  await ctx.cyclesService.assignMerchant(merchant.ref, cycle.ref);
  if (options.destination !== false) {
    await ctx.destinations.set(
      merchant.ref,
      { currency: CURRENCY, provider: PROVIDER, msisdn: '+255700000001' },
      staff
    );
  }
  return { merchant, cycleRef: cycle.ref, staffId: staff, payments: [] };
}

let providerCounter = 0;

/** Creates a live payment and drives it to `succeeded` as the gateway consumer will. */
export async function succeedPayment(
  ctx: SettlementContext,
  m: SettledMerchant,
  amountMinor: bigint,
  feeMinor = 0n
): Promise<string> {
  const live = m.merchant.live;
  if (!live) throw new Error('merchant has no live key');
  const created = await createPayment(live, {
    amountMinor: amountMinor.toString(),
    currency: CURRENCY,
    paymentMethod: { provider: PROVIDER, msisdn: '+255711000001' },
  });
  const detail = await ctx.paymentsRepository.findDetailByRef(m.merchant.scope('live'), created.id);
  if (!detail) throw new Error(`payment ${created.id} not found`);
  const id = detail.payment.id;
  providerCounter += 1;
  await toProcessing(ctx, id, { identifiers: { provider: PROVIDER } });
  const done = await applyEvent(
    ctx,
    id,
    event(
      {
        kind: 'succeeded',
        amountMinor,
        currency: CURRENCY,
        ...(feeMinor > 0n ? { feeMinor } : {}),
      },
      {
        identifiers: {
          provider: PROVIDER,
          providerTransactionId: `AIR-${randomUUID().slice(0, 12)}-${providerCounter}`,
        },
      }
    )
  );
  if (done.result !== 'applied')
    throw new Error(`payment did not succeed: ${JSON.stringify(done)}`);
  m.payments.push(created.id);
  return created.id;
}

/**
 * `asOf` for a run that settles everything completed so far: six hours into the day `days`
 * ahead, so the period end (a midnight) is far enough behind it whatever time the test runs.
 */
export function runDate(ctx: SettlementContext, days = 2): Date {
  const at = new Date(ctx.clock.now().getTime() + days * DAY_MS);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + 6 * 3_600_000);
}

export interface Rows {
  readonly entries: number;
  readonly lines: number;
}

/** Journal entries a settlement batch posted (none before it is paid). */
export async function settlementEntries(batchRef: string) {
  return sql<{ ref: string; kind: string; source_id: string }>(
    `select ref, kind, source_id from core.journal_entries where source = 'settlement' and source_id like $1 order by source_id`,
    [`${batchRef}:%`]
  );
}

export async function accountBalance(code: string, currency = CURRENCY): Promise<bigint> {
  const rows = await sql<{ debits: string; credits: string; normal: string }>(
    `select b.posted_debits_minor::text as debits, b.posted_credits_minor::text as credits, a.normal_balance as normal
       from core.account_balances b join core.accounts a on a.id = b.account_id
      where a.environment = 'live' and a.code = $1 and b.currency = $2`,
    [code, currency]
  );
  const row = rows[0];
  if (!row) return 0n;
  const debits = BigInt(row.debits);
  const credits = BigInt(row.credits);
  return row.normal === 'debit' ? debits - credits : credits - debits;
}

export function superuserUrl(): string {
  return inject('databaseUrls').superuser;
}
