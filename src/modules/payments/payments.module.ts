import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { CheckoutSessionsRepository } from './checkout-sessions.repository';
import { CheckoutSessionsService } from './checkout-sessions.service';
import { PaymentCreator } from './payment-creator';
import { PaymentExpiryService } from './payment-expiry.service';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentLinksRepository } from './payment-links.repository';
import { PaymentLinksService } from './payment-links.service';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

/**
 * Payments, payment links and checkout sessions (spec 6.1). No gateway: a payment is
 * created and its lifecycle is driven by `PaymentLifecycleService`, which the gateway event
 * consumer and the chase job will call.
 */
@Module({
  imports: [
    BalancesModule,
    EventsModule,
    IdempotencyModule,
    LedgerModule,
    MerchantsModule,
    OutboxModule,
    TransactionsModule,
  ],
  providers: [
    PaymentsRepository,
    PaymentLinksRepository,
    CheckoutSessionsRepository,
    PaymentCreator,
    PaymentLifecycleService,
    PaymentsService,
    PaymentLinksService,
    CheckoutSessionsService,
    PaymentExpiryService,
  ],
  exports: [
    PaymentsService,
    PaymentLinksService,
    CheckoutSessionsService,
    PaymentLifecycleService,
    PaymentExpiryService,
    PaymentsRepository,
  ],
})
export class PaymentsModule {}
