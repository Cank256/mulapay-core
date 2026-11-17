/**
 * Registers the repeating jobs of the worker (spec 8.1, 8.8): BullMQ job schedulers, which
 * are keyed by id, so any number of workers booting at once registers each schedule once.
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '../common/queue/queue.definitions';
import { QueueRegistry } from '../common/queue/queue.registry';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/configuration';
import { AML_JOBS } from './aml-screen.processor';
import { LIFECYCLE_JOBS } from './data-lifecycle.processor';
import { NOTIFICATION_JOBS } from './notification-send.processor';
import { REPORT_JOBS } from './report-generate.processor';
import { ROLLUP_JOBS } from './rollup.processor';
import { SUPPORT_JOBS } from './support-ops.processor';
import { TICK_JOBS } from './outbox-dispatch.processor';
import { RECONCILIATION_JOBS } from './reconciliation-run.processor';
import { SETTLEMENT_TICK_JOB } from './settlement-run.processor';

const SCHEDULES = [
  { id: 'outbox-tick', every: 1_000, name: TICK_JOBS.outbox },
  { id: 'request-logs-flush', every: 2_000, name: TICK_JOBS.requestLogs },
  { id: 'api-keys-flush-last-used', every: 10_000, name: TICK_JOBS.lastUsed },
] as const;

/** A tick that fails is replaced by the next one; keep little history. */
const TICK_OPTIONS = { attempts: 1, removeOnComplete: 20, removeOnFail: 200 } as const;

@Injectable()
export class JobSchedulers implements OnApplicationBootstrap {
  constructor(
    private readonly queues: QueueRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QUEUES.outboxDispatch.name);
    for (const schedule of SCHEDULES) {
      await queue.upsertJobScheduler(
        schedule.id,
        { every: schedule.every },
        { name: schedule.name, opts: TICK_OPTIONS }
      );
    }
    await this.registerSettlementAndReconciliation();
    await this.registerCompliance();
    await this.registerSupportAndOperations();
    await this.registerDataLifecycle();
  }

  /**
   * Phase 6 (spec 6.8, 6.9): the settlement tick every minute, the gateway gap run every
   * `RECON_GAP_INTERVAL_SECONDS`, the ledger integrity run hourly and the balance proof daily
   * at 02:00 UTC. A duplicate or late tick is the same run: runs are keyed by time bucket.
   */
  private async registerSettlementAndReconciliation(): Promise<void> {
    await this.queues
      .get(QUEUES.settlementRun.name)
      .upsertJobScheduler(
        'settlement-tick',
        { every: 60_000 },
        { name: SETTLEMENT_TICK_JOB, opts: TICK_OPTIONS }
      );
    const recon = this.queues.get(QUEUES.reconciliationRun.name);
    await recon.upsertJobScheduler(
      'reconciliation-gap',
      { every: this.config.RECON_GAP_INTERVAL_SECONDS * 1000 },
      { name: RECONCILIATION_JOBS.gap, opts: TICK_OPTIONS }
    );
    await recon.upsertJobScheduler(
      'reconciliation-integrity',
      { every: 3_600_000 },
      { name: RECONCILIATION_JOBS.integrity, opts: TICK_OPTIONS }
    );
    await recon.upsertJobScheduler(
      'reconciliation-proof',
      { pattern: '0 2 * * *', tz: 'UTC' },
      { name: RECONCILIATION_JOBS.proof, opts: TICK_OPTIONS }
    );
  }

  /**
   * Phase 7 (spec 6.13): the SLA sweep every minute, the blocklist mirror every 5 minutes and
   * the KYC expiry and re-verification sweep every hour. Each tick is idempotent.
   */
  private async registerCompliance(): Promise<void> {
    const aml = this.queues.get(QUEUES.amlScreen.name);
    await aml.upsertJobScheduler(
      'aml-tick',
      { every: 60_000 },
      { name: AML_JOBS.tick, opts: TICK_OPTIONS }
    );
    await aml.upsertJobScheduler(
      'aml-blocklist-rebuild',
      { every: 300_000 },
      { name: AML_JOBS.blocklistRebuild, opts: TICK_OPTIONS }
    );
    await aml.upsertJobScheduler(
      'kyc-lifecycle',
      { every: 3_600_000 },
      { name: AML_JOBS.kycLifecycle, opts: TICK_OPTIONS }
    );
  }

  /**
   * Phase 8: the notification sweep, report schedules and expiry, the dashboard rollups, and the
   * support and operations sweeps. Each tick is idempotent.
   */
  private async registerSupportAndOperations(): Promise<void> {
    const upsert = (
      queue: string,
      id: string,
      every: number | { pattern: string; tz: string },
      name: string
    ) =>
      this.queues.get(queue).upsertJobScheduler(id, typeof every === 'number' ? { every } : every, {
        name,
        opts: TICK_OPTIONS,
      });
    await upsert(
      QUEUES.notificationSend.name,
      'notifications-sweep',
      60_000,
      NOTIFICATION_JOBS.sweep
    );
    await upsert(QUEUES.reportGenerate.name, 'reports-tick', 60_000, REPORT_JOBS.tick);
    await upsert(QUEUES.reportGenerate.name, 'reports-expire', 3_600_000, REPORT_JOBS.expire);
    await upsert(QUEUES.rollupAggregate.name, 'rollups-recent', 900_000, ROLLUP_JOBS.recent);
    await upsert(
      QUEUES.rollupAggregate.name,
      'rollups-nightly',
      { pattern: '30 1 * * *', tz: 'UTC' },
      ROLLUP_JOBS.nightly
    );
    await upsert(QUEUES.supportOps.name, 'complaints-sla', 60_000, SUPPORT_JOBS.complaintSla);
    await upsert(
      QUEUES.supportOps.name,
      'disputes-deadlines',
      300_000,
      SUPPORT_JOBS.disputeDeadlines
    );
    await upsert(QUEUES.supportOps.name, 'approvals-expire', 300_000, SUPPORT_JOBS.approvalsExpire);
    await upsert(
      QUEUES.supportOps.name,
      'ops-monitor',
      this.config.OPS_MONITOR_INTERVAL_SECONDS * 1000,
      SUPPORT_JOBS.monitor
    );
  }

  /**
   * Phase 9 (spec 5.1, 11): partitions are created every 6 hours (and at once when the worker
   * first boots), retention runs daily at 03:15 UTC, off peak because dropping a partition takes
   * a short lock on its parent table.
   */
  private async registerDataLifecycle(): Promise<void> {
    const queue = this.queues.get(QUEUES.dataLifecycle.name);
    await queue.upsertJobScheduler(
      'partitions-ensure',
      { every: 6 * 3_600_000 },
      { name: LIFECYCLE_JOBS.ensurePartitions }
    );
    await queue.upsertJobScheduler(
      'retention-enforce',
      { pattern: '15 3 * * *', tz: 'UTC' },
      { name: LIFECYCLE_JOBS.enforceRetention }
    );
  }
}
