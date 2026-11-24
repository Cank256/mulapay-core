/**
 * Collection event handlers (6 combinations): apply payment lifecycle transitions. Built on
 * `PaymentLifecycleService.apply` (Phase 2). Each handler is idempotent.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../../common/tokens';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import { toMinor } from '../../../integrations/gateway/money';
import type { EventHandler } from '../handler.port';
import { TransactionsRepository } from '../../../modules/transactions/transactions.repository';
import { PaymentsRepository } from '../../../modules/payments/payments.repository';
import { PaymentLifecycleService } from '../../../modules/payments/payment-lifecycle.service';
import { isPaymentProvider } from '../../../modules/payments/domain/payment-event';

/**
 * Collection pending: payment is processing at the provider. Core does nothing (payment is
 * already in `processing` state after the initial 201).
 */
@Injectable()
export class CollectionPendingHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    // Find transaction by gateway external ID
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection event'
      );
      return true; // Event for unknown transaction, ignore
    }

    // Find payment by transaction ID
    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    // Apply processing event (idempotent, will be no-op if already processing)
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: { kind: 'processing', outcomeUnknown: false },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}

/**
 * Collection unknown: the gateway does not know the outcome (504, ambiguous provider response).
 * Core marks the payment `outcome_unknown` and waits for reconciliation.
 */
@Injectable()
export class CollectionUnknownHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection unknown'
      );
      return true;
    }

    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    // Mark as processing with outcome_unknown flag
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: { kind: 'processing', outcomeUnknown: true },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}

/**
 * Collection successful: payment completed. Post the collection entry to the ledger (debits
 * provider_receivable, credits merchant_payable, debits fee if any).
 */
@Injectable()
export class CollectionSuccessfulHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection success'
      );
      return true;
    }

    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    const amountMinor = toMinor(event.amount, event.currency);

    // Apply succeeded transition (idempotent, posts ledger entry)
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'succeeded',
        amountMinor,
        currency: event.currency,
        // feeMinor and providerFeeMinor will come from gateway later (P4-D6)
      },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}

/**
 * Collection failed: payment failed at the provider (insufficient funds, invalid number, etc.).
 * Mark the payment `failed`, no ledger movement.
 */
@Injectable()
export class CollectionFailedHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection failed'
      );
      return true;
    }

    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    // Apply failed transition
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'failed',
        failureCode: event.status, // Use status as failure code
        failureReason: event.reason ?? undefined,
      },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}

/**
 * Collection expired: payment timed out at the provider. Mark the payment `expired`, no ledger
 * movement.
 */
@Injectable()
export class CollectionExpiredHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection expired'
      );
      return true;
    }

    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    // Apply expired transition
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'expired',
        failureCode: event.status,
        failureReason: event.reason ?? undefined,
      },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}

/**
 * Collection cancelled: payment was cancelled (user or provider). Mark the payment `cancelled`,
 * no ledger movement.
 */
@Injectable()
export class CollectionCancelledHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'payment',
      tx
    );

    if (!transaction) {
      this.logger.warn(
        { externalId: event.externalId },
        'transaction not found for collection cancelled'
      );
      return true;
    }

    const payment = await this.payments.findByTransactionId(transaction.id, tx);
    if (!payment) {
      this.logger.error({ transactionId: transaction.id }, 'payment row missing for transaction');
      return true;
    }

    // Apply cancelled transition
    await this.lifecycle.apply(tx, payment.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'cancelled',
        failureCode: event.status,
        failureReason: event.reason ?? undefined,
      },
      identifiers: {
        provider: isPaymentProvider(event.providerId) ? event.providerId : undefined,
        operationId: event.operationId ?? undefined,
        referenceId: event.referenceId ?? undefined,
        providerTransactionId: event.providerTransactionId ?? undefined,
      },
    });

    return true;
  }
}
