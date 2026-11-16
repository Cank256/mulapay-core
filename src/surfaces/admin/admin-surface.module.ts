/**
 * `/admin/v1` surface (spec section 4.2): the admin console, authenticated by an admin
 * JWT that carries an MFA assertion, staff only.
 *
 * Controllers for this surface live in this module tree only. Domain services are
 * shared; controllers are not.
 */
import { Module } from '@nestjs/common';
import { BalancesModule } from '../../modules/balances/balances.module';
import { HoldsModule } from '../../modules/holds/holds.module';
import { LedgerModule } from '../../modules/ledger/ledger.module';
import { AuditLogsModule } from '../../modules/audit/audit-logs.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { IdentityModule } from '../../modules/identity/identity.module';
import { MerchantsModule } from '../../modules/merchants/merchants.module';
import { ReconciliationModule } from '../../modules/reconciliation/reconciliation.module';
import { SettlementModule } from '../../modules/settlement/settlement.module';
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
  ],
})
export class AdminSurfaceModule {}
