/**
 * The `gateway-chase` queue processor (P3-13, spec 8.9): routes jobs by name because each
 * processor starts a worker on the whole queue. Today handles:
 * - `sandbox.step`: simulated payment outcomes (Phase 5)
 * - (P4-09 will add) `gateway.chase`: query gateway for transaction status
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
    // Route by job name (P3-13): sandbox steps and chase jobs share this queue
    if (job.name === SANDBOX_JOB) {
      return this.sandbox.run(job.data.paymentId, job.data.step);
    }

    // Phase 4 will add: if (job.name === GATEWAY_CHASE_JOB) { ... }

    throw new UnrecoverableError(`unknown gateway-chase job ${job.name}`);
  }
}
