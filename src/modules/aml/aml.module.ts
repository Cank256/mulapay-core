import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { SanctionsModule } from '../../integrations/sanctions/sanctions.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { AuditLogsModule } from '../audit/audit-logs.module';
import { BalancesModule } from '../balances/balances.module';
import { HoldsModule } from '../holds/holds.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { AmlStaffDirectory } from './aml-staff.directory';
import { AmlAlertsRepository } from './alerts/aml-alerts.repository';
import { AmlAlertsService } from './alerts/aml-alerts.service';
import { AmlBlocklistRepository } from './blocklist/aml-blocklist.repository';
import { AmlBlocklistService } from './blocklist/aml-blocklist.service';
import { AmlBlocksRepository } from './block/aml-blocks.repository';
import { AmlBlockService } from './block/aml-block.service';
import { PayoutControlService } from './block/payout-control.service';
import { AmlCasesRepository } from './cases/aml-cases.repository';
import { AmlCasesService } from './cases/aml-cases.service';
import { AmlStrDataRepository } from './cases/aml-str-data.repository';
import { AmlStrExportService } from './cases/aml-str-export.service';
import { MerchantLimitsRepository } from './limits/merchant-limits.repository';
import { MerchantLimitsService } from './limits/merchant-limits.service';
import { AmlFactsRepository } from './monitoring/aml-facts.repository';
import { AmlMonitoringService } from './monitoring/aml-monitoring.service';
import { AmlMonitoringTrigger, AmlTerminalHandler } from './monitoring/aml-monitoring.trigger';
import { AmlPrecheckService } from './precheck/precheck.service';
import { AmlMonitoringCoverageService } from './rules/aml-monitoring-coverage.service';
import { AmlRulesRepository } from './rules/aml-rules.repository';
import { AmlRulesService } from './rules/aml-rules.service';
import { AmlScreeningsRepository } from './screening/aml-screenings.repository';
import { AmlScreeningService } from './screening/aml-screening.service';

/**
 * AML (spec 6.13): onboarding screening, the synchronous pre-transaction check, post-
 * transaction monitoring, alerts, cases, STR export, the blocklist and the merchant block.
 * Nothing here owns financial truth; holds go through `HoldsService` and a block never
 * touches a transaction or a ledger entry.
 */
@Module({
  imports: [
    AuditLogsModule,
    BalancesModule,
    HoldsModule,
    MerchantsModule,
    OutboxModule,
    SanctionsModule,
    StorageModule,
  ],
  providers: [
    AmlStaffDirectory,
    AmlAlertsRepository,
    AmlAlertsService,
    AmlBlocklistRepository,
    AmlBlocklistService,
    AmlBlocksRepository,
    AmlBlockService,
    PayoutControlService,
    AmlCasesRepository,
    AmlCasesService,
    AmlStrDataRepository,
    AmlStrExportService,
    MerchantLimitsRepository,
    MerchantLimitsService,
    AmlFactsRepository,
    AmlMonitoringService,
    AmlMonitoringTrigger,
    AmlTerminalHandler,
    AmlPrecheckService,
    AmlRulesRepository,
    AmlRulesService,
    AmlMonitoringCoverageService,
    AmlScreeningsRepository,
    AmlScreeningService,
  ],
  exports: [
    AmlStaffDirectory,
    AmlAlertsService,
    AmlBlocklistService,
    AmlBlockService,
    PayoutControlService,
    AmlCasesService,
    AmlStrExportService,
    MerchantLimitsService,
    AmlMonitoringService,
    AmlMonitoringTrigger,
    AmlTerminalHandler,
    AmlPrecheckService,
    AmlRulesService,
    AmlScreeningService,
  ],
})
export class AmlModule {}
