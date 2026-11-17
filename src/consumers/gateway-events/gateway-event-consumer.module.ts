/**
 * Gateway event consumer module: wires the consumer service with its dependencies (event source,
 * unit of work, clock, handler registry). The consumer starts automatically on module init.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../common/db/database.module';
import { GatewayEventSourceModule } from '../../integrations/gateway/gateway-event-source.module';
import { GatewayEventConsumer } from './gateway-event.consumer';
import { GatewayEventHandlerRegistry } from './handler.registry';
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

@Module({
  imports: [GatewayEventSourceModule, DatabaseModule],
  providers: [
    GatewayEventConsumer,
    GatewayEventHandlerRegistry,
    // Collection handlers
    CollectionPendingHandler,
    CollectionUnknownHandler,
    CollectionSuccessfulHandler,
    CollectionFailedHandler,
    CollectionExpiredHandler,
    CollectionCancelledHandler,
    // Disbursement handlers
    DisbursementPendingHandler,
    DisbursementUnknownHandler,
    DisbursementSuccessfulHandler,
    DisbursementFailedHandler,
    DisbursementExpiredHandler,
    DisbursementCancelledHandler,
    // Refund handlers
    RefundPendingHandler,
    RefundUnknownHandler,
    RefundSuccessfulHandler,
    RefundFailedHandler,
    RefundExpiredHandler,
    RefundCancelledHandler,
  ],
  exports: [GatewayEventConsumer],
})
export class GatewayEventConsumerModule {}
