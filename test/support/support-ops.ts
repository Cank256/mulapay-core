/**
 * Fixtures for the Phase 8 suites (support and operations): the compliance context (real payments,
 * ledger, in-process S3) plus an in-process messaging vendor, an outbox dispatcher and the real
 * queue processors driven by hand, staff and merchant users in any role, and a database to run
 * on.
 *
 * Suites that change platform-wide state (maintenance mode, providers, routing rules, feature
 * flags, the consumer cursor) or that read every transaction (the incident monitors) pass
 * `isolated: true`: they run on their own database (`global-setup.ts`), Redis database and queue prefix.
 */
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import pino from 'pino';
import { inject } from 'vitest';
import { OutboxDispatcher } from '../../src/common/outbox/outbox-dispatcher';
import { OutboxRepository } from '../../src/common/outbox/outbox.repository';
import { QueueRegistry } from '../../src/common/queue/queue.registry';
import { ReportGenerateProcessor } from '../../src/jobs/report-generate.processor';
import { NotificationSendProcessor } from '../../src/jobs/notification-send.processor';
import { SupportOpsProcessor } from '../../src/jobs/support-ops.processor';
import { RollupProcessor } from '../../src/jobs/rollup.processor';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { ComplaintsService } from '../../src/modules/complaints/complaints.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { MerchantEventsService } from '../../src/modules/events/merchant-events.service';
import {
  NotificationDeliverHandler,
  NotificationEventHandler,
} from '../../src/modules/notifications/notification.handlers';
import { NotificationDeliveryService } from '../../src/modules/notifications/notification-delivery.service';
import { NotificationsRepository } from '../../src/modules/notifications/notifications.repository';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { ApprovalsService } from '../../src/modules/operations/approvals/approvals.service';
import { ConsumerCursorsService } from '../../src/modules/operations/consumer-cursors.service';
import { FeatureFlagsService } from '../../src/modules/operations/feature-flags.service';
import { MaintenanceService } from '../../src/modules/operations/maintenance.service';
import { OpsMonitorService } from '../../src/modules/operations/ops-monitor.service';
import { OpsOverviewService } from '../../src/modules/operations/ops-overview.service';
import { ProviderOpsService } from '../../src/modules/operations/provider-ops.service';
import { QueueOpsService } from '../../src/modules/operations/queue-ops.service';
import { RoutingRulesService } from '../../src/modules/operations/routing-rules.service';
import { ReportGenerationService } from '../../src/modules/reports/report-generation.service';
import { ReportRequestedHandler } from '../../src/modules/reports/report.handlers';
import { ReportSchedulesService } from '../../src/modules/reports/report-schedules.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { RollupsService } from '../../src/modules/rollups/rollups.service';
import { startFakeMessaging, type FakeMessaging } from './fake-messaging';
import { startComplianceContext, type ComplianceContext } from './compliance';

export interface SupportContext extends ComplianceContext {
  readonly messaging: FakeMessaging;
  readonly queues: QueueRegistry;
  readonly dispatcher: OutboxDispatcher;
  readonly notificationsService: NotificationsService;
  readonly notificationsRepository: NotificationsRepository;
  readonly delivery: NotificationDeliveryService;
  readonly complaintsService: ComplaintsService;
  readonly incidentsService: IncidentsService;
  readonly reportsService: ReportsService;
  readonly schedulesService: ReportSchedulesService;
  readonly generation: ReportGenerationService;
  readonly rollups: RollupsService;
  readonly approvals: ApprovalsService;
  readonly flags: FeatureFlagsService;
  readonly maintenance: MaintenanceService;
  readonly monitor: OpsMonitorService;
  readonly overview: OpsOverviewService;
  readonly providers: ProviderOpsService;
  readonly routing: RoutingRulesService;
  readonly cursors: ConsumerCursorsService;
  readonly queueOps: QueueOpsService;
  readonly events: MerchantEventsService;
  readonly notificationProcessor: NotificationSendProcessor;
  readonly reportProcessor: ReportGenerateProcessor;
  readonly rollupProcessor: RollupProcessor;
  readonly supportProcessor: SupportOpsProcessor;
  /** The superuser SQL of the database this context runs on. */
  readonly query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
  /**
   * Publishes every due outbox row, then runs every job waiting on the given queues through its
   * real processor, until nothing is left. Stands in for the worker process.
   */
  pump(): Promise<void>;
}

