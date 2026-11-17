/**
 * The `data-lifecycle` queue (one at a time): partition automation and retention (spec 5.1, 11).
 *
 *   partitions.ensure   every 6 hours: create the current month and three ahead for every
 *                       partitioned table. Idempotent, so it also runs once at boot.
 *   retention.enforce   daily at 03:15 UTC: drop partitions entirely past their retention, delete
 *                       expired idempotency keys and published outbox rows.
 *
 * Both are idempotent and safe to run concurrently: partition creation is `IF NOT EXISTS`, a drop
 * re-validates under the table lock, and the purges skip rows another session holds. A failed run
 * is retried with backoff and leaves the partition gauges that alerts read.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { LifecycleService } from '../modules/lifecycle/lifecycle.service';

export const LIFECYCLE_JOBS = {
  ensurePartitions: 'partitions.ensure',
  enforceRetention: 'retention.enforce',
} as const;

@Injectable()
export class DataLifecycleProcessor implements QueueProcessor {
  readonly definition = QUEUES.dataLifecycle;

  constructor(private readonly lifecycle: LifecycleService) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case LIFECYCLE_JOBS.ensurePartitions:
        return this.lifecycle.ensurePartitions();
      case LIFECYCLE_JOBS.enforceRetention:
        return this.lifecycle.enforceRetention();
      default:
        throw new UnrecoverableError(`unknown data-lifecycle job ${job.name}`);
    }
  }
}
