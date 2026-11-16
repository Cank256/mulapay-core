/**
 * `/dashboard/v1` surface (spec section 4.2): the merchant dashboard, authenticated by a
 * dashboard JWT and scoped to the merchant the session is bound to.
 *
 * Controllers for this surface live in this module tree only. Domain services are
 * shared; controllers are not.
 */
import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../../modules/api-keys/api-keys.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { DeveloperModule } from '../../modules/developer/developer.module';
import { MerchantsModule } from '../../modules/merchants/merchants.module';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { SettlementModule } from '../../modules/settlement/settlement.module';
import { TransactionsModule } from '../../modules/transactions/transactions.module';
import { WebhooksModule } from '../../modules/webhooks/webhooks.module';
import { DashboardApiKeysController } from './api-keys.controller';
import { DashboardAuthController } from './auth.controller';
import { DashboardMerchantController } from './merchant.controller';
import {
  DashboardPaymentsController,
  DashboardTransactionsController,
} from './payments.controller';
import { DashboardRequestLogsController } from './request-logs.controller';
import { DashboardSettlementsController } from './settlements.controller';
import { DashboardTeamController } from './team.controller';
import {
  DashboardWebhookDeliveriesController,
  DashboardWebhookEndpointsController,
} from './webhooks.controller';

@Module({
  imports: [
    AuthModule,
    MerchantsModule,
    ApiKeysModule,
    DeveloperModule,
    PaymentsModule,
    SettlementModule,
    TransactionsModule,
    WebhooksModule,
  ],
  controllers: [
    DashboardAuthController,
    DashboardMerchantController,
    DashboardTeamController,
    DashboardApiKeysController,
    DashboardPaymentsController,
    DashboardTransactionsController,
    DashboardWebhookEndpointsController,
    DashboardWebhookDeliveriesController,
    DashboardRequestLogsController,
    DashboardSettlementsController,
  ],
})
export class DashboardSurfaceModule {}
