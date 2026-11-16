/**
 * Registers the repeating jobs of the worker (spec 8.1, 8.8): BullMQ job schedulers, which
 * are keyed by id, so any number of workers booting at once registers each schedule once.
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '../common/queue/queue.definitions';
import { QueueRegistry } from '../common/queue/queue.registry';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/configuration';
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
}
