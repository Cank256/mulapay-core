/**
 * The payment lifecycle: applies one event to one payment (spec 6.1, 3.7, 8.7).
 *
 * This is the only code that changes the status of a payment. The event consumer (Phase 3),
 * the chase job and expiry sweep (Phase 4) and the cancel route all go through `apply`, so
 * the rules below hold for every source.
 *
 * Invariants upheld, in one transaction supplied by the caller:
 *
 *  - Serialised per payment. Locks are taken in the order checkout session, payment,
 *    transaction, and the ledger accounts after them, everywhere.
 *  - Idempotent per event key. An event key seen before returns `duplicate` and changes
 *    nothing, so a redelivered gateway event cannot repeat a transition or a posting.
 *  - Terminal states are final. A payment that is `succeeded`, `failed`, `cancelled` or
 *    `expired` is never moved. A request for a different status is refused and recorded as
 *    a `rejected` event for reconciliation (spec 3.7); the same status again is a no-op.
 *  - Illegal moves are refused the same way (`invalid_transition`).
 *  - A success is verified. If the event carries an amount or currency that differs from
 *    the payment, or a provider or gateway identifier that differs from the one already
 *    recorded, it is refused: the provider's status alone does not establish what was
 *    collected.
 *  - "Unknown" never resolves a payment. `processing` with `outcomeUnknown` leaves the
 *    status and posts nothing; only a later definite event moves it.
 *  - A success posts the collection to the ledger (spec 5.5) in the same transaction, so a
 *    payment cannot be `succeeded` without its entry or the reverse. Failure, expiry and
 *    cancellation post nothing.
 *  - The payment and its transaction change together; the database asserts at commit that
 *    they agree.
 *
 * A refused event is a result, not an exception: the consumer must still commit its cursor.
 * Callers that want an error (the cancel route) translate `rejected` themselves.
 *
 * Not done here: emitting `merchant_events` and webhooks (outbox, Phase 4/5) and releasing
 * holds (payments take none; payouts do).
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
import {
  TransactionsRepository,
  type TransactionRow,
} from '../transactions/transactions.repository';
import { CheckoutSessionsRepository } from './checkout-sessions.repository';
import { collectionPostingLines } from './domain/collection-posting';
import { addsInformation, changeFor, verifyEvent } from './domain/payment-event-effects';
import {
  isPaymentProvider,
  signalTarget,
  validatePaymentEvent,
  type PaymentEventInput,
} from './domain/payment-event';
import {
  decideTransition,
  isPaymentStatus,
  isTerminalPaymentStatus,
  type PaymentRejectionReason,
  type PaymentStatus,
} from './domain/payment-state-machine';
import { toPaymentView } from './payment.views';
import { PaymentsRepository, type PaymentRow } from './payments.repository';

interface ResultBase {
  readonly paymentId: string;
  readonly paymentRef: string;
  /** Internal transaction id; refs are for responses, ids for the callers' own queries. */
  readonly transactionId: string;
  readonly transactionRef: string;
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
}

export type PaymentEventResult =
  /** The status changed. `ledgerEntryRef` is set for a success. */
  | (ResultBase & {
      readonly result: 'applied';
      readonly from: PaymentStatus;
      readonly to: PaymentStatus;
      readonly ledgerEntryRef: string | null;
    })
  /** Same status, but the outcome flag or a gateway identifier changed. */
  | (ResultBase & { readonly result: 'updated'; readonly status: PaymentStatus })
  /** Same status, nothing new to record. */
  | (ResultBase & { readonly result: 'noop'; readonly status: PaymentStatus })
  /** The event key was applied before; nothing changed. */
  | (ResultBase & { readonly result: 'duplicate'; readonly status: PaymentStatus })
  /** Refused and recorded for reconciliation. Nothing else changed. */
  | (ResultBase & {
      readonly result: 'rejected';
      readonly status: PaymentStatus;
      readonly requested: PaymentStatus;
      readonly reason: PaymentRejectionReason;
    })
  /** The `precondition` did not hold, so the event was not applied or recorded. */
  | (ResultBase & { readonly result: 'skipped'; readonly status: PaymentStatus });

export interface ApplyOptions {
  /** Apply only if the payment is in this status once locked (the expiry sweep uses it). */
  readonly requireStatus?: PaymentStatus;
}

interface Locked {
  readonly payment: PaymentRow;
  readonly transaction: TransactionRow;
  readonly sessionOpen: boolean;
}

function invariantViolation(message: string): AppError {
  return new AppError('INTERNAL_ERROR', { cause: new Error(message) });
}

@Injectable()
export class PaymentLifecycleService {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly sessions: CheckoutSessionsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly posting: PostingService,
    private readonly events: MerchantEventsService,
    private readonly balances: BalancesService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Applies `event` to the payment. See the class comment for the rules. */
  async apply(
    tx: Transaction,
    paymentId: string,
    event: PaymentEventInput,
    options: ApplyOptions = {}
  ): Promise<PaymentEventResult> {
    validatePaymentEvent(event);
    const { payment, transaction, sessionOpen } = await this.lock(tx, paymentId);
    const base: ResultBase = {
      paymentId: payment.id,
      paymentRef: payment.ref,
      transactionId: transaction.id,
      transactionRef: transaction.ref,
      merchantId: payment.merchantId,
      environment: payment.environment as ResultBase['environment'],
    };
    const from = payment.status as PaymentStatus;

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
    // A terminal payment is never written again, not even to restate its own status.
    const writes =
      decision.kind === 'apply' ||
      (!isTerminalPaymentStatus(from) && addsInformation(transaction, change));
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
      await this.payments.update(tx, payment.id, { status: to });
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
    if (to === 'succeeded') ledgerEntryRef = await this.postCollection(tx, payment, updated, event);
    if (isTerminalPaymentStatus(to) && payment.checkoutSessionId && sessionOpen) {
      await this.sessions.setStatus(
        tx,
        payment.checkoutSessionId,
        to === 'succeeded' ? 'complete' : 'expired',
        this.clock.now()
      );
    }
    await this.announce(tx, payment, to, ledgerEntryRef !== null);
    return { ...base, result: 'applied', from, to, ledgerEntryRef };
  }

