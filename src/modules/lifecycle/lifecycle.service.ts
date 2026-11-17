/**
 * Partition automation and retention (spec 5.1 and 11), run by the worker as scheduled jobs.
 *
 * Invariants:
 *  - Financial records, transactions, journals and audit logs are never deleted. The database
 *    refuses retention on those tables (`partition_policies` CHECK) and `core.drop_partition`
 *    re-validates every drop, so nothing here can widen that.
 *  - Every partition drop is audited in the same transaction as the drop. If the audit row cannot
 *    be written the partition is not dropped.
 *  - Every operation is idempotent: a second run, or two runs at once, has the effect of one.
 *  - Failures are visible: a month that cannot be created, or rows found in a default partition,
 *    fail the job after the rest of the work is done and set the gauges alerts read.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { isLockNotAvailable } from '../../common/db/pg-errors';
import { AuditService } from '../../common/audit/audit.service';
import { toLoggableError } from '../../common/logging/redaction';
import {
  lifecycleRuns,
  metricRefreshers,
  partitionDefaultHasRows,
  partitionMonthsAhead,
  partitionsDropped,
  partitionsRetentionBlocked,
  retentionRowsDeleted,
} from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import {
  PARTITION_MONTHS_AHEAD,
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  idempotencyPurgeCutoff,
  outboxPurgeCutoff,
  uuidTimeBound,
} from './domain/retention-policy';
import { LifecycleRepository, type EnsuredPartition } from './lifecycle.repository';

export interface PartitionRunSummary {
  readonly created: readonly string[];
  readonly problems: readonly EnsuredPartition[];
}

export interface RetentionRunSummary {
  readonly droppedPartitions: readonly string[];
  readonly keptPartitions: readonly { readonly partition: string; readonly reason: string }[];
  readonly idempotencyKeysDeleted: number;
  readonly outboxRowsDeleted: number;
}

const JOB_ACTOR = { type: 'job', id: 'data-lifecycle', label: 'data lifecycle job' } as const;

/** Thrown after a run finished everything it could, so the failure is visible and retried. */
export class PartitionMaintenanceError extends Error {
  constructor(readonly problems: readonly EnsuredPartition[]) {
    super(
      `partition maintenance left ${problems.length} problem(s): ` +
        problems.map((p) => `${p.partitionName}=${p.outcome}`).join(', ')
    );
    this.name = 'PartitionMaintenanceError';
  }
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly repository: LifecycleRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    // The api process reports what the worker's runs found, as for the other gauges.
    metricRefreshers.set('partition_status', () => this.refreshGauges());
  }

  /**
   * Creates the current month and three ahead for every partitioned table. Rows already in a
   * default partition are never moved (they may be append-only): a month they block is reported
   * and the run fails after finishing the others.
   */
  async ensurePartitions(): Promise<PartitionRunSummary> {
    const now = this.clock.now();
    const ensured = await this.repository.ensurePartitions(now, PARTITION_MONTHS_AHEAD);
    const created = ensured.filter((p) => p.outcome === 'created').map((p) => p.partitionName);
    const problems = ensured.filter((p) => p.outcome !== 'created' && p.outcome !== 'exists');
    for (const name of created) this.logger.info({ partition: name }, 'partition created');
    for (const problem of problems) {
      this.logger.error(
        { partition: problem.partitionName, outcome: problem.outcome },
        'partition could not be created'
      );
    }
    await this.refreshGauges();
    lifecycleRuns.inc({
      job: 'partitions',
      outcome: problems.length === 0 ? 'ok' : 'problems',
    });
    if (problems.length > 0) throw new PartitionMaintenanceError(problems);
    return { created, problems };
  }

  /**
   * Drops partitions entirely older than their retention (api request logs and webhook
   * deliveries 90 days, notification deliveries 180 days), then deletes expired idempotency keys
   * and published outbox rows in batches.
   */
  async enforceRetention(): Promise<RetentionRunSummary> {
    const now = this.clock.now();
    const droppedPartitions: string[] = [];
    const keptPartitions: { partition: string; reason: string }[] = [];
    const failures: unknown[] = [];

    for (const due of await this.repository.partitionsDue(now)) {
      if (due.blockedReason) {
        keptPartitions.push({ partition: due.partitionName, reason: due.blockedReason });
        partitionsRetentionBlocked.inc({ table: due.parent, reason: due.blockedReason });
        this.logger.warn(
          { partition: due.partitionName, reason: due.blockedReason },
          'expired partition kept'
        );
        continue;
      }
      try {
        await this.unitOfWork.run(async (tx) => {
          await this.repository.dropPartition(tx, due.parent, due.partitionName, now);
          await this.audit.record(tx, {
            action: 'retention.partition_dropped',
            resourceType: 'partition',
            resourceId: due.partitionName,
            before: {
              table: due.parent,
              upperBound: due.upperBound.toISOString(),
              approxRows: due.approxRows,
            },
            actor: JOB_ACTOR,
          });
        });
        droppedPartitions.push(due.partitionName);
        partitionsDropped.inc({ table: due.parent });
        this.logger.info({ partition: due.partitionName }, 'expired partition dropped');
      } catch (error) {
        if (isLockNotAvailable(error)) {
          // The table is busy: leave it for the next run rather than queueing behind traffic.
          keptPartitions.push({ partition: due.partitionName, reason: 'lock_timeout' });
          this.logger.warn(
            { partition: due.partitionName },
            'partition drop deferred: lock timeout'
          );
          continue;
        }
        failures.push(error);
        this.logger.error(
          { partition: due.partitionName, err: toLoggableError(error) },
          'partition drop failed'
        );
      }
    }

    const idempotencyKeysDeleted = await this.purge('idempotency_keys', (limit) =>
      this.repository.purgeIdempotencyKeys(idempotencyPurgeCutoff(now), limit)
    );
    const outboxCutoff = outboxPurgeCutoff(now);
    const outboxRowsDeleted = await this.purge('outbox', (limit) =>
      this.repository.purgePublishedOutbox(outboxCutoff, uuidTimeBound(outboxCutoff), limit)
    );

    lifecycleRuns.inc({ job: 'retention', outcome: failures.length === 0 ? 'ok' : 'problems' });
    if (failures.length > 0) {
      throw new AggregateError(failures, 'retention run finished with failed partition drops');
    }
    return { droppedPartitions, keptPartitions, idempotencyKeysDeleted, outboxRowsDeleted };
  }

  /** Brings the partition gauges up to date (also run on every metrics scrape). */
  async refreshGauges(): Promise<void> {
    for (const status of await this.repository.partitionStatus(this.clock.now())) {
      partitionMonthsAhead.set({ table: status.parent }, status.monthsAhead);
      partitionDefaultHasRows.set({ table: status.parent }, status.defaultHasRows ? 1 : 0);
    }
  }

  private async purge(
    target: string,
    deleteBatch: (limit: number) => Promise<number>
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const deleted = await deleteBatch(PURGE_BATCH_SIZE);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) break;
    }
    if (total > 0) {
      retentionRowsDeleted.inc({ target }, total);
      this.logger.info({ target, deleted: total }, 'expired rows deleted');
    }
    return total;
  }
}
