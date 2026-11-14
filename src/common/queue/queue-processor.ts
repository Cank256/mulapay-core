import type { Job } from 'bullmq';
import type { QueueDefinition } from './queue.definitions';

export const QUEUE_PROCESSORS = Symbol('QUEUE_PROCESSORS');

/**
 * A job handler for one queue. Implementations must be idempotent: a job can run more
 * than once (retries, stalled-job recovery), and running it twice must produce one effect.
 * Throw to fail an attempt; throw bullmq's UnrecoverableError to skip remaining attempts.
 *
 * Job payloads carry identifiers, not PII or secrets; they are copied to the dead-letter
 * queue verbatim.
 */
export interface QueueProcessor<TData = unknown> {
  readonly definition: QueueDefinition;
  process(job: Job<TData>): Promise<unknown>;
}
