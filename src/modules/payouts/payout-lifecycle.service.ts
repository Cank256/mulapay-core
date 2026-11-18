/**
 * The payout lifecycle: applies one event to one payout (mirrors PaymentLifecycleService).
 *
 * This is the only code that changes the status of a payout. The event consumer, the chase
 * job and the cancel route all go through `apply`.
 *
 * Invariants upheld, in one transaction supplied by the caller:
 *  - Serialised per payout. Locks are taken on payout, transaction.
 *  - Idempotent per event key. An event key seen before returns `duplicate` and changes nothing.
 *  - Terminal states are final. A payout that is `succeeded`, `failed`, `cancelled` or
 *    `expired` is never moved. A request for a different status is refused and recorded as
 *    a `rejected` event for reconciliation; the same status again is a no-op.
 *  - Illegal moves are refused the same way (`invalid_transition`).
 *  - A success is verified. If the event carries an amount or currency that differs from
 *    the payout, or a provider or gateway identifier that differs from the one already
 *    recorded, it is refused.
 *  - "Unknown" never resolves a payout. `processing` with `outcomeUnknown` leaves the
 *    status and posts nothing; only a later definite event moves it.
 *  - A success:
 *      1. Captures the hold (funds stop being held)
 *      2. Posts the disbursement to the ledger (funds leave merchant_payable)
 *    Both happen in the same transaction, so a payout cannot be `succeeded` without its
 *    ledger entry or hold capture.
 *  - A failure or cancellation releases the hold (funds return to available balance).
 *  - The payout and its transaction change together; the database asserts at commit that
 *    they agree.
 *
 * A refused event is a result, not an exception: the consumer must still commit its cursor.
 * Callers that want an error (the cancel route) translate `rejected` themselves.
 *
 * Not done here: emitting `merchant_events` and webhooks (outbox).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { HoldsService } from '../holds/holds.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { PostingService } from '../ledger/posting.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import {
  TransactionsRepository,
  type TransactionRow,
} from '../transactions/transactions.repository';
import { toPayoutView } from './payout.views';
import { PayoutsRepository, type PayoutRow } from './payouts.repository';
import { payoutPostingLines } from './domain/payout-posting';
import { addsInformation, changeFor, verifyEvent } from './domain/payout-event-effects';
import {
  isPayoutProvider,
  signalTarget,
  validatePayoutEvent,
  type PayoutEventInput,
} from './domain/payout-event';
import {
  decideTransition,
  isPayoutStatus,
  isTerminalPayoutStatus,
  type PayoutRejectionReason,
  type PayoutStatus,
} from './domain/payout-state-machine';

interface ResultBase {
  readonly payoutId: string;
  readonly payoutRef: string;
  readonly transactionId: string;
  readonly transactionRef: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

export type PayoutEventResult =
  /** The status changed. `ledgerEntryRef` is set for a success. */
  | (ResultBase & {
      readonly result: 'applied';
      readonly from: PayoutStatus;
      readonly to: PayoutStatus;
      readonly ledgerEntryRef: string | null;
    })
  /** Same status, but the outcome flag or a gateway identifier changed. */
  | (ResultBase & { readonly result: 'updated'; readonly status: PayoutStatus })
  /** Same status, nothing new to record. */
  | (ResultBase & { readonly result: 'noop'; readonly status: PayoutStatus })
  /** The event key was applied before; nothing changed. */
  | (ResultBase & { readonly result: 'duplicate'; readonly status: PayoutStatus })
  /** Refused and recorded for reconciliation. Nothing else changed. */
  | (ResultBase & {
      readonly result: 'rejected';
      readonly status: PayoutStatus;
      readonly requested: PayoutStatus;
      readonly reason: PayoutRejectionReason;
    })
  /** The `precondition` did not hold, so the event was not applied or recorded. */
  | (ResultBase & { readonly result: 'skipped'; readonly status: PayoutStatus });

export interface ApplyOptions {
  /** Apply only if the payout is in this status once locked. */
  readonly requireStatus?: PayoutStatus;
}

