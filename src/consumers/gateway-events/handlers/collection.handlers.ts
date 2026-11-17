/**
 * Collection event handlers (6 combinations): apply payment lifecycle transitions. Built on
 * `PaymentLifecycleService.apply` (Phase 2). Each handler is idempotent.
 */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import type { EventHandler } from '../handler.port';

/**
 * Collection pending: payment is processing at the provider. Core does nothing (payment is
 * already in `processing` state after the initial 201).
 */
@Injectable()
export class CollectionPendingHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // Payment is already in processing; this is a no-op confirmation
    // TODO P4: verify transaction exists and is in processing state
    return true;
  }
}

/**
 * Collection unknown: the gateway does not know the outcome (504, ambiguous provider response).
 * Core marks the payment `outcome_unknown` and waits for reconciliation.
 */
@Injectable()
export class CollectionUnknownHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4: mark transaction with outcome_unknown flag
    return true;
  }
}

/**
 * Collection successful: payment completed. Post the collection entry to the ledger (debits
 * provider_receivable, credits merchant_payable, debits fee if any).
 */
@Injectable()
export class CollectionSuccessfulHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4: call PaymentLifecycleService.apply with 'succeeded' transition
    // Must be idempotent: check if ledger entry already exists
    return true;
  }
}

/**
 * Collection failed: payment failed at the provider (insufficient funds, invalid number, etc.).
 * Mark the payment `failed`, no ledger movement.
 */
@Injectable()
export class CollectionFailedHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4: transition payment to failed state
    return true;
  }
}

/**
 * Collection expired: payment timed out at the provider. Mark the payment `expired`, no ledger
 * movement.
 */
@Injectable()
export class CollectionExpiredHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4: transition payment to expired state
    return true;
  }
}

/**
 * Collection cancelled: payment was cancelled (user or provider). Mark the payment `cancelled`,
 * no ledger movement.
 */
@Injectable()
export class CollectionCancelledHandler implements EventHandler {
  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4: transition payment to cancelled state
    return true;
  }
}