export async function startSupportContext(
  options: { isolated?: boolean | 'runbooks'; overrides?: Record<string, string> } = {}
): Promise<SupportContext> {
  const messaging = await startFakeMessaging();
  const urls =
    options.isolated === 'runbooks'
      ? inject('runbookDatabaseUrls')
      : options.isolated
        ? inject('isolatedDatabaseUrls')
        : inject('databaseUrls');
  const base = await startComplianceContext({
    ...(options.isolated
      ? {
          DATABASE_URL: urls.rw,
          DATABASE_RO_URL: urls.ro,
          DATABASE_DIRECT_URL: urls.rw,
          // Redis keys without a prefix (the request-log buffer, rate limits) must not cross over
          // to the suites on the main database: use their own logical Redis database.
          REDIS_URL: `${inject('redisUrl').replace(/\/\d*$/, '')}/${options.isolated === 'runbooks' ? 2 : 1}`,
        }
      : {}),
    QUEUE_PREFIX: `p8-${randomUUID().slice(0, 8)}`,
    ...messaging.config(),
    ...options.overrides,
  });
  const get = <T>(token: new (...args: never[]) => T): T => base.app.get(token, { strict: false });
  const queues = get(QueueRegistry);
  const units = get(UnitOfWork);
  const reportsService = get(ReportsService);
  const schedulesService = get(ReportSchedulesService);
  const generation = get(ReportGenerationService);
  const delivery = get(NotificationDeliveryService);
  const rollups = get(RollupsService);
  const incidentsService = get(IncidentsService);
  const approvals = get(ApprovalsService);
  const complaintsService = get(ComplaintsService);
  const monitor = get(OpsMonitorService);
  const notificationProcessor = new NotificationSendProcessor(delivery, queues, base.config);
  const reportProcessor = new ReportGenerateProcessor(generation, schedulesService, reportsService);
  const rollupProcessor = new RollupProcessor(rollups);
  const supportProcessor = new SupportOpsProcessor(
    complaintsService,
    base.disputesService,
    approvals,
    monitor
  );
  const dispatcher = new OutboxDispatcher(
    get(OutboxRepository),
    units,
    queues,
    [get(NotificationDeliverHandler), get(NotificationEventHandler), get(ReportRequestedHandler)],
    base.clock,
    pino({ level: 'silent' })
  );
  const pg = new PgClient({ connectionString: urls.superuser });
  await pg.connect();

  const processors = [
    { queue: 'notification-send', run: notificationProcessor },
    { queue: 'report-generate', run: reportProcessor },
  ] as const;

  return {
    ...base,
    messaging,
    queues,
    dispatcher,
    notificationsService: get(NotificationsService),
    notificationsRepository: get(NotificationsRepository),
    delivery,
    complaintsService,
    incidentsService,
    reportsService,
    schedulesService,
    generation,
    rollups,
    approvals,
    flags: get(FeatureFlagsService),
    maintenance: get(MaintenanceService),
    monitor,
    overview: get(OpsOverviewService),
    providers: get(ProviderOpsService),
    routing: get(RoutingRulesService),
    cursors: get(ConsumerCursorsService),
    queueOps: get(QueueOpsService),
    events: get(MerchantEventsService),
    notificationProcessor,
    reportProcessor,
    rollupProcessor,
    supportProcessor,
    query: async (text, values = []) => (await pg.query(text, values)).rows as never,
    async pump() {
      for (let round = 0; round < 6; round++) {
        const published = await dispatcher.dispatch();
        let ran = 0;
        for (const { queue, run } of processors) {
          const q = queues.get(queue);
          const jobs = await q.getJobs(['waiting', 'delayed', 'prioritized']);
          for (const job of jobs) {
            try {
              await run.process(job);
            } catch {
              // A retryable failure: BullMQ would run it again; the pump does too, next round.
              continue;
            }
            await job.remove().catch(() => undefined);
            ran += 1;
          }
        }
        if (published === 0 && ran === 0) return;
      }
    },
    close: async () => {
      await pg.end();
      await base.close();
      await messaging.close();
    },
  };
}
