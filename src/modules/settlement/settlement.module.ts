import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { GatewayOperationsModule } from '../../integrations/gateway/gateway-operations.module';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { HoldsModule } from '../holds/holds.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { MerchantSettlementsService } from './merchant-settlements.service';
import { RollingReserveService } from './rolling-reserve.service';
import { SettlementBatchService } from './settlement-batch.service';
import { SettlementBatchesRepository } from './settlement-batches.repository';
import { SettlementCyclesRepository } from './settlement-cycles.repository';
import { SettlementCyclesService } from './settlement-cycles.service';
import { SettlementDestinationsRepository } from './settlement-destinations.repository';
import { SettlementDestinationsService } from './settlement-destinations.service';
import { SettlementEligibilityRepository } from './settlement-eligibility.repository';
import { SettlementOutcomeService } from './settlement-outcome.service';
import { SettlementReleaseService } from './settlement-release.service';
import { SettlementReportsRepository } from './settlement-reports.repository';
import { SettlementReportsService } from './settlement-reports.service';
import { SettlementRunService } from './settlement-run.service';
import { SettlementSubmitHandler } from './settlement-submit.handler';
import { SettlementTickService } from './settlement-tick.service';

/** Settlement (spec 6.9): cycles, runs, batches, release, rolling reserve and statements. */
@Module({
  imports: [
    BalancesModule,
    EventsModule,
    GatewayOperationsModule,
    HoldsModule,
    LedgerModule,
    MerchantsModule,
    OutboxModule,
    ReconciliationModule,
    TransactionsModule,
  ],
  providers: [
    SettlementBatchesRepository,
    SettlementCyclesRepository,
    SettlementDestinationsRepository,
    SettlementEligibilityRepository,
    SettlementReportsRepository,
    MerchantSettlementsService,
    RollingReserveService,
    SettlementBatchService,
    SettlementCyclesService,
    SettlementDestinationsService,
    SettlementOutcomeService,
    SettlementReleaseService,
    SettlementReportsService,
    SettlementRunService,
    SettlementTickService,
    SettlementSubmitHandler,
  ],
  exports: [
    MerchantSettlementsService,
    SettlementBatchesRepository,
    SettlementBatchService,
    SettlementCyclesService,
    SettlementDestinationsService,
    SettlementOutcomeService,
    SettlementReleaseService,
    SettlementReportsService,
    SettlementRunService,
    SettlementTickService,
    SettlementSubmitHandler,
    RollingReserveService,
    SettlementCyclesRepository,
    SettlementEligibilityRepository,
  ],
})
export class SettlementModule {}
