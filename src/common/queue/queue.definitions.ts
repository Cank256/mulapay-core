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
  // Retries of an unsuccessful delivery are scheduled by the delivery service (spec 6.11:
  // 0 s to 24 h, 7 attempts); the BullMQ attempts here cover infrastructure failures only.
  // Per-endpoint ordering needs BullMQ Pro groups: see docs/ARCHITECTURE.md (Phase 5).
  webhookDelivery: {
    name: 'webhook-delivery',
    concurrency: 32,
    jobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  },
  // Notification retries are spaced by BullMQ from NOTIFICATION_RETRY_BASE_SECONDS and counted
  // on the delivery row; the attempts and backoff are set when the job is published, from
  // configuration (src/modules/notifications/notification.handlers.ts).
  notificationSend: {
    name: 'notification-send',
    concurrency: 16,
    jobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 30_000 } },
  },
  // A report that fails is retried twice more, 30 s apart, then marked failed.
  reportGenerate: {
    name: 'report-generate',
    concurrency: 2,
    jobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  },
  settlementRun: {
    name: 'settlement-run',
    concurrency: 1,
    // A payout submission retries with the same externalId, so retrying cannot pay twice.
    jobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 5000 } },
  },
  // Phase 7: screening, monitoring and the compliance sweeps. A screening provider outage can
  // last minutes, so a job retries 8 times from 10 s (about 21 minutes in all); every job is
  // keyed by what it works on, so a retry or a duplicate has no second effect.
  amlScreen: {
    name: 'aml-screen',
    concurrency: 8,
    jobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 10_000 } },
  },
  statementMatch: { name: 'statement-match', concurrency: 2 },
  rollupAggregate: { name: 'rollup-aggregate', concurrency: 2 },
  gatewayChase: { name: 'gateway-chase', concurrency: 8 },
  // Phase 6: the scheduled reconciliation runs (spec 6.8). Spec 8.9 lists no queue for them;
  // one run of a kind and scope at a time is enforced in the database, not by concurrency.
  reconciliationRun: {
    name: 'reconciliation-run',
    concurrency: 2,
    jobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  },
  // Phase 8: the minute sweeps that are not tied to a queue of spec 8.9 (complaint SLAs, dispute
  // deadlines, approval expiry, the automatic incident monitors). One at a time; each sweep
  // re-checks every row under its lock, so a late or repeated tick is harmless.
  supportOps: {
    name: 'support-ops',
    concurrency: 1,
    jobOptions: { attempts: 1 },
  },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]['name'];

export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(QUEUES);

/** Parking lot for jobs that exhausted their attempts. No worker consumes it. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export function jobOptionsFor(definition: QueueDefinition): DefaultJobOptions {
  return { ...DEFAULT_JOB_OPTIONS, ...definition.jobOptions };
}