interface Locked {
  readonly payout: PayoutRow;
  readonly transaction: TransactionRow;
}

function invariantViolation(message: string): AppError {
  return new AppError('INTERNAL_ERROR', { cause: new Error(message) });
}

@Injectable()
export class PayoutLifecycleService {
  constructor(
    private readonly payouts: PayoutsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly posting: PostingService,
    private readonly holds: HoldsService,
    private readonly events: MerchantEventsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Applies `event` to the payout. See the class comment for the rules. */
  async apply(
    tx: Transaction,
    payoutId: string,
    event: PayoutEventInput,
    options: ApplyOptions = {}
  ): Promise<PayoutEventResult> {
    validatePayoutEvent(event);
    const { payout, transaction } = await this.lock(tx, payoutId);
    const base: ResultBase = {
      payoutId: payout.id,
      payoutRef: payout.ref,
      transactionId: transaction.id,
      transactionRef: transaction.ref,
      merchantId: payout.merchantId,
      environment: payout.environment as ResultBase['environment'],
    };
    const from = payout.status as PayoutStatus;

    if (options.requireStatus && from !== options.requireStatus) {
      return { ...base, result: 'skipped', status: from };
    }
    if (await this.transactions.findEvent(tx, transaction.id, event.eventKey)) {
      return { ...base, result: 'duplicate', status: from };
    }

    const to = signalTarget(event.signal);
    const decision = decideTransition(from, to);
    const refusal = decision.kind === 'reject' ? decision.reason : verifyEvent(transaction, event);
    if (refusal) return this.reject(tx, base, transaction, event, from, to, refusal);

    const change = changeFor(transaction, event, to, this.clock.now());
    // A terminal payout is never written again, not even to restate its own status.
    const writes =
      decision.kind === 'apply' ||
      (!isTerminalPayoutStatus(from) && addsInformation(transaction, change));
    if (!writes) {
      await this.record(tx, base, event, 'noop', from, to, null, transaction.outcomeUnknown, null);
      return { ...base, result: 'noop', status: from };
    }

    const updated = await this.transactions.update(
      tx,
      transaction.id,
      transaction.createdAt,
      change
    );
    if (decision.kind === 'apply') {
      await this.payouts.update(tx, payout.id, { status: to });
    }
    await this.record(
      tx,
      base,
      event,
      'applied',
      from,
      to,
      null,
      updated.outcomeUnknown,
      updated.failureCode
    );

    if (decision.kind === 'noop') return { ...base, result: 'updated', status: from };

    let ledgerEntryRef: string | null = null;
    if (to === 'succeeded') {
      // Capture hold + post ledger entry
      await this.captureHold(tx, payout);
      ledgerEntryRef = await this.postDisbursement(tx, payout, updated, event);
    } else if (to === 'failed' || to === 'cancelled') {
      // Release hold
      await this.releaseHold(tx, payout);
    }

    await this.announce(tx, payout, to);
    return { ...base, result: 'applied', from, to, ledgerEntryRef };
  }

  /**
   * Tells the merchant about the new status in the same transaction.
   */
  private async announce(tx: Transaction, payout: PayoutRow, to: PayoutStatus): Promise<void> {
    if (to === 'processing' || to === 'created' || to === 'pending_approval') return;
    const detail = await this.payouts.findDetailById(payout.id, tx);
    if (!detail) throw invariantViolation(`payout ${payout.ref} vanished before its event`);
    const environment = payout.environment as 'test' | 'live';
    await this.events.emit(tx, {
      merchantId: payout.merchantId,
      environment,
      type: `payout.${to}`,
      resourceType: 'payout',
      resourceId: payout.ref,
      object: toPayoutView(detail),
    });
  }

  /**
   * Locks payout, transaction in that order and checks that they agree.
   */
  private async lock(tx: Transaction, payoutId: string): Promise<Locked> {
    const peek = await this.payouts.findById(tx, payoutId);
    if (!peek) throw new AppError('NOT_FOUND');
    const payout = await this.payouts.lockById(tx, payoutId);
    if (!payout) throw new AppError('NOT_FOUND');
    const transaction = await this.transactions.lock(tx, payout.transactionId, payout.createdAt);
    if (!transaction) throw invariantViolation(`payout ${payout.ref} has no transaction row`);
    if (transaction.status !== payout.status) {
      throw invariantViolation(`payout ${payout.ref} and its transaction disagree on status`);
    }
    if (!isPayoutStatus(payout.status)) {
      throw invariantViolation(`payout ${payout.ref} has unknown status ${payout.status}`);
    }
    return { payout, transaction };
  }

  private async postDisbursement(
    tx: Transaction,
    payout: PayoutRow,
    transaction: TransactionRow,
    event: PayoutEventInput
  ): Promise<string> {
    const signal = event.signal;
    if (signal.kind !== 'succeeded') throw invariantViolation('postDisbursement without success');
    const merchant = await this.merchants.findById(payout.merchantId, tx);
    if (!merchant) throw invariantViolation(`merchant of payout ${payout.ref} not found`);
    const provider = transaction.provider;
    if (provider === null || !isPayoutProvider(provider)) {
      throw invariantViolation(`payout ${payout.ref} succeeded without a provider`);
    }
    const sourceId = `${payout.ref}:${event.eventKey}`;
    const posted = await this.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('payout', sourceId),
      environment: payout.environment as 'test' | 'live',
      currency: payout.currency,
      source: 'payout',
      sourceId,
      kind: 'payout.succeeded',
      merchantId: payout.merchantId,
      transactionId: transaction.id,
      description: `Payout ${payout.ref} succeeded`,
      lines: payoutPostingLines({
        provider,
        merchantRef: merchant.ref,
        grossMinor: transaction.amountMinor,
        feeMinor: signal.feeMinor ?? 0n,
        providerFeeMinor: signal.providerFeeMinor ?? 0n,
      }),
      createdBy: { type: 'system', id: 'payouts' },
    });
    return posted.entry.ref;
  }

  private async captureHold(tx: Transaction, payout: PayoutRow): Promise<void> {
    if (!payout.holdRef) return; // No hold to capture
    await this.holds.captureByRef(tx, payout.environment as 'test' | 'live', payout.holdRef, `payout:${payout.id}:succeeded`);
  }

  private async releaseHold(tx: Transaction, payout: PayoutRow): Promise<void> {
    if (!payout.holdRef) return; // No hold to release
    await this.holds.releaseByRef(tx, payout.environment as 'test' | 'live', payout.holdRef, `payout:${payout.id}:failed`);
  }

  private async reject(
    tx: Transaction,
    base: ResultBase,
    transaction: TransactionRow,
    event: PayoutEventInput,
    from: PayoutStatus,
    requested: PayoutStatus,
    reason: PayoutRejectionReason
  ): Promise<PayoutEventResult> {
    await this.record(
      tx,
      base,
      event,
      'rejected',
      from,
      requested,
      reason,
      transaction.outcomeUnknown,
      null
    );
    this.logger.warn(
      {
        payoutRef: base.payoutRef,
        eventKey: event.eventKey,
        source: event.source,
        from,
        requested,
        reason,
      },
      'payout event refused'
    );
    return { ...base, result: 'rejected', status: from, requested, reason };
  }

  private async record(
    tx: Transaction,
    base: ResultBase,
    event: PayoutEventInput,
    outcome: 'applied' | 'noop' | 'rejected',
    from: PayoutStatus,
    to: PayoutStatus,
    rejectionReason: PayoutRejectionReason | null,
    outcomeUnknown: boolean,
    failureCode: string | null
  ): Promise<void> {
    await this.transactions.insertEvent(tx, {
      id: uuidv7(this.clock.now()),
      transactionId: base.transactionId,
      merchantId: base.merchantId,
      environment: base.environment,
      eventKey: event.eventKey,
      source: event.source,
      outcome,
      fromStatus: from,
      toStatus: to,
      rejectionReason,
      outcomeUnknown,
      failureCode,
      occurredAt: event.occurredAt,
    });
  }
}
