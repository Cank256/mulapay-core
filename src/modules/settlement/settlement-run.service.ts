/**
 * Settlement cycle runs (spec 6.9): for each eligible merchant, compute what is payable for
 * the period and create a `draft` batch, or roll a dust amount into the next cycle.
 *
 * Idempotency, at two levels:
 *  - a run is unique per (cycle, period end): running the same period again returns the
 *    first run and does nothing;
 *  - a batch is unique per (merchant, cycle, currency, period) while it is live, so even a
 *    re-driven run (after a crash, or a failed merchant) cannot create a second batch.
 *
 * A merchant's period starts where its latest live batch ended (or at the beginning of time),
 * so periods never overlap and nothing falls between two batches. An amount below the
 * cycle's minimum creates no batch: its payments stay unsettled and are included in the
 * next period automatically. Each merchant is processed in its own transaction, so one
 * failure does not block the others; a run with any failed merchant is `failed` and is
 * taken again under the same key.
 *
 * Nothing is posted to the ledger here, or at any point before a payout succeeds.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { settlementTransitionsTotal } from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { BalancesService } from '../balances/balances.service';
import { computeSettlement, type SettlementAmounts } from './domain/settlement-calc';
import { SETTLEMENT_EPOCH, settlementPeriodEnd } from './domain/settlement-period';
import { RollingReserveService } from './rolling-reserve.service';
import {
  SettlementBatchesRepository,
  type NewItem,
  type RunRow,
} from './settlement-batches.repository';
import { SettlementCyclesRepository, type CycleRow } from './settlement-cycles.repository';
import {
  SettlementEligibilityRepository,
  type EligibleMerchant,
} from './settlement-eligibility.repository';

/**
 * A payment that completed before the period end may commit a little after it: its
 * `completed_at` is the clock when its transaction began. A run therefore waits until the
 * period end is this far behind, longer than any transaction can stay open (statement and
 * idle-in-transaction timeouts are 15 s and 10 s), so every payment of the period is visible.
 */
export const COMMIT_SAFETY_MS = 60_000;
const MERCHANT_PAGE = 100;
const ITEM_PAGE = 2000;
/** A running run older than this belongs to a worker that died. */
const RUN_LEASE_MS = 15 * 60_000;

export type RunOutcome =
  | { readonly outcome: 'completed'; readonly run: RunRow }
  | { readonly outcome: 'duplicate'; readonly run: RunRow }
  | { readonly outcome: 'in_progress'; readonly run: RunRow }
  | { readonly outcome: 'failed'; readonly run: RunRow }
  | { readonly outcome: 'inactive' }
  /** The period ended less than `COMMIT_SAFETY_MS` ago: try again shortly. */
  | { readonly outcome: 'too_early'; readonly periodEnd: Date };

interface MerchantResult {
  readonly kind: 'batch' | 'rolled_over' | 'nothing' | 'existing' | 'up_to_date';
  readonly rolledOverMinor?: bigint;
}

