/**
 * The refund lifecycle: applies one event to one refund (mirrors PaymentLifecycleService).
 *
 * This is the only code that changes the status of a refund. The event consumer (Phase 3),
 * and any future chase/reconciliation jobs all go through `apply`, so the rules below hold
 * for every source.
 *
 * Invariants upheld, in one transaction supplied by the caller:
 *
 *  - Serialised per refund. Locks are taken in the order refund, transaction, payment, and
 *    ledger accounts after them, everywhere.
 *  - Idempotent per event key. An event key seen before returns `duplicate` and changes
 *    nothing, so a redelivered gateway event cannot repeat a transition or a posting.
 *  - Terminal states are final. A refund that is `succeeded`, `failed`, or `cancelled` is
 *    never moved. A request for a different status is refused and recorded as a `rejected`
 *    event for reconciliation; the same status again is a no-op.
 *  - Illegal moves are refused the same way (`invalid_transition`).
 *  - A success is verified. If the event carries an amount or currency that differs from
 *    the refund, or a provider or gateway identifier that differs from the one already
 *    recorded, it is refused: the provider's status alone does not establish what was
 *    refunded.
 *  - "Unknown" never resolves a refund. `processing` with `outcomeUnknown` leaves the
 *    status and posts nothing; only a later definite event moves it.
 *  - A success posts the reversal to the ledger (reversing the collection entry) in the
 *    same transaction, so a refund cannot be `succeeded` without its entry or the reverse.
 *    Failure and cancellation post nothing.
 *  - The refund and its transaction change together; the database asserts at commit that
 *    they agree.
 *
 * A refused event is a result, not an exception: the consumer must still commit its cursor.
 *
 * A live refund that reaches a terminal status also queues AML monitoring through the outbox
 * (if applicable), and emits merchant events for webhooks.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { BalancesService } from '../balances/balances.service';
import { toMerchantBalanceView } from '../balances/balance.views';
import { MerchantEventsService } from '../events/merchant-events.service';
import { PostingService } from '../ledger/posting.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { PaymentsRepository } from '../payments/payments.repository';
import { isPaymentProvider } from '../payments/domain/payment-event';
import {
  TransactionsRepository,
  type TransactionRow,
} from '../transactions/transactions.repository';
import { refundPostingLines } from './domain/refund-posting';
import {
  addsInformation,
  changeFor,
  verifyEvent,
} from './domain/refund-event-effects';
import {
  decideTransition,
  isRefundStatus,
  isTerminalRefundStatus,
  signalTarget,
  validateRefundEvent,
  type RefundEventInput,
  type RefundRejectionReason,
  type RefundStatus,
} from './domain/refund-state-machine';
import { toRefundView } from './refund.views';
import { RefundsRepository, type RefundRow } from './refunds.repository';

interface ResultBase {
  readonly refundId: string;
  readonly refundRef: string;
  /** Internal transaction id; refs are for responses, ids for the callers' own queries. */
  readonly transactionId: string;
  readonly transactionRef: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

export type RefundEventResult =
  /** The status changed. `ledgerEntryRef` is set for a success. */
  | (ResultBase & {
      readonly result: 'applied';
      readonly from: RefundStatus;
      readonly to: RefundStatus;
      readonly ledgerEntryRef: string | null;
    })
  /** Same status, but the outcome flag or a gateway identifier changed. */
  | (ResultBase & { readonly result: 'updated'; readonly status: RefundStatus })
  /** Same status, nothing new to record. */
  | (ResultBase & { readonly result: 'noop'; readonly status: RefundStatus })
  /** The event key was applied before; nothing changed. */
  | (ResultBase & { readonly result: 'duplicate'; readonly status: RefundStatus })
  /** Refused and recorded for reconciliation. Nothing else changed. */
  | (ResultBase & {
      readonly result: 'rejected';
      readonly status: RefundStatus;
      readonly requested: RefundStatus;
      readonly reason: RefundRejectionReason;
    })
  /** The `precondition` did not hold, so the event was not applied or recorded. */
  | (ResultBase & { readonly result: 'skipped'; readonly status: RefundStatus });

export interface ApplyOptions {
  /** Apply only if the refund is in this status once locked. */
  readonly requireStatus?: RefundStatus;
}

interface Locked {
  readonly refund: RefundRow;
  readonly transaction: TransactionRow;
}

function invariantViolation(message: string): AppError {
  return new AppError('INTERNAL_ERROR', { cause: new Error(message) });
}

