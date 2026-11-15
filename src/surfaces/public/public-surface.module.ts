/**
 * `/v1` surface (spec section 4.2): merchant servers, authenticated by API key.
 *
 * Controllers for this surface live in this module tree only. The AuthGuard picks the
 * authentication method from the matched route's surface, so a controller here can
 * never be reached with a dashboard or admin token. Domain services are shared;
 * controllers are not.
 */
import { Module } from '@nestjs/common';
import { BalancesModule } from '../../modules/balances/balances.module';
import { EventsModule } from '../../modules/events/events.module';
import { HoldsModule } from '../../modules/holds/holds.module';
import { LedgerModule } from '../../modules/ledger/ledger.module';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { TransactionsModule } from '../../modules/transactions/transactions.module';
import { WebhooksModule } from '../../modules/webhooks/webhooks.module';
import {
  BalanceTransactionsController,
  BalancesController,
  HoldsController,
} from './balances.controller';
import { CheckoutSessionsController } from './checkout-sessions.controller';
import { EventsController } from './events.controller';
import { PaymentLinksController } from './payment-links.controller';
import { PaymentsController } from './payments.controller';
import { PingController } from './ping.controller';
import { TransactionsController } from './transactions.controller';
import { WebhookEndpointsController } from './webhook-endpoints.controller';

@Module({
  imports: [
    BalancesModule,
    EventsModule,
    HoldsModule,
    LedgerModule,
    PaymentsModule,
    TransactionsModule,
    WebhooksModule,
  ],
  controllers: [
    PingController,
    PaymentsController,
    PaymentLinksController,
    CheckoutSessionsController,
    TransactionsController,
    BalancesController,
    BalanceTransactionsController,
    HoldsController,
    EventsController,
    WebhookEndpointsController,
  ],
})
export class PublicSurfaceModule {}
