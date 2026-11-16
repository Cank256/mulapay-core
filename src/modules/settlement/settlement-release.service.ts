/**
 * Releasing an approved settlement batch to the merchant (spec 6.3, 6.9, 3.5).
 *
 * Release is three separate steps, because no outbound call may happen inside a database
 * transaction (spec 4.3) and a payout must never be created twice:
 *
 *  1. `release`  (transaction, with the approver's request): validates the merchant and the
 *     destination, creates the payout as a `settlement` transaction with its gateway
 *     `externalId` (`po_...`), places a hold on the payable balance for what will leave it,
 *     moves the batch to `releasing`, and writes an outbox message. A second call finds the
 *     batch already `releasing` and returns it: no second payout, no second hold.
 *  2. `submitPayout`  (a queued job, after commit): sends the disbursement with that same
 *     `externalId`. Whatever happens, a retry sends the same key, so the gateway answers
 *     "duplicate" instead of paying twice.
 *  3. the outcome arrives from the gateway event consumer or from `verifyPayout`, and
 *     `SettlementOutcomeService` captures or releases the hold.
 *
 * What a gateway answer does to the payout:
 *    accepted      `processing` (and a terminal status in the answer is applied at once)
 *    400 / 409     the gateway refused before creating an operation: the payout `failed`, the
 *                  hold is released. A core bug, so it is logged at error level
 *    401 / 403 / 404 / 429   nothing was created and nothing is decided: the job fails and is
 *                  retried with the same key
 *    504, timeout, 5xx, unreadable answer   `processing` with `outcome_unknown`: the hold
 *                  stays and the payout waits for the gateway's own event or a status check.
 *                  It is never retried under a new key and never assumed either way
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { markAuditNotApplicable } from '../../common/context/request-context';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { OutboxService } from '../../common/outbox/outbox.service';
import { settlementTransitionsTotal } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import {
  GATEWAY_OPERATIONS,
  isTerminalGatewayStatus,
  type GatewayOperationsPort,
  type GatewayStatus,
} from '../../integrations/gateway/gateway-operations.port';
import { toMinor } from '../../integrations/gateway/money';
import { HoldsService } from '../holds/holds.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { assertTransition, type BatchStatus } from './domain/batch-state';
import type { PayoutSignal } from './domain/payout-outcome';
import { SettlementBatchesRepository, type BatchRow } from './settlement-batches.repository';
import { SettlementDestinationsService } from './settlement-destinations.service';
import { SettlementEligibilityRepository } from './settlement-eligibility.repository';
import { SettlementOutcomeService } from './settlement-outcome.service';

export const SETTLEMENT_SUBMIT_OUTBOX_TYPE = 'settlement.submit_payout';

export type SubmitResult =
  'submitted' | 'failed' | 'unknown_outcome' | 'already_submitted' | 'not_releasing';

/** Thrown to make the queue retry the job: nothing was decided at the gateway. */
export class SettlementSubmitRetry extends Error {
  constructor(readonly reason: string) {
    super(`settlement payout not submitted: ${reason}`);
    this.name = 'SettlementSubmitRetry';
  }
}