@Injectable()
export class SettlementRunService {
  constructor(
    private readonly cycles: SettlementCyclesRepository,
    private readonly batches: SettlementBatchesRepository,
    private readonly eligibility: SettlementEligibilityRepository,
    private readonly balances: BalancesService,
    private readonly reserve: RollingReserveService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Runs the cycle for the period that ends at `asOf`'s cutoff. Safe to repeat. */
  async runCycle(
    cycleRef: string,
    options: { asOf?: Date; triggeredBy: string }
  ): Promise<RunOutcome> {
    const cycle = await this.cycles.findByRef(cycleRef);
    if (!cycle) throw new AppError('NOT_FOUND');
    if (!cycle.active) return { outcome: 'inactive' };
    const asOf = options.asOf ?? this.clock.now();
    const periodEnd = settlementPeriodEnd(asOf, cycle);
    if (asOf.getTime() - periodEnd.getTime() < COMMIT_SAFETY_MS) {
      return { outcome: 'too_early', periodEnd };
    }

    const claim = await this.unitOfWork.run((tx) =>
      this.claim(tx, cycle, asOf, periodEnd, options.triggeredBy)
    );
    if (claim.kind !== 'started') return { outcome: claim.kind, run: claim.run };

    const totals = { considered: 0, batches: 0, rolledOver: 0, nothing: 0, failed: 0 };
    const rolled: { merchant: string; minor: string }[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page: EligibleMerchant[] = await this.eligibility.eligibleMerchants(
        cycle.id,
        afterId,
        MERCHANT_PAGE
      );
      if (page.length === 0) break;
      for (const merchant of page) {
        totals.considered += 1;
        try {
          const result = await this.unitOfWork.run((tx) =>
            this.settleMerchant(tx, cycle, claim.run, merchant, periodEnd, asOf)
          );
          if (result.kind === 'batch') totals.batches += 1;
          else if (result.kind === 'rolled_over') {
            totals.rolledOver += 1;
            rolled.push({ merchant: merchant.ref, minor: String(result.rolledOverMinor ?? 0n) });
          } else if (result.kind === 'nothing' || result.kind === 'up_to_date') totals.nothing += 1;
        } catch (error) {
          totals.failed += 1;
          this.logger.error(
            { err: toLoggableError(error), merchant: merchant.ref, cycle: cycle.ref },
            'settlement failed for merchant'
          );
        }
      }
      afterId = page.at(-1)?.id ?? null;
      if (page.length < MERCHANT_PAGE) break;
    }

    const status = totals.failed === 0 ? 'completed' : 'failed';
    const finished = await this.unitOfWork.run(async (tx) => {
      const row = await this.batches.finishRun(tx, claim.run.id, {
        status,
        now: this.clock.now(),
        merchantsConsidered: totals.considered,
        batchesCreated: totals.batches,
        rolledOver: totals.rolledOver,
        nothingToSettle: totals.nothing,
        failedMerchants: totals.failed,
        summary: { rolledOver: rolled.slice(0, 500) },
      });
      await this.audit.record(tx, {
        action: status === 'completed' ? 'settlement.run.completed' : 'settlement.run.failed',
        resourceType: 'settlement_run',
        resourceId: row.ref,
        after: {
          cycle: cycle.ref,
          periodEnd: periodEnd.toISOString(),
          batches: totals.batches,
          rolledOver: totals.rolledOver,
          failedMerchants: totals.failed,
        },
        outcome: status === 'completed' ? 'success' : 'error',
        actor: auditActor(options.triggeredBy),
      });
      return row;
    });
    return { outcome: status, run: finished };
  }

  private async claim(
    tx: Transaction,
    cycle: CycleRow,
    asOf: Date,
    periodEnd: Date,
    triggeredBy: string
  ): Promise<
    { kind: 'started'; run: RunRow } | { kind: 'duplicate' | 'in_progress'; run: RunRow }
  > {
    const now = this.clock.now();
    const inserted = await this.batches.insertRunIfNew(tx, {
      id: uuidv7(now),
      ref: publicId('settlementRun', now),
      cycleId: cycle.id,
      periodEnd,
      asOf,
      triggeredBy,
      startedAt: now,
      createdAt: now,
    });
    if (inserted) return { kind: 'started', run: inserted };
    const existing = await this.batches.lockRun(tx, cycle.id, periodEnd);
    if (!existing) throw new Error('settlement run vanished');
    if (existing.status === 'completed') return { kind: 'duplicate', run: existing };
    if (
      existing.status === 'running' &&
      now.getTime() - existing.startedAt.getTime() < RUN_LEASE_MS
    ) {
      return { kind: 'in_progress', run: existing };
    }
    return {
      kind: 'started',
      run: await this.batches.retakeRun(tx, existing.id, now, triggeredBy),
    };
  }

  private async settleMerchant(
    tx: Transaction,
    cycle: CycleRow,
    run: RunRow,
    merchant: EligibleMerchant,
    periodEnd: Date,
    asOf: Date
  ): Promise<MerchantResult> {
    // One settlement computation per merchant and cycle at a time, across workers.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`settlement:${merchant.id}:${cycle.id}`}, 0))`
    );
    const computed = await this.compute(tx, cycle, merchant.id, periodEnd, asOf);
    if (computed.kind === 'up_to_date') return { kind: 'up_to_date' };
    const { start, decision, due, terms } = computed;
    if (decision.kind === 'nothing') return { kind: 'nothing' };
    if (decision.kind === 'roll_over') {
      return { kind: 'rolled_over', rolledOverMinor: decision.amounts.netMinor };
    }

    const now = this.clock.now();
    const batchId = uuidv7(now);
    const a = decision.amounts;
    const batch = await this.batches.insert(tx, {
      id: batchId,
      ref: publicId('settlementBatch', now),
      merchantId: merchant.id,
      cycleId: cycle.id,
      runId: run.id,
      currency: cycle.currency,
      periodStart: start,
      periodEnd,
      grossMinor: a.grossMinor,
      refundMinor: a.refundMinor,
      feeMinor: a.feeMinor,
      reserveMinor: a.reserveMinor,
      reserveReleaseMinor: a.reserveReleaseMinor,
      disputeHoldMinor: a.disputeHoldMinor,
      amlHoldMinor: a.amlHoldMinor,
      shortfallMinor: a.shortfallMinor,
      payableDrawMinor: a.payableDrawMinor,
      netMinor: a.netMinor,
      minPayoutMinor: cycle.minPayoutMinor,
      reserveHoldDays: terms.holdDays,
      createdBy: 'job:settlement',
      createdAt: now,
    });
    await this.writeItems(
      tx,
      batch.id,
      cycle.currency,
      merchant.id,
      start,
      periodEnd,
      a,
      due.map((e) => e.amountMinor)
    );
    await this.batches.claimReserve(
      tx,
      due.map((e) => e.id),
      batch.id
    );
    await this.batches.addEvent(tx, {
      id: uuidv7(now),
      batchId: batch.id,
      fromStatus: null,
      toStatus: 'draft',
      kind: 'transition',
      actor: 'job:settlement',
      note: `created by ${run.ref}`,
      createdAt: now,
    });
    await this.audit.record(tx, {
      action: 'settlement.batch.created',
      resourceType: 'settlement_batch',
      resourceId: batch.ref,
      merchantId: merchant.id,
      after: {
        cycle: cycle.ref,
        currency: batch.currency,
        grossMinor: batch.grossMinor,
        netMinor: batch.netMinor,
        reserveMinor: batch.reserveMinor,
        reserveReleaseMinor: batch.reserveReleaseMinor,
      },
      actor: { type: 'job', id: 'settlement', label: 'settlement' },
    });
    settlementTransitionsTotal.inc({ to: 'draft' });
    return { kind: 'batch' };
  }

