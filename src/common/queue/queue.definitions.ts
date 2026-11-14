/**
 * Queue catalogue (spec section 8.9).
 *
 * Every job is idempotent, retried with exponential backoff, kept for a bounded time
 * after completion, and parked in the dead-letter queue when it exhausts its attempts.
 *
 * The attempt counts and backoff below are platform defaults. Queues with a specified
 * schedule override them in the phase that implements the queue (for example webhook
 * delivery's 0s, 30s, 2m, 10m, 1h, 6h, 24h schedule in Phase 5).
 */
import type { DefaultJobOptions } from 'bullmq';

export interface QueueDefinition {
  readonly name: string;
  readonly concurrency: number;
  readonly jobOptions?: DefaultJobOptions;
}

/** Key prefix keeps core's queues apart from the gateway's if they share a Redis. */
export const QUEUE_PREFIX = 'mulapay-core';

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  // Failed jobs are also copied to the dead-letter queue; this is the bounded local copy.
  removeOnFail: { count: 10000, age: 7 * 24 * 60 * 60 },
};

export const QUEUES = {
  outboxDispatch: { name: 'outbox-dispatch', concurrency: 4 },
  // Per-endpoint ordering is a Phase 5 concern; see docs/ARCHITECTURE.md (BullMQ groups).
  webhookDelivery: { name: 'webhook-delivery', concurrency: 32 },
  notificationSend: { name: 'notification-send', concurrency: 16 },
  reportGenerate: { name: 'report-generate', concurrency: 2 },
  settlementRun: { name: 'settlement-run', concurrency: 1 },
  amlScreen: { name: 'aml-screen', concurrency: 8 },
  statementMatch: { name: 'statement-match', concurrency: 2 },
  rollupAggregate: { name: 'rollup-aggregate', concurrency: 2 },
  gatewayChase: { name: 'gateway-chase', concurrency: 8 },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]['name'];

export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(QUEUES);

/** Parking lot for jobs that exhausted their attempts. No worker consumes it. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export function jobOptionsFor(definition: QueueDefinition): DefaultJobOptions {
  return { ...DEFAULT_JOB_OPTIONS, ...definition.jobOptions };
}
