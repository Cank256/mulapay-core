import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { GatewayOperationsModule } from '../../integrations/gateway/gateway-operations.module';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { OperationsModule } from '../operations/operations.module';
import { PaymentsModule } from '../payments/payments.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { RefundCreator } from './refund-creator';
import { RefundGatewaySubmitter } from './refund-gateway-submitter.service';
import { RefundLifecycleService } from './refund-lifecycle.service';
import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';

/**
 * Refunds module: allows merchants to refund payments by posting reversing ledger entries.
 */
@Module({
  imports: [
    BalancesModule,
    EventsModule,
    GatewayOperationsModule,
    IdempotencyModule,
    LedgerModule,
    MerchantsModule,
    OperationsModule,
    OutboxModule,
    PaymentsModule,
    TransactionsModule,
  ],
  providers: [
    RefundsRepository,
    RefundCreator,
    RefundLifecycleService,
    RefundGatewaySubmitter,
    RefundsService,
  ],
  exports: [RefundsService, RefundLifecycleService, RefundsRepository],
})
export class RefundsModule {}