@Injectable()
export class RefundLifecycleService {
  constructor(
    private readonly refunds: RefundsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly posting: PostingService,
    private readonly events: MerchantEventsService,
    private readonly balances: BalancesService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Applies `event` to the refund. See the class comment for the rules. */
  async apply(
    tx: Transaction,
    refundId: string,
    event: RefundEventInput,
    options: ApplyOptions = {}
  ): Promise<RefundEventResult> {
    validateRefundEvent(event);
    const { refund, transaction } = await this.lock(tx, refundId);
    const base: ResultBase = {
      refundId: refund.id,
      refundRef: refund.ref,
      transactionId: transaction.id,
      transactionRef: transaction.ref,
      merchantId: refund.merchantId,
      environment: refund.environment as ResultBase['environment'],
    };
    const from = refund.status as RefundStatus;

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
    // A terminal refund is never written again, not even to restate its own status.
    const writes =
      decision.kind === 'apply' ||
      (!isTerminalRefundStatus(from) && addsInformation(transaction, change));
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
      await this.refunds.update(tx, refund.id, { status: to });
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
    if (to === 'succeeded') ledgerEntryRef = await this.postRefund(tx, refund, updated, event);

    await this.announce(tx, refund, to, ledgerEntryRef !== null);
    return { ...base, result: 'applied', from, to, ledgerEntryRef };
  }

  /**
   * Tells the merchant about the new status in the same transaction:
   * `refund.{status}` for the statuses merchants subscribe to, and `balance.updated` after a
   * success has moved the balance. `processing` has no event type.
   */
  private async announce(
    tx: Transaction,
    refund: RefundRow,
    to: RefundStatus,
    balanceMoved: boolean
  ): Promise<void> {
    if (to === 'processing' || to === 'created') return;
    const detail = await this.refunds.findDetailById(refund.id, tx);
    if (!detail) throw invariantViolation(`refund ${refund.ref} vanished before its event`);
    const environment = refund.environment as 'test' | 'live';
    await this.events.emit(tx, {
      merchantId: refund.merchantId,
      environment,
      type: `refund.${to}`,
      resourceType: 'refund',
      resourceId: refund.ref,
      object: toRefundView(detail),
    });
    if (balanceMoved) {
      const balance = await this.balances.merchantBalance(
        refund.merchantId,
        environment,
        refund.currency,
        tx
      );
      await this.events.emit(tx, {
        merchantId: refund.merchantId,
        environment,
        type: 'balance.updated',
        resourceType: 'balance',
        resourceId: refund.currency,
        object: toMerchantBalanceView(environment, balance),
      });
    }
  }

  /**
   * Locks refund, transaction in that order and checks that the refund and its
   * transaction agree (the database checks this again at commit).
   */
  private async lock(tx: Transaction, refundId: string): Promise<Locked> {
    const refund = await this.refunds.lockById(tx, refundId);
    if (!refund) throw new AppError('NOT_FOUND');
    const transaction = await this.transactions.lock(tx, refund.transactionId, refund.createdAt);
    if (!transaction) throw invariantViolation(`refund ${refund.ref} has no transaction row`);
    if (transaction.status !== refund.status) {
      throw invariantViolation(`refund ${refund.ref} and its transaction disagree on status`);
    }
    if (!isRefundStatus(refund.status)) {
      throw invariantViolation(`refund ${refund.ref} has unknown status ${refund.status}`);
    }
    return { refund, transaction };
  }

  private async postRefund(
    tx: Transaction,
    refund: RefundRow,
    transaction: TransactionRow,
    event: RefundEventInput
  ): Promise<string> {
    const signal = event.signal;
    if (signal.kind !== 'succeeded') throw invariantViolation('postRefund without success');
    const merchant = await this.merchants.findById(refund.merchantId, tx);
    if (!merchant) throw invariantViolation(`merchant of refund ${refund.ref} not found`);
    const provider = transaction.provider;
    if (provider === null || !isPaymentProvider(provider)) {
      throw invariantViolation(`refund ${refund.ref} succeeded without a provider`);
    }
    const sourceId = `${refund.ref}:${event.eventKey}`;
    const posted = await this.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('refund', sourceId),
      environment: refund.environment as 'test' | 'live',
      currency: refund.currency,
      source: 'refund',
      sourceId,
      kind: 'refund.succeeded',
      merchantId: refund.merchantId,
      transactionId: transaction.id,
      description: `Refund ${refund.ref} succeeded`,
      lines: refundPostingLines({
        provider,
        merchantRef: merchant.ref,
        grossMinor: transaction.amountMinor,
        feeMinor: signal.feeMinor ?? 0n,
        providerFeeMinor: signal.providerFeeMinor ?? 0n,
      }),
      createdBy: { type: 'system', id: 'refunds' },
    });
    return posted.entry.ref;
  }

  private async reject(
    tx: Transaction,
    base: ResultBase,
    transaction: TransactionRow,
    event: RefundEventInput,
    from: RefundStatus,
    requested: RefundStatus,
    reason: RefundRejectionReason
  ): Promise<RefundEventResult> {
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
    // Refs only: no amounts, numbers or provider text in the log.
    this.logger.warn(
      {
        refundRef: base.refundRef,
        eventKey: event.eventKey,
        source: event.source,
        from,
        requested,
        reason,
      },
      'refund event refused'
    );
    return { ...base, result: 'rejected', status: from, requested, reason };
  }

  private async record(
    tx: Transaction,
    base: ResultBase,
    event: RefundEventInput,
    outcome: 'applied' | 'noop' | 'rejected',
    from: RefundStatus,
    to: RefundStatus,
    rejectionReason: RefundRejectionReason | null,
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
