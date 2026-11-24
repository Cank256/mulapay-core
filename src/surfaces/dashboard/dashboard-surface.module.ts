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
import { BalancesModule } from '../../modules/balances/balances.module';
import { DeveloperModule } from '../../modules/developer/developer.module';
import { ComplaintsModule } from '../../modules/complaints/complaints.module';
import { DisputesModule } from '../../modules/disputes/disputes.module';
import { EventsModule } from '../../modules/events/events.module';
import { HoldsModule } from '../../modules/holds/holds.module';
import { IncidentsModule } from '../../modules/incidents/incidents.module';
import { KycModule } from '../../modules/kyc/kyc.module';
import { MerchantsModule } from '../../modules/merchants/merchants.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { PaymentsModule } from '../../modules/payments/payments.module';
import { PayoutsModule } from '../../modules/payouts/payouts.module';
import { RefundsModule } from '../../modules/refunds/refunds.module';
import { ReportsModule } from '../../modules/reports/reports.module';
import { RollupsModule } from '../../modules/rollups/rollups.module';
import { SettlementModule } from '../../modules/settlement/settlement.module';
import { TransactionsModule } from '../../modules/transactions/transactions.module';
import { WebhooksModule } from '../../modules/webhooks/webhooks.module';
import { DashboardAnalyticsController } from './analytics.controller';
import { DashboardApiKeysController } from './api-keys.controller';
import { DashboardAuthController } from './auth.controller';
import { DashboardBalancesController } from './balances.controller';
import { DashboardComplaintsController } from './complaints.controller';
import { DashboardDisputesController } from './disputes.controller';
import { DashboardEventsController } from './events.controller';
import { DashboardKycController } from './kyc.controller';
import { DashboardMerchantController } from './merchant.controller';
import { DashboardPayoutsController } from './payouts.controller';
import {
  DashboardPaymentsController,
  DashboardTransactionsController,
} from './payments.controller';
import { DashboardNotificationsController } from './notifications.controller';
import {
  DashboardReportSchedulesController,
  DashboardReportsController,
} from './reports.controller';
import { DashboardRefundsController } from './refunds.controller';
import { DashboardRequestLogsController } from './request-logs.controller';
import { DashboardSettlementsController } from './settlements.controller';
import { DashboardStatusController } from './status.controller';
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
    BalancesModule,
    ComplaintsModule,
    DeveloperModule,
    DisputesModule,
    EventsModule,
    HoldsModule,
    IncidentsModule,
    KycModule,
    NotificationsModule,
    PaymentsModule,
    PayoutsModule,
    RefundsModule,
    ReportsModule,
    RollupsModule,
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
    DashboardPayoutsController,
    DashboardRefundsController,
    DashboardBalancesController,
    DashboardEventsController,
    DashboardWebhookEndpointsController,
    DashboardWebhookDeliveriesController,
    DashboardRequestLogsController,
    DashboardSettlementsController,
    DashboardKycController,
    DashboardDisputesController,
    DashboardComplaintsController,
    DashboardNotificationsController,
    DashboardReportsController,
    DashboardReportSchedulesController,
    DashboardAnalyticsController,
    DashboardStatusController,
  ],
})
export class DashboardSurfaceModule {}
