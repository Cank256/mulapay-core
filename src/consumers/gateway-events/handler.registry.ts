/**
 * Gateway event handler registry: maps `(operation_type, status)` to the appropriate handler.
 * All 18 combinations are registered (3 operation types × 6 statuses).
 */
import { Injectable } from '@nestjs/common';
import type { EventHandler, EventHandlerRegistry } from './handler.port';
import {
  CollectionCancelledHandler,
  CollectionExpiredHandler,
  CollectionFailedHandler,
  CollectionPendingHandler,
  CollectionSuccessfulHandler,
  CollectionUnknownHandler,
} from './handlers/collection.handlers';
import {
  DisbursementCancelledHandler,
  DisbursementExpiredHandler,
  DisbursementFailedHandler,
  DisbursementPendingHandler,
  DisbursementSuccessfulHandler,
  DisbursementUnknownHandler,
} from './handlers/disbursement.handlers';
import {
  RefundCancelledHandler,
  RefundExpiredHandler,
  RefundFailedHandler,
  RefundPendingHandler,
  RefundSuccessfulHandler,
  RefundUnknownHandler,
} from './handlers/refund.handlers';

@Injectable()
export class GatewayEventHandlerRegistry implements EventHandlerRegistry {
  private readonly handlers = new Map<string, EventHandler>();

  constructor(
    // Collection handlers (6)
    collectionPending: CollectionPendingHandler,
    collectionUnknown: CollectionUnknownHandler,
    collectionSuccessful: CollectionSuccessfulHandler,
    collectionFailed: CollectionFailedHandler,
    collectionExpired: CollectionExpiredHandler,
    collectionCancelled: CollectionCancelledHandler,
    // Disbursement handlers (6)
    disbursementPending: DisbursementPendingHandler,
    disbursementUnknown: DisbursementUnknownHandler,
    disbursementSuccessful: DisbursementSuccessfulHandler,
    disbursementFailed: DisbursementFailedHandler,
    disbursementExpired: DisbursementExpiredHandler,
    disbursementCancelled: DisbursementCancelledHandler,
    // Refund handlers (6)
    refundPending: RefundPendingHandler,
    refundUnknown: RefundUnknownHandler,
    refundSuccessful: RefundSuccessfulHandler,
    refundFailed: RefundFailedHandler,
    refundExpired: RefundExpiredHandler,
    refundCancelled: RefundCancelledHandler
  ) {
    // Collection
    this.register('collection', 'pending', collectionPending);
    this.register('collection', 'unknown', collectionUnknown);
    this.register('collection', 'successful', collectionSuccessful);
    this.register('collection', 'failed', collectionFailed);
    this.register('collection', 'expired', collectionExpired);
    this.register('collection', 'cancelled', collectionCancelled);

    // Disbursement
    this.register('disbursement', 'pending', disbursementPending);
    this.register('disbursement', 'unknown', disbursementUnknown);
    this.register('disbursement', 'successful', disbursementSuccessful);
    this.register('disbursement', 'failed', disbursementFailed);
    this.register('disbursement', 'expired', disbursementExpired);
    this.register('disbursement', 'cancelled', disbursementCancelled);

    // Refund
    this.register('refund', 'pending', refundPending);
    this.register('refund', 'unknown', refundUnknown);
    this.register('refund', 'successful', refundSuccessful);
    this.register('refund', 'failed', refundFailed);
    this.register('refund', 'expired', refundExpired);
    this.register('refund', 'cancelled', refundCancelled);
  }

  getHandler(operationType: string, status: string): EventHandler | undefined {
    return this.handlers.get(this.key(operationType, status));
  }

  private register(operationType: string, status: string, handler: EventHandler): void {
    this.handlers.set(this.key(operationType, status), handler);
  }

  private key(operationType: string, status: string): string {
    return `${operationType}:${status}`;
  }
}