  /**
   * Reads everything the payable depends on and applies the calculation. Writes nothing, so
   * the payables preview and the run give the same answer for the same data.
   */
  private async compute(
    tx: Transaction,
    cycle: CycleRow,
    merchantId: string,
    periodEnd: Date,
    asOf: Date
  ) {
    const start =
      (await this.batches.watermark(tx, merchantId, cycle.id, cycle.currency)) ?? SETTLEMENT_EPOCH;
    if (start.getTime() >= periodEnd.getTime()) return { kind: 'up_to_date' as const };
    const totals = await this.eligibility.periodTotals(
      tx,
      merchantId,
      cycle.currency,
      start,
      periodEnd
    );
    const holds = await this.eligibility.activeHolds(tx, merchantId, cycle.currency);
    const due = await this.batches.dueReserve(tx, merchantId, cycle.currency, asOf);
    const terms = await this.reserve.termsFor(tx, merchantId, cycle.currency);
    const balance = await this.balances.merchantBalance(merchantId, 'live', cycle.currency, tx);
    const decision = computeSettlement({
      grossMinor: totals.grossMinor,
      refundMinor: totals.refundMinor,
      feeMinor: totals.feeMinor,
      reserveBps: terms.percentBps,
      reserveDueMinor: due.reduce((sum, e) => sum + e.amountMinor, 0n),
      disputeHoldMinor: holds.disputeMinor,
      amlHoldMinor: holds.amlMinor,
      availablePayableMinor: balance.availableMinor,
      minPayoutMinor: cycle.minPayoutMinor,
    });
    return { kind: 'computed' as const, start, decision, due, terms };
  }