@Injectable()
export class SettlementReleaseService {
  constructor(
    private readonly batches: SettlementBatchesRepository,
    private readonly eligibility: SettlementEligibilityRepository,
    private readonly destinations: SettlementDestinationsService,
    private readonly merchants: MerchantsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly holds: HoldsService,
    private readonly outcome: SettlementOutcomeService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** approved -> releasing. Creates the payout and the hold; calls nobody. */
  async release(ref: string, actorId: string): Promise<{ batch: BatchRow; replayed: boolean }> {
    return this.unitOfWork.run(async (tx) => {
      const batch = await this.batches.lockByRef(tx, ref);
      if (!batch) throw new AppError('NOT_FOUND');
      if (batch.status === 'releasing') {
        // Nothing changed: the audit interceptor must not record a second release.
        markAuditNotApplicable();
        return { batch, replayed: true };
      }
      assertTransition(batch.status as BatchStatus, 'releasing');

      const merchant = await this.merchants.findById(batch.merchantId, tx);
      if (!merchant || (merchant.status !== 'active' && merchant.status !== 'suspended')) {
        throw new AppError('SETTLEMENT_RELEASE_BLOCKED', {
          messageParams: { reason: 'merchant_status' },
          details: { reason: 'merchant_status' },
        });
      }
      const destination = await this.destinations.findActive(tx, batch.merchantId, batch.currency);
      if (
        !destination ||
        destination.id !== batch.destinationId ||
        destination.fingerprint !== batch.destinationFingerprint
      ) {
        throw new AppError('SETTLEMENT_DESTINATION_CHANGED');
      }
      const provider = this.destinations.assertUsable(destination, batch.currency);

      const now = this.clock.now();
      const payoutRef = publicId('payout', now);
      const payoutId = uuidv7(now);
      const payout = await this.transactions.insert(tx, {
        id: payoutId,
        ref: publicId('transaction', now),
        merchantId: batch.merchantId,
        environment: 'live',
        type: 'settlement',
        status: 'created',
        amountMinor: batch.netMinor,
        feeMinor: 0n,
        netMinor: batch.netMinor,
        currency: batch.currency,
        provider,
        channel: 'mobile_money',
        gatewayExternalId: payoutRef,
        metadata: { settlement: batch.ref },
        createdAt: now,
      });

      // What leaves the payable account: the draw and the reserve moved out of it.
      const leaving = batch.payableDrawMinor + batch.reserveMinor;
      const hold =
        leaving > 0n
          ? await this.holds.place(tx, {
              merchantId: batch.merchantId,
              environment: 'live',
              currency: batch.currency,
              amountMinor: leaving,
              reason: `settlement:${batch.ref}`,
              transactionId: payoutId,
              idempotencyKey: `settlement:${batch.id}:hold`,
              createdBy: `user:${actorId}`,
            })
          : undefined;

      const updated = await this.batches.update(tx, batch.id, {
        status: 'releasing',
        payoutRef,
        payoutTransactionId: payout.id,
        holdId: hold?.hold.id ?? null,
        releasedAt: now,
      });
      await this.batches.addEvent(tx, {
        id: uuidv7(now),
        batchId: batch.id,
        fromStatus: batch.status,
        toStatus: 'releasing',
        kind: 'transition',
        actor: `user:${actorId}`,
        note: `payout ${payoutRef}`,
        createdAt: now,
      });
      await this.outbox.enqueue(tx, {
        eventType: SETTLEMENT_SUBMIT_OUTBOX_TYPE,
        aggregateType: 'settlement_batch',
        aggregateId: batch.id,
        payload: { batchId: batch.id },
        dedupeKey: `settlement-submit:${batch.id}`,
      });
      await this.audit.record(tx, {
        action: 'settlement.batch.releasing',
        resourceType: 'settlement_batch',
        resourceId: batch.ref,
        merchantId: batch.merchantId,
        before: { status: batch.status },
        after: { status: 'releasing', netMinor: batch.netMinor, payout: payout.ref, held: leaving },
      });
      settlementTransitionsTotal.inc({ to: 'releasing' });
      return { batch: updated, replayed: false };
    });
  }

  /** Sends the disbursement for a releasing batch. Idempotent: the key never changes. */
  async submitPayout(batchId: string): Promise<SubmitResult> {
    const batch = await this.batches.findById(batchId);
    if (!batch || batch.status !== 'releasing' || !batch.payoutRef || !batch.payoutTransactionId) {
      return 'not_releasing';
    }
    const payout = await this.eligibility.payoutTransaction(
      this.db,
      batch.payoutTransactionId,
      false
    );
    if (!payout || payout.status !== 'created') return 'already_submitted';
    const destination = batch.destinationId
      ? await this.unitOfWork.run((tx) =>
          this.destinations.findById(tx, batch.destinationId as string)
        )
      : undefined;
    if (!destination || !payout.provider) throw new Error('settlement payout has no destination');

    const result = await this.gateway.submitDisbursement({
      environment: 'live',
      providerId: this.destinations.assertUsable(destination, batch.currency),
      externalId: batch.payoutRef,
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      payee: this.destinations.payee(destination),
      metadata: { merchantId: batch.merchantId, environment: 'live', coreTransactionId: payout.id },
    });

    switch (result.kind) {
      case 'accepted': {
        const key = `submit:${result.referenceId}:${result.status}`;
        await this.applySignal(batch.payoutRef, `${key}:accepted`, {
          kind: 'processing',
          outcomeUnknown: false,
          referenceId: result.referenceId,
        });
        // A terminal status in the answer is still the gateway's word, applied the normal way.
        if (isTerminalGatewayStatus(result.status)) {
          await this.applySignal(
            batch.payoutRef,
            key,
            this.signalFor(result.status, payout, result.referenceId)
          );
        }
        return 'submitted';
      }
      case 'rejected':
        if (result.reason === 'validation' || result.reason === 'conflict') {
          this.logger.error(
            { batch: batch.ref, reason: result.reason, httpStatus: result.httpStatus },
            'gateway refused a settlement payout: core bug, alert'
          );
          await this.applySignal(batch.payoutRef, `submit:rejected:${result.reason}`, {
            kind: 'failed',
            failureCode: `gateway_${result.reason}`,
          });
          return 'failed';
        }
        this.logger.error(
          { batch: batch.ref, reason: result.reason, httpStatus: result.httpStatus },
          'settlement payout not accepted by the gateway; will retry with the same key'
        );
        throw new SettlementSubmitRetry(result.reason);
      case 'rate_limited':
        throw new SettlementSubmitRetry('rate_limited');
      case 'ambiguous':
        await this.applySignal(
          batch.payoutRef,
          `submit:ambiguous:${result.referenceId ?? 'none'}`,
          {
            kind: 'processing',
            outcomeUnknown: true,
            ...(result.referenceId ? { referenceId: result.referenceId } : {}),
          }
        );
        return 'unknown_outcome';
    }
  }

  /**
   * Asks the gateway what became of a `processing` payout and applies a terminal answer
   * through the same outcome service as an event. A pending or unreachable gateway changes
   * nothing: the gap reconciliation run raises the exception for a person.
   */
  async verifyPayout(
    batchId: string
  ): Promise<'applied' | 'still_pending' | 'unavailable' | 'skipped'> {
    const batch = await this.batches.findById(batchId);
    if (!batch || batch.status !== 'releasing' || !batch.payoutRef || !batch.payoutTransactionId) {
      return 'skipped';
    }
    const payout = await this.eligibility.payoutTransaction(
      this.db,
      batch.payoutTransactionId,
      false
    );
    if (!payout || payout.status !== 'processing') return 'skipped';
    const lookup = await this.gateway.findByExternalId(batch.payoutRef, {
      operationType: 'disbursement',
    });
    if (lookup.kind !== 'found') return 'unavailable';
    const op = lookup.operation;
    if (!isTerminalGatewayStatus(op.status)) return 'still_pending';
    await this.applySignal(
      batch.payoutRef,
      `verify:${op.referenceId ?? 'none'}:${op.status}`,
      this.signalFor(op.status, payout, op.referenceId ?? undefined, op.amount, op.currency)
    );
    return 'applied';
  }

  /** The periodic sweep: re-drives unsent payouts and verifies stale `processing` ones. */
  async sweep(limit = 50): Promise<{ submitted: number; verified: number }> {
    const before = new Date(
      this.clock.now().getTime() - this.config.SETTLEMENT_RELEASE_RETRY_SECONDS * 1000
    );
    const stale = await this.batches.releasingBefore(before, limit);
    let submitted = 0;
    let verified = 0;
    for (const batch of stale) {
      const payout = batch.payoutTransactionId
        ? await this.eligibility.payoutTransaction(this.db, batch.payoutTransactionId, false)
        : undefined;
      try {
        if (payout?.status === 'created') {
          if ((await this.submitPayout(batch.id)) !== 'not_releasing') submitted += 1;
        } else if (payout?.status === 'processing') {
          if ((await this.verifyPayout(batch.id)) === 'applied') verified += 1;
        }
      } catch (error) {
        this.logger.warn(
          { batch: batch.ref, err: error instanceof Error ? error.name : 'Error' },
          'settlement sweep step failed'
        );
      }
    }
    return { submitted, verified };
  }

  private signalFor(
    status: GatewayStatus,
    payout: { amountMinor: bigint; currency: string },
    referenceId: string | undefined,
    amount?: string,
    currency?: string
  ): PayoutSignal {
    if (status === 'successful') {
      return {
        kind: 'succeeded',
        amountMinor: amount ? toMinor(amount, currency ?? payout.currency) : payout.amountMinor,
        currency: currency ?? payout.currency,
        ...(referenceId ? { referenceId } : {}),
      };
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      return { kind: status, ...(referenceId ? { referenceId } : {}) };
    }
    return {
      kind: 'processing',
      outcomeUnknown: status === 'unknown',
      ...(referenceId ? { referenceId } : {}),
    };
  }

  private applySignal(payoutRef: string, eventKey: string, signal: PayoutSignal) {
    return this.unitOfWork.run((tx) => this.outcome.apply(tx, { payoutRef, eventKey, signal }));
  }
}
