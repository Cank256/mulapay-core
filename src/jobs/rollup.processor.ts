/**
 * The `rollup-aggregate` queue (spec 8.9, concurrency 2): the dashboard rollups.
 *
 *   rollups.recent    every 15 minutes: recompute today (and yesterday in the first hour of a day)
 *   rollups.nightly   01:30 UTC: recompute the previous seven days, for late completions
 *
 * Recomputing a day replaces its rows, so a repeated or overlapping run leaves the same numbers.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { RollupsService } from '../modules/rollups/rollups.service';

export const ROLLUP_JOBS = { recent: 'rollups.recent', nightly: 'rollups.nightly' } as const;

@Injectable()
export class RollupProcessor implements QueueProcessor {
  readonly definition = QUEUES.rollupAggregate;

  constructor(private readonly rollups: RollupsService) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case ROLLUP_JOBS.recent:
        return this.rollups.recomputeRecent();
      case ROLLUP_JOBS.nightly:
        return this.rollups.recomputePrevious(7);
      default:
        throw new UnrecoverableError(`unknown rollup-aggregate job ${job.name}`);
    }
  }
}
