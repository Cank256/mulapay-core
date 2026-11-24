/**
 * Refund event handlers (6 combinations): apply refund lifecycle transitions.
 * Mirrors collection handlers pattern for refund operations.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../../common/tokens';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import { toMinor } from '../../../integrations/gateway/money';
import type { EventHandler } from '../handler.port';
import { TransactionsRepository } from '../../../modules/transactions/transactions.repository';
import { RefundsRepository } from '../../../modules/refunds/refunds.repository';
import { RefundLifecycleService } from '../../../modules/refunds/refund-lifecycle.service';
import { isPaymentProvider } from '../../../modules/payments/domain/payment-event';

@Injectable()
export class RefundPendingHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    await this.lifecycle.apply(tx, refund.id, {
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

@Injectable()
export class RefundUnknownHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    await this.lifecycle.apply(tx, refund.id, {
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

@Injectable()
export class RefundSuccessfulHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    const amountMinor = toMinor(event.amount, event.currency);

    await this.lifecycle.apply(tx, refund.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'succeeded',
        amountMinor,
        currency: event.currency,
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

@Injectable()
export class RefundFailedHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    await this.lifecycle.apply(tx, refund.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'failed',
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

@Injectable()
export class RefundExpiredHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    await this.lifecycle.apply(tx, refund.id, {
      eventKey: event.eventId,
      source: 'gateway_event',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'failed',
        failureCode: event.status,
        failureReason: event.reason ?? 'expired',
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

@Injectable()
export class RefundCancelledHandler implements EventHandler {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly lifecycle: RefundLifecycleService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const transaction = await this.transactions.findByGatewayExternalId(
      event.externalId,
      'refund',
      tx
    );

    if (!transaction) {
      this.logger.warn({ externalId: event.externalId }, 'refund transaction not found');
      return true;
    }

    const refund = await this.refunds.findByTransactionId(transaction.id, tx);
    if (!refund) {
      this.logger.error({ transactionId: transaction.id }, 'refund row missing for transaction');
      return true;
    }

    await this.lifecycle.apply(tx, refund.id, {
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
