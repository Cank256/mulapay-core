import type { JobsOptions } from 'bullmq';
import type { Transaction } from '../db/database.types';
import type { QueueName } from '../queue/queue.definitions';
import type { OutboxRow } from './outbox.repository';

export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');

/** A queue job a handler wants published once its database work has committed. */
export interface OutboxJob {
  readonly queue: QueueName;
  readonly name: string;
  /** Identifiers only (spec 8.9). */
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
  /** Set `jobId` so publishing the same job twice is one job. */
  readonly options?: JobsOptions;
}

/**
 * Turns one outbox row into database changes and queue jobs. The dispatcher runs `handle`
 * in a transaction, publishes the returned jobs after it commits, and then marks the row
 * published. A crash in between runs the handler again for the same row, so `handle` must
 * be idempotent and every job must carry a deterministic `jobId`.
 */
export interface OutboxHandler {
  readonly eventType: string;
  handle(tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]>;
}
