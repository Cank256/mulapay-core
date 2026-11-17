/**
 * The `settlement-run` queue (spec 8.9, concurrency 1):
 *
 *   settlement.tick            every minute: run due cycles, then sweep releasing batches
 *   settlement.submit-payout   send one batch's disbursement (queued by the outbox after release)
 *
 * Both are idempotent. A payout submission that the gateway did not take (rate limit, unavailable
 * provider) throws and is retried with the same `externalId`; an ambiguous answer is recorded on
 * the payout and is not retried. A 401 or 403 is not retried in a loop (spec 3.5): the job fails
 * at once as unrecoverable and the sweep re-drives it later. See SettlementReleaseService.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import {
  SettlementGatewayAuthRejected,
  SettlementReleaseService,
} from '../modules/settlement/settlement-release.service';
import { SETTLEMENT_SUBMIT_JOB } from '../modules/settlement/settlement-submit.handler';
import { SettlementTickService } from '../modules/settlement/settlement-tick.service';

export const SETTLEMENT_TICK_JOB = 'settlement.tick';

@Injectable()
export class SettlementRunProcessor implements QueueProcessor {
  readonly definition = QUEUES.settlementRun;

  constructor(
    private readonly tick: SettlementTickService,
    private readonly release: SettlementReleaseService
  ) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case SETTLEMENT_TICK_JOB:
        return this.tick.tick();
      case SETTLEMENT_SUBMIT_JOB:
        return this.submit((job.data as { batchId: string }).batchId);
      default:
        throw new UnrecoverableError(`unknown settlement-run job ${job.name}`);
    }
  }
  private async submit(batchId: string): Promise<unknown> {
    try {
      return await this.release.submitPayout(batchId);
    } catch (error) {
      if (error instanceof SettlementGatewayAuthRejected) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
