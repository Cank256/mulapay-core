import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { GatewayOperationsModule } from '../../integrations/gateway/gateway-operations.module';
import { BalancesModule } from '../balances/balances.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BalanceProofCheck } from './checks/balance-proof.check';
import { GatewayGapCheck } from './checks/gateway-gap.check';
import { LedgerIntegrityCheck } from './checks/ledger-integrity.check';
import { StatementMatchCheck } from './checks/statement-match.check';
import { ReconciliationExceptionRecorder } from './exception-recorder';
import { ReconciliationExceptionsService } from './exceptions.service';
import { ReconciliationExceptionsRepository } from './reconciliation-exceptions.repository';
import { ReconciliationQueriesRepository } from './reconciliation-queries.repository';
import { ReconciliationReportsService } from './reconciliation-reports.service';
import { ReconciliationRunsRepository } from './reconciliation-runs.repository';
import {
  RECONCILIATION_CHECKS,
  ReconciliationRunService,
  type ReconciliationCheck,
} from './reconciliation-run.service';
import { ReconciliationScheduler } from './reconciliation-scheduler.service';
import { StatementUploadedHandler } from './statement-uploaded.handler';
import { StatementsRepository } from './statements.repository';
import { StatementsService } from './statements.service';

/** Reconciliation (spec 6.8): the four runs, the exception queue and statements. */
@Module({
  imports: [GatewayOperationsModule, LedgerModule, BalancesModule, IncidentsModule, OutboxModule],
  providers: [
    ReconciliationRunsRepository,
    ReconciliationExceptionsRepository,
    ReconciliationQueriesRepository,
    StatementsRepository,
    ReconciliationExceptionRecorder,
    ReconciliationRunService,
    ReconciliationExceptionsService,
    ReconciliationReportsService,
    ReconciliationScheduler,
    StatementsService,
    StatementUploadedHandler,
    GatewayGapCheck,
    LedgerIntegrityCheck,
    StatementMatchCheck,
    BalanceProofCheck,
    {
      provide: RECONCILIATION_CHECKS,
      inject: [GatewayGapCheck, LedgerIntegrityCheck, StatementMatchCheck, BalanceProofCheck],
      useFactory: (...checks: ReconciliationCheck[]) => checks,
    },
  ],
  exports: [
    ReconciliationExceptionRecorder,
    ReconciliationRunService,
    ReconciliationExceptionsService,
    ReconciliationReportsService,
    ReconciliationScheduler,
    StatementsService,
    StatementUploadedHandler,
    ReconciliationExceptionsRepository,
  ],
})
export class ReconciliationModule {}
