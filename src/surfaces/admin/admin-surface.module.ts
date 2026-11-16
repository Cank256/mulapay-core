/**
 * `/admin/v1` surface (spec section 4.2): the admin console, authenticated by an admin
 * JWT that carries an MFA assertion, staff only.
 *
 * Controllers for this surface live in this module tree only. Domain services are
 * shared; controllers are not.
 */
import { Module } from '@nestjs/common';
import { AmlModule } from '../../modules/aml/aml.module';
import { BalancesModule } from '../../modules/balances/balances.module';
import { ComplaintsModule } from '../../modules/complaints/complaints.module';
import { DisputesModule } from '../../modules/disputes/disputes.module';
import { HoldsModule } from '../../modules/holds/holds.module';
import { IncidentsModule } from '../../modules/incidents/incidents.module';
import { LedgerModule } from '../../modules/ledger/ledger.module';
import { AuditLogsModule } from '../../modules/audit/audit-logs.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { IdentityModule } from '../../modules/identity/identity.module';
import { KycModule } from '../../modules/kyc/kyc.module';
import { MerchantsModule } from '../../modules/merchants/merchants.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { OperationsModule } from '../../modules/operations/operations.module';
import { ReconciliationModule } from '../../modules/reconciliation/reconciliation.module';
import { ReportsModule } from '../../modules/reports/reports.module';
import { SettlementModule } from '../../modules/settlement/settlement.module';
import { AdminAmlCasesController } from './admin-aml-cases.controller';
import { AdminComplaintsController } from './admin-complaints.controller';
import { AdminIncidentsController } from './admin-incidents.controller';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminOpsController } from './admin-ops.controller';
import {
  AdminProvidersController,
  AdminRoutingRulesController,
} from './admin-providers.controller';
import { AdminReportsController } from './admin-reports.controller';
import { AdminAmlControlsController } from './admin-aml-controls.controller';
import { AdminDisputesController } from './admin-disputes.controller';
import { AdminKycController } from './admin-kyc.controller';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { AdminSettlementController } from './admin-settlement.controller';
import { AdminBalancesController } from './admin-balances.controller';
import { AdminLedgerController } from './admin-ledger.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminMerchantsController } from './admin-merchants.controller';
import { AdminRolesController } from './admin-roles.controller';

@Module({
  imports: [
    AmlModule,
    ComplaintsModule,
    DisputesModule,
    IncidentsModule,
    NotificationsModule,
    OperationsModule,
    ReportsModule,
    KycModule,
    AuthModule,
    MerchantsModule,
    IdentityModule,
    AuditLogsModule,
    LedgerModule,
    BalancesModule,
    HoldsModule,
    ReconciliationModule,
    SettlementModule,
  ],
  controllers: [
    AdminAuthController,
    AdminMerchantsController,
    AdminRolesController,
    AdminAuditController,
    AdminLedgerController,
    AdminBalancesController,
    AdminSettlementController,
    AdminReconciliationController,
    AdminKycController,
    AdminAmlCasesController,
    AdminAmlControlsController,
    AdminDisputesController,
    AdminComplaintsController,
    AdminIncidentsController,
    AdminOpsController,
    AdminProvidersController,
    AdminRoutingRulesController,
    AdminNotificationsController,
    AdminReportsController,
  ],
})
export class AdminSurfaceModule {}
