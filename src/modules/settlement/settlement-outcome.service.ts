/**
 * Applies a gateway outcome to a settlement payout and its batch (spec 3.7, 5.5, 6.9, 17.5).
 * This is the only code that moves settlement money in the ledger, and it runs in the
 * caller's transaction: the Phase 3 event consumer calls it inside its own (spec 8.7), and
 * the status verification job inside a short one of its own.
 *
 *   successful  capture the hold; post the spec 5.5 settlement entries; payout `succeeded`;
 *               batch `paid`; reserve withheld becomes a `reserve_entries` row and the reserve
 *               released into this payout is marked released; tell the merchant
 *   failed, expired, cancelled
 *               release the hold; post nothing; payout `failed`; batch `failed`; the reserve
 *               it claimed is claimable again and its period is settled by a later batch
 *   pending / unknown
 *               the payout is `processing` (flagged unknown if so): nothing posts, nothing is
 *               released, and the hold stays until the gateway says what happened
 *
 * Repeats and late events: an event key is recorded once, so redelivery changes nothing. A
 * success after the batch failed, a failure after it was paid, or an amount that differs from
 * the payout changes nothing and raises a reconciliation exception, because money may have
 * moved at the provider while the ledger says it did not.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { uuidv7 } from '../../common/ids/ids';
import { settlementTransitionsTotal } from '../../common/telemetry/metrics';
import { CLOCK } from '../../common/tokens';
import { MerchantEventsService } from '../events/merchant-events.service';
import { HoldsService } from '../holds/holds.service';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { PostingService } from '../ledger/posting.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { isPaymentProvider } from '../payments/domain/payment-event';
import { ReconciliationExceptionRecorder } from '../reconciliation/exception-recorder';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { BatchStatus } from './domain/batch-state';
import { decidePayoutOutcome, type PayoutSignal } from './domain/payout-outcome';
import { settlementPostings } from './domain/settlement-posting';
import { SettlementBatchesRepository, type BatchRow } from './settlement-batches.repository';
import { SettlementEligibilityRepository } from './settlement-eligibility.repository';
import { toSettlementView } from './settlement.views';

const DAY_MS = 86_400_000;
const FAILURE_CODES = {
  failed: 'gateway_failed',
  expired: 'gateway_expired',
  cancelled: 'gateway_cancelled',
} as const;

export interface OutcomeInput {
  /** The gateway `externalId` of the payout (`po_...`). */
  readonly payoutRef: string;
  /** Gateway `event_id`, or a deterministic key for a status check. */
  readonly eventKey: string;
  readonly signal: PayoutSignal;
}

export type OutcomeResult =
  | { readonly kind: 'applied'; readonly batch: BatchRow }
  | { readonly kind: 'noop' | 'duplicate'; readonly batch: BatchRow }
  /** Refused and recorded; a reconciliation exception names why. */
  | { readonly kind: 'rejected'; readonly batch: BatchRow; readonly reason: string }
  /** Not a settlement payout: the caller keeps looking. */
  | { readonly kind: 'unknown_payout' };