  /** What each eligible merchant would be paid if the cycle ran now. Read-only. */
  async preview(
    cycleRef: string,
    options: { asOf?: Date; afterId?: string; limit: number }
  ): Promise<{
    periodEnd: Date;
    items: {
      merchant: EligibleMerchant;
      periodStart: Date | null;
      decision: 'settle' | 'roll_over' | 'nothing' | 'up_to_date';
      amounts: SettlementAmounts | null;
    }[];
    nextAfterId: string | null;
  }> {
    const cycle = await this.cycles.findByRef(cycleRef);
    if (!cycle) throw new AppError('NOT_FOUND');
    const asOf = options.asOf ?? this.clock.now();
    const periodEnd = settlementPeriodEnd(asOf, cycle);
    const page = await this.eligibility.eligibleMerchants(
      cycle.id,
      options.afterId ?? null,
      options.limit
    );
    const items = [];
    for (const merchant of page) {
      const computed = await this.unitOfWork.run((tx) =>
        this.compute(tx, cycle, merchant.id, periodEnd, asOf)
      );
      items.push(
        computed.kind === 'up_to_date'
          ? { merchant, periodStart: null, decision: 'up_to_date' as const, amounts: null }
          : {
              merchant,
              periodStart: computed.start,
              decision: computed.decision.kind,
              amounts: computed.decision.amounts,
            }
      );
    }
    return {
      periodEnd,
      items,
      nextAfterId: page.length === options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Items for every payment and refund in the period, plus the reserve and hold lines. */
  private async writeItems(
    tx: Transaction,
    batchId: string,
    currency: string,
    merchantId: string,
    start: Date,
    end: Date,
    a: SettlementAmounts,
    releasedReserve: readonly bigint[]
  ): Promise<void> {
    let after: { completedAt: Date; id: string } | null = null;
    const seen = { gross: 0n, fee: 0n, refund: 0n };
    for (;;) {
      const page = await this.eligibility.periodTransactions(
        tx,
        merchantId,
        currency,
        start,
        end,
        after,
        ITEM_PAGE
      );
      if (page.length === 0) break;
      const now = this.clock.now();
      const items: NewItem[] = page.map((t) => ({
        id: uuidv7(now),
        batchId,
        transactionId: t.id,
        transactionRef: t.ref,
        kind: t.type,
        currency,
        amountMinor: t.amountMinor,
        feeMinor: t.feeMinor,
        netMinor: t.amountMinor - t.feeMinor,
        occurredAt: t.completedAt,
        createdAt: now,
      }));
      await this.batches.insertItems(tx, items);
      for (const t of page) {
        if (t.type === 'payment') {
          seen.gross += t.amountMinor;
          seen.fee += t.feeMinor;
        } else {
          seen.refund += t.amountMinor;
        }
      }
      const last = page.at(-1);
      after = last ? { completedAt: last.completedAt, id: last.id } : null;
      if (page.length < ITEM_PAGE) break;
    }
    // The calculation and the items were read at slightly different moments (read committed).
    // A batch whose items do not add up to its amounts must not exist: fail this merchant, and
    // the retry reads a settled picture.
    if (seen.gross !== a.grossMinor || seen.fee !== a.feeMinor || seen.refund !== a.refundMinor) {
      throw new Error('settlement_snapshot_changed');
    }
    const now = this.clock.now();
    const lines: [NewItem['kind'], bigint][] = [
      ['reserve_withheld', a.reserveMinor],
      ['reserve_released', releasedReserve.reduce((s, n) => s + n, 0n)],
      ['dispute_hold', a.disputeHoldMinor],
      ['aml_hold', a.amlHoldMinor],
    ];
    await this.batches.insertItems(
      tx,
      lines
        .filter(([, amount]) => amount > 0n)
        .map(([kind, amount]) => ({
          id: uuidv7(now),
          batchId,
          kind,
          currency,
          amountMinor: amount,
          netMinor: amount,
          createdAt: now,
        }))
    );
  }
}

function auditActor(triggeredBy: string) {
  const [type, ...rest] = triggeredBy.split(':');
  return {
    type: type === 'user' ? ('user' as const) : ('job' as const),
    id: rest.join(':') || null,
    label: triggeredBy,
  };
}
