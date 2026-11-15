/**
 * `/v1` surface (spec section 4.2): merchant servers, authenticated by API key.
 *
 * Controllers for this surface live in this module tree only. The AuthGuard picks the
 * authentication method from the matched route's surface, so a controller here can
 * never be reached with a dashboard or admin token. Domain services are shared;
 * controllers are not.
 */
import { Module } from '@nestjs/common';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { TransactionsModule } from '../../modules/transactions/transactions.module';
import { CheckoutSessionsController } from './checkout-sessions.controller';
import { PaymentLinksController } from './payment-links.controller';
import { PaymentsController } from './payments.controller';
import { PingController } from './ping.controller';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [PaymentsModule, TransactionsModule],
  controllers: [
    PingController,
    PaymentsController,
    PaymentLinksController,
    CheckoutSessionsController,
    TransactionsController,
  ],
})
export class PublicSurfaceModule {}