@Injectable()
export class SettlementOutcomeService {
  constructor(
    private readonly batches: SettlementBatchesRepository,
    private readonly eligibility: SettlementEligibilityRepository,
    private readonly transactions: TransactionsRepository,
    private readonly holds: HoldsService,
    private readonly posting: PostingService,
    private readonly merchants: MerchantsRepository,
    private readonly events: MerchantEventsService,
    private readonly recorder: ReconciliationExceptionRecorder,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async apply(tx: Transaction, input: OutcomeInput): Promise<OutcomeResult> {
    const batch = await this.batches.lockByPayoutRef(tx, input.payoutRef);
    if (!batch || !batch.payoutTransactionId) return { kind: 'unknown_payout' };
    if (await this.batches.hasEventKey(tx, batch.id, input.eventKey)) {
      return { kind: 'duplicate', batch };
    }
    const payout = await this.eligibility.payoutTransaction(tx, batch.payoutTransactionId, true);
    if (!payout) throw new Error('settlement payout transaction is missing');

    const decision = decidePayoutOutcome(batch.status as BatchStatus, payout.status, input.signal);
    const signal = input.signal;

    if (decision.action === 'noop') {
      await this.log(tx, batch, 'outcome_noop', input, decision.reason);
      return { kind: 'noop', batch };
    }
    const mismatch =
      decision.action === 'apply_success' &&
      signal.kind === 'succeeded' &&
      (signal.amountMinor !== payout.amountMinor || signal.currency !== payout.currency);
    if (decision.action === 'reject' || mismatch) {
      const reason = mismatch ? 'amount_mismatch' : (decision as { reason: string }).reason;
      await this.reject(tx, batch, payout, input, reason);
      return { kind: 'rejected', batch, reason };
    }

    const createdAt = new Date(payout.createdAtText);
    const now = this.clock.now();
    const identifiers = {
      ...(payout.gatewayReferenceId === null && signal.referenceId
        ? { gatewayReferenceId: signal.referenceId }
        : {}),
    };

    if (decision.action === 'record_processing' && signal.kind === 'processing') {
      await this.transactions.update(tx, payout.id, createdAt, {
        status: 'processing',
        outcomeUnknown: signal.outcomeUnknown,
        ...(payout.status === 'created' ? { initiatedAt: now } : {}),
        ...identifiers,
      });
      await this.log(
        tx,
        batch,
        'outcome_applied',
        input,
        signal.outcomeUnknown ? 'outcome_unknown' : 'processing'
      );
      return { kind: 'applied', batch };
    }

    if (decision.action === 'apply_success' && signal.kind === 'succeeded') {
      const paid = await this.pay(tx, batch, payout, signal, createdAt, identifiers, input);
      return { kind: 'applied', batch: paid };
    }

    if (
      decision.action === 'apply_failure' &&
      (signal.kind === 'failed' || signal.kind === 'expired' || signal.kind === 'cancelled')
    ) {
      return {
        kind: 'applied',
        batch: await this.fail(
          tx,
          batch,
          payout,
          signal.kind,
          createdAt,
          input,
          signal.failureCode
        ),
      };
    }
    throw new Error(`unhandled settlement outcome decision ${decision.action}`);
  }

  private async pay(
    tx: Transaction,
    batch: BatchRow,
    payout: NonNullable<Awaited<ReturnType<SettlementEligibilityRepository['payoutTransaction']>>>,
    signal: Extract<PayoutSignal, { kind: 'succeeded' }>,
    createdAt: Date,
    identifiers: { gatewayReferenceId?: string },
    input: OutcomeInput
  ): Promise<BatchRow> {
    const now = this.clock.now();
    const merchant = await this.merchants.findById(batch.merchantId, tx);
    if (!merchant || !payout.provider || !isPaymentProvider(payout.provider)) {
      throw new Error('settlement payout cannot be posted without a merchant and a provider');
    }
    if (batch.holdId) await this.holds.capture(tx, batch.holdId, `settlement:${batch.id}:capture`);

    const postings = settlementPostings({
      merchantRef: merchant.ref,
      provider: payout.provider,
      payableDrawMinor: batch.payableDrawMinor,
      reserveWithheldMinor: batch.reserveMinor,
      reserveReleasedMinor: batch.reserveReleaseMinor,
    });
    const actor = { type: 'job', id: 'settlement' } as const;
    for (const [suffix, kind, lines, text] of [
      ['release', 'settlement.released', postings.released, 'released to settlement in transit'],
      ['confirm', 'settlement.confirmed', postings.confirmed, 'paid out through the gateway'],
    ] as const) {
      await this.posting.postEntry(tx, {
        idempotencyKey: ledgerIdempotencyKey('settlement', `${batch.ref}:${suffix}`),
        environment: 'live',
        currency: batch.currency,
        source: 'settlement',
        sourceId: `${batch.ref}:${suffix}`,
        kind,
        merchantId: batch.merchantId,
        transactionId: payout.id,
        description: `Settlement ${batch.ref} ${text}`,
        lines,
        createdBy: actor,
      });
    }

    await this.transactions.update(tx, payout.id, createdAt, {
      status: 'succeeded',
      completedAt: now,
      outcomeUnknown: false,
      ...identifiers,
      ...(signal.providerTransactionId && payout.providerTransactionId === null
        ? { providerTransactionId: signal.providerTransactionId }
        : {}),
    });
    await this.batches.releaseClaimed(tx, batch.id, now);
    if (batch.reserveMinor > 0n) {
      await this.batches.insertReserve(tx, {
        id: uuidv7(now),
        merchantId: batch.merchantId,
        currency: batch.currency,
        amountMinor: batch.reserveMinor,
        holdUntil: new Date(now.getTime() + batch.reserveHoldDays * DAY_MS),
        settlementBatchId: batch.id,
        createdAt: now,
      });
    }
    const updated = await this.batches.update(tx, batch.id, { status: 'paid', paidAt: now });
    await this.log(tx, batch, 'outcome_applied', input, 'paid', 'paid');
    await this.audit.record(tx, {
      action: 'settlement.batch.paid',
      resourceType: 'settlement_batch',
      resourceId: batch.ref,
      merchantId: batch.merchantId,
      before: { status: batch.status },
      after: { status: 'paid', netMinor: batch.netMinor, payout: payout.ref },
      actor: { type: 'job', id: 'settlement', label: 'settlement' },
    });
    await this.events.emit(tx, {
      merchantId: batch.merchantId,
      environment: 'live',
      type: 'settlement.paid',
      resourceType: 'settlement',
      resourceId: batch.ref,
      object: { ...toSettlementView(updated, payout.ref), merchant: merchant.ref },
    });
    settlementTransitionsTotal.inc({ to: 'paid' });
    return updated;
  }

  private async fail(
    tx: Transaction,
    batch: BatchRow,
    payout: NonNullable<Awaited<ReturnType<SettlementEligibilityRepository['payoutTransaction']>>>,
    kind: keyof typeof FAILURE_CODES,
    createdAt: Date,
    input: OutcomeInput,
    reported?: string
  ): Promise<BatchRow> {
    const now = this.clock.now();
    // A code the caller supplied (for example `gateway_validation`) is kept when well formed.
    const code =
      reported && /^[a-z][a-z0-9_]{0,63}$/.test(reported) ? reported : FAILURE_CODES[kind];
    if (batch.holdId) await this.holds.release(tx, batch.holdId, `settlement:${batch.id}:release`);
    await this.transactions.update(tx, payout.id, createdAt, {
      status: 'failed',
      completedAt: now,
      outcomeUnknown: false,
      failureCode: code,
    });
    await this.batches.unclaimReserve(tx, batch.id);
    const updated = await this.batches.update(tx, batch.id, {
      status: 'failed',
      failureCode: code,
    });
    await this.log(tx, batch, 'outcome_applied', input, code, 'failed');
    await this.audit.record(tx, {
      action: 'settlement.batch.failed',
      resourceType: 'settlement_batch',
      resourceId: batch.ref,
      merchantId: batch.merchantId,
      before: { status: batch.status },
      after: { status: 'failed', failureCode: code, payout: payout.ref },
      actor: { type: 'job', id: 'settlement', label: 'settlement' },
    });
    settlementTransitionsTotal.inc({ to: 'failed' });
    return updated;
  }

  private async reject(
    tx: Transaction,
    batch: BatchRow,
    payout: NonNullable<Awaited<ReturnType<SettlementEligibilityRepository['payoutTransaction']>>>,
    input: OutcomeInput,
    reason: string
  ): Promise<void> {
    await this.log(tx, batch, 'outcome_rejected', input, reason);
    const signal = input.signal;
    await this.recorder.raise(tx, null, {
      kind: reason === 'amount_mismatch' ? 'gateway_amount_mismatch' : 'late_conflicting_event',
      dedupeKey: `settlement:${reason}:${batch.ref}:${signal.kind}`,
      environment: 'live',
      currency: batch.currency,
      amountMinor: batch.netMinor,
      merchantId: batch.merchantId,
      transactionId: payout.id,
      expected: {
        batch: batch.ref,
        batchStatus: batch.status,
        payoutAmountMinor: payout.amountMinor,
      },
      actual: {
        event: input.eventKey,
        gatewayOutcome: signal.kind,
        reason,
        ...(signal.kind === 'succeeded'
          ? { amountMinor: signal.amountMinor, currency: signal.currency }
          : {}),
      },
    });
  }

  private log(
    tx: Transaction,
    batch: BatchRow,
    kind: string,
    input: OutcomeInput,
    note: string,
    toStatus: string = batch.status
  ) {
    const now = this.clock.now();
    return this.batches.addEvent(tx, {
      id: uuidv7(now),
      batchId: batch.id,
      fromStatus: batch.status,
      toStatus,
      kind,
      eventKey: input.eventKey,
      actor: 'system:gateway',
      note,
      createdAt: now,
    });
  }
}
