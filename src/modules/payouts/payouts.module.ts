import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { GatewayOperationsModule } from '../../integrations/gateway/gateway-operations.module';
import { AmlModule } from '../aml/aml.module';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { HoldsModule } from '../holds/holds.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { OperationsModule } from '../operations/operations.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { PayoutCreator } from './payout-creator';
import { PayoutGatewaySubmitter } from './payout-gateway-submitter.service';
import { PayoutLifecycleService } from './payout-lifecycle.service';
import { PayoutsRepository } from './payouts.repository';
import { PayoutsService } from './payouts.service';

/**
 * Payouts module: allows merchants to disburse funds to recipients.
 */
@Module({
  imports: [
    AmlModule,
    BalancesModule,
    EventsModule,
    GatewayOperationsModule,
    HoldsModule,
    IdempotencyModule,
    LedgerModule,
    MerchantsModule,
    OperationsModule,
    OutboxModule,
    TransactionsModule,
  ],
  providers: [
    PayoutsRepository,
    PayoutCreator,
    PayoutLifecycleService,
    PayoutGatewaySubmitter,
    PayoutsService,
  ],
  exports: [PayoutsService, PayoutLifecycleService, PayoutsRepository],
})
export class PayoutsModule {}
