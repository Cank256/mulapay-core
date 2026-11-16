import { Module } from '@nestjs/common';
import { GatewayOperationsModule } from '../../integrations/gateway/gateway-operations.module';
import { AmlModule } from '../aml/aml.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { APPROVAL_EXECUTORS } from './approvals/approval-executor';
import {
  ConsumerCursorRewindExecutor,
  FeatureFlagChangeExecutor,
  ProviderDisableExecutor,
  RoutingRuleRemoveExecutor,
} from './approvals/approval-executors';
import { ApprovalsRepository } from './approvals/approvals.repository';
import { ApprovalsService } from './approvals/approvals.service';
import { ConsumerCursorsService } from './consumer-cursors.service';
import { FeatureFlagsService } from './feature-flags.service';
import { FlagCache } from './flag-cache';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceService } from './maintenance.service';
import { OpsChangeApplier } from './ops-change-applier';
import { OpsConfigRepository } from './ops-config.repository';
import { OpsMonitorService } from './ops-monitor.service';
import { OpsOverviewService } from './ops-overview.service';
import { OpsSignalsRepository } from './ops-signals.repository';
import { ProviderOpsService } from './provider-ops.service';
import { QueueOpsService } from './queue-ops.service';
import { RoutingRulesService } from './routing-rules.service';

/**
 * The operations back office (spec 6.14): queues, consumer cursor and lag, stuck transactions,
 * suspense, feature flags, maintenance mode, providers, routing rules, the approvals inbox and
 * the automatic incident monitors.
 */
@Module({
  imports: [
    AmlModule,
    GatewayOperationsModule,
    IncidentsModule,
    MerchantsModule,
    NotificationsModule,
  ],
  providers: [
    ApprovalsRepository,
    ApprovalsService,
    ConsumerCursorRewindExecutor,
    FeatureFlagChangeExecutor,
    ProviderDisableExecutor,
    RoutingRuleRemoveExecutor,
    {
      provide: APPROVAL_EXECUTORS,
      inject: [
        ConsumerCursorRewindExecutor,
        FeatureFlagChangeExecutor,
        ProviderDisableExecutor,
        RoutingRuleRemoveExecutor,
      ],
      useFactory: (...executors: unknown[]) => executors,
    },
    FlagCache,
    OpsConfigRepository,
    OpsSignalsRepository,
    OpsChangeApplier,
    FeatureFlagsService,
    ProviderOpsService,
    RoutingRulesService,
    ConsumerCursorsService,
    QueueOpsService,
    MaintenanceService,
    MaintenanceGuard,
    OpsOverviewService,
    OpsMonitorService,
  ],
  exports: [
    ApprovalsService,
    ConsumerCursorsService,
    FeatureFlagsService,
    MaintenanceGuard,
    MaintenanceService,
    OpsMonitorService,
    OpsOverviewService,
    ProviderOpsService,
    QueueOpsService,
    RoutingRulesService,
  ],
})
export class OperationsModule {}