  /**
   * Tells the merchant about the new status in the same transaction (spec 6.11, 8.8):
   * `payment.{status}` for the statuses merchants subscribe to, and `balance.updated` after a
   * success has moved the balance. `processing` has no event type.
   */
  private async announce(
    tx: Transaction,
    payment: PaymentRow,
    to: PaymentStatus,
    balanceMoved: boolean
  ): Promise<void> {
    if (to === 'processing' || to === 'created') return;
    const detail = await this.payments.findDetailById(payment.id, tx);
    if (!detail) throw invariantViolation(`payment ${payment.ref} vanished before its event`);
    const environment = payment.environment as 'test' | 'live';
    await this.events.emit(tx, {
      merchantId: payment.merchantId,
      environment,
      type: `payment.${to}`,
      resourceType: 'payment',
      resourceId: payment.ref,
      object: toPaymentView(detail),
    });
    if (balanceMoved) {
      const balance = await this.balances.merchantBalance(
        payment.merchantId,
        environment,
        payment.currency,
        tx
      );
      await this.events.emit(tx, {
        merchantId: payment.merchantId,
        environment,
        type: 'balance.updated',
        resourceType: 'balance',
        resourceId: payment.currency,
        object: toMerchantBalanceView(environment, balance),
      });
    }
  }

  /**
   * Locks session, payment, transaction in that order and checks that the payment and its
   * transaction agree (the database checks this again at commit).
   */
  private async lock(tx: Transaction, paymentId: string): Promise<Locked> {
    const peek = await this.payments.findById(tx, paymentId);
    if (!peek) throw new AppError('NOT_FOUND');
    const session = peek.checkoutSessionId
      ? await this.sessions.lockById(tx, peek.checkoutSessionId)
      : undefined;
    const payment = await this.payments.lockById(tx, paymentId);
    if (!payment) throw new AppError('NOT_FOUND');
    const transaction = await this.transactions.lock(tx, payment.transactionId, payment.createdAt);
    if (!transaction) throw invariantViolation(`payment ${payment.ref} has no transaction row`);
    if (transaction.status !== payment.status) {
      throw invariantViolation(`payment ${payment.ref} and its transaction disagree on status`);
    }
    if (!isPaymentStatus(payment.status)) {
      throw invariantViolation(`payment ${payment.ref} has unknown status ${payment.status}`);
    }
    return { payment, transaction, sessionOpen: session?.status === 'open' };
  }

  private async postCollection(
    tx: Transaction,
    payment: PaymentRow,
    transaction: TransactionRow,
    event: PaymentEventInput
  ): Promise<string> {
    const signal = event.signal;
    if (signal.kind !== 'succeeded') throw invariantViolation('postCollection without success');
    const merchant = await this.merchants.findById(payment.merchantId, tx);
    if (!merchant) throw invariantViolation(`merchant of payment ${payment.ref} not found`);
    const provider = transaction.provider;
    if (provider === null || !isPaymentProvider(provider)) {
      throw invariantViolation(`payment ${payment.ref} succeeded without a provider`);
    }
    const sourceId = `${payment.ref}:${event.eventKey}`;
    const posted = await this.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('payment', sourceId),
      environment: payment.environment as 'test' | 'live',
      currency: payment.currency,
      source: 'payment',
      sourceId,
      kind: 'collection.succeeded',
      merchantId: payment.merchantId,
      transactionId: transaction.id,
      description: `Collection ${payment.ref} succeeded`,
      lines: collectionPostingLines({
        provider,
        merchantRef: merchant.ref,
        grossMinor: transaction.amountMinor,
        feeMinor: signal.feeMinor ?? 0n,
        providerFeeMinor: signal.providerFeeMinor ?? 0n,
      }),
      createdBy: { type: 'system', id: 'payments' },
    });
    return posted.entry.ref;
  }

  private async reject(
    tx: Transaction,
    base: ResultBase,
    transaction: TransactionRow,
    event: PaymentEventInput,
    from: PaymentStatus,
    requested: PaymentStatus,
    reason: PaymentRejectionReason
  ): Promise<PaymentEventResult> {
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
    // Refs only: no amounts, numbers or provider text in the log (spec 11).
    this.logger.warn(
      {
        paymentRef: base.paymentRef,
        eventKey: event.eventKey,
        source: event.source,
        from,
        requested,
        reason,
      },
      'payment event refused'
    );
    return { ...base, result: 'rejected', status: from, requested, reason };
  }

  private async record(
    tx: Transaction,
    base: ResultBase,
    event: PaymentEventInput,
    outcome: 'applied' | 'noop' | 'rejected',
    from: PaymentStatus,
    to: PaymentStatus,
    rejectionReason: PaymentRejectionReason | null,
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
