/**
 * The `gateway-chase` queue (spec 8.9), which today carries only the sandbox simulation.
 * Phase 4's chase job adds its own job names here and routes by `job.name`: one processor
 * per queue, because every processor starts a worker on the whole queue.
 *
 * Retry and failure behaviour: BullMQ retries a failed step 5 times with exponential backoff
 * (the platform default); a step that still fails goes to the dead-letter queue. A step is
 * idempotent (deterministic event keys), so a retry after a partial failure is safe.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../../../common/queue/queue-processor';
import { QUEUES } from '../../../common/queue/queue.definitions';
import type { SandboxStep } from './domain/sandbox-scenario';
import { SANDBOX_JOB, SandboxService } from './sandbox.service';

interface SandboxJobData {
  readonly paymentId: string;
  readonly step: SandboxStep;
}

@Injectable()
export class SandboxProcessor implements QueueProcessor<SandboxJobData> {
  readonly definition = QUEUES.gatewayChase;

  constructor(private readonly sandbox: SandboxService) {}

  async process(job: Job<SandboxJobData>): Promise<string> {
    if (job.name !== SANDBOX_JOB) {
      throw new UnrecoverableError(`unknown gateway-chase job ${job.name}`);
    }
    return this.sandbox.run(job.data.paymentId, job.data.step);
  }
}
