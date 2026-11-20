/**
 * Disbursement event handlers (6 event types): apply payout lifecycle transitions.
 *
 * Settlement payouts (external_id starts with `po_`) call `SettlementOutcomeService.apply`.
 * Merchant payouts call `PayoutLifecycleService.apply` through `PayoutsRepository` +
 * `TransactionsRepository` to find the payout by its gateway external id.
 *
 * Every handler returns `true` (cursor advances) even when the payout is not found: an
 * unknown external_id means the event cannot be acted on and re-delivering it won't help.
 * The exception is logged at warn level so reconciliation can catch it.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../../common/tokens';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import type { EventHandler } from '../handler.port';
import { PayoutLifecycleService } from '../../../modules/payouts/payout-lifecycle.service';
import { TransactionsRepository } from '../../../modules/transactions/transactions.repository';
import { PayoutsRepository } from '../../../modules/payouts/payouts.repository';
import { SettlementOutcomeService } from '../../../modules/settlement/settlement-outcome.service';

// Helpers shared across all disbursement handlers -----------------------------------------

/** True when the event concerns a settlement payout (created by SettlementReleaseService). */
function isSettlementPayout(externalId: string): boolean {
  return externalId.startsWith('po_');
}

/** Finds a merchant payout by the gateway's externalId (which equals the payout ref). */
async function findMerchantPayout(
  transactions: TransactionsRepository,
  payouts: PayoutsRepository,
  externalId: string
): Promise<string | undefined> {
  const txn = await transactions.findByGatewayExternalId(externalId, 'payout');
  if (!txn) return undefined;
  const payout = await payouts.findByTransactionId(txn.id);
  return payout?.id;
}

// -----------------------------------------------------------------------------------------

@Injectable()
export class DisbursementPendingHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) {
      // Settlement payouts move through SettlementOutcomeService on terminal events;
      // a bare `pending` from the provider is a no-op here.
      return true;
    }

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn({ externalId: event.externalId }, 'disbursement pending: payout not found');
      return true;
    }

    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:pending:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: { kind: 'processing', outcomeUnknown: false },
      gatewayDetails: { referenceId: event.referenceId ?? undefined },
    });
    return true;
  }
}

@Injectable()
export class DisbursementUnknownHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) return true;

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn({ externalId: event.externalId }, 'disbursement unknown: payout not found');
      return true;
    }

    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:unknown:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: { kind: 'processing', outcomeUnknown: true },
      gatewayDetails: { referenceId: event.referenceId ?? undefined },
    });
    return true;
  }
}

@Injectable()
export class DisbursementSuccessfulHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly settlementOutcome: SettlementOutcomeService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) {
      const amountMinor = event.amount ? BigInt(event.amount) : undefined;
      await this.settlementOutcome.apply(tx, {
        payoutRef: event.externalId,
        eventKey: `gateway:successful:${event.id}`,
        signal: {
          kind: 'succeeded',
          amountMinor: amountMinor ?? 0n,
          currency: event.currency,
          referenceId: event.referenceId ?? undefined,
        },
      });
      return true;
    }

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn(
        { externalId: event.externalId },
        'disbursement successful: payout not found'
      );
      return true;
    }

    // The hold is captured and the disbursement posted inside PayoutLifecycleService.
    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:successful:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: {
        kind: 'succeeded',
        amountMinor: event.amount ? BigInt(event.amount) : undefined,
        currency: event.currency ?? undefined,
      },
      gatewayDetails: {
        referenceId: event.referenceId ?? undefined,
        amountMinor: event.amount ? BigInt(event.amount) : undefined,
        currency: event.currency ?? undefined,
      },
    });
    return true;
  }
}

@Injectable()
export class DisbursementFailedHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly settlementOutcome: SettlementOutcomeService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) {
      await this.settlementOutcome.apply(tx, {
        payoutRef: event.externalId,
        eventKey: `gateway:failed:${event.id}`,
        signal: { kind: 'failed' },
      });
      return true;
    }

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn({ externalId: event.externalId }, 'disbursement failed: payout not found');
      return true;
    }

    // The hold is released inside PayoutLifecycleService.
    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:failed:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: { kind: 'failed', code: 'gateway_failed' },
      gatewayDetails: { referenceId: event.referenceId ?? undefined },
    });
    return true;
  }
}

@Injectable()
export class DisbursementExpiredHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) return true;

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn({ externalId: event.externalId }, 'disbursement expired: payout not found');
      return true;
    }

    // The hold is released inside PayoutLifecycleService (expired is treated the same as
    // failed for hold purposes).
    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:expired:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: { kind: 'expired', code: 'gateway_expired' },
      gatewayDetails: { referenceId: event.referenceId ?? undefined },
    });
    return true;
  }
}

@Injectable()
export class DisbursementCancelledHandler implements EventHandler {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly transactions: TransactionsRepository,
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService
  ) {}

  async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    if (isSettlementPayout(event.externalId)) return true;

    const payoutId = await findMerchantPayout(this.transactions, this.payouts, event.externalId);
    if (!payoutId) {
      this.logger.warn(
        { externalId: event.externalId },
        'disbursement cancelled: payout not found'
      );
      return true;
    }

    // The hold is released inside PayoutLifecycleService.
    await this.lifecycle.apply(tx, payoutId, {
      eventKey: `gateway:cancelled:${event.id}`,
      source: 'gateway',
      occurredAt: event.occurredAt,
      signal: { kind: 'cancelled', code: 'gateway_cancelled' },
      gatewayDetails: { referenceId: event.referenceId ?? undefined },
    });
    return true;
  }
}
