/**
 * The outbox dispatcher (spec 8.8). Runs in the worker process.
 *
 * Per row: claim (`FOR UPDATE SKIP LOCKED`, 60 s claim), run the handler's database work in
 * one transaction, publish its queue jobs, mark the row published. Failure at any step
 * releases the claim and retries with exponential backoff (2 s doubling, capped at 5 min);
 * after OUTBOX_MAX_ATTEMPTS the row stays unpublished, is no longer claimed, and
 * `core_outbox_exhausted_total` rises so an operator looks at it.
 *
 * Delivery is at least once and effects are once: a crash after the jobs are published but
 * before the row is marked runs the handler again, and its idempotent writes and
 * deterministic job ids make that harmless.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../clock/clock';
import { UnitOfWork } from '../db/unit-of-work';
import { toLoggableError } from '../logging/redaction';
import { QueueRegistry } from '../queue/queue.registry';
import { outboxExhausted } from '../telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../tokens';
import { OUTBOX_HANDLERS, type OutboxHandler } from './outbox-handler';
import { OUTBOX_MAX_ATTEMPTS, OutboxRepository, type OutboxRow } from './outbox.repository';

const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;
const BASE_BACKOFF_SECONDS = 2;
const MAX_BACKOFF_SECONDS = 300;

export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS);
}

@Injectable()
export class OutboxDispatcher {
  private readonly worker = `dispatcher-${randomUUID().slice(0, 8)}`;
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(
    private readonly repository: OutboxRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    @Inject(OUTBOX_HANDLERS) handlers: readonly OutboxHandler[],
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    for (const handler of handlers) this.handlers.set(handler.eventType, handler);
  }

  /** Publishes due rows until none are left or the per-run cap is reached. Returns the count. */
  async dispatch(): Promise<number> {
    let published = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const rows = await this.repository.claim(this.clock.now(), this.worker, BATCH_SIZE, [
        ...this.handlers.keys(),
      ]);
      if (rows.length === 0) break;
      for (const row of rows) if (await this.publish(row)) published++;
      if (rows.length < BATCH_SIZE) break;
    }
    return published;
  }

  private async publish(row: OutboxRow): Promise<boolean> {
    try {
      const handler = this.handlers.get(row.eventType);
      if (!handler) throw new Error(`no outbox handler for ${row.eventType}`);
      const jobs = await this.unitOfWork.run((tx) => handler.handle(tx, row));
      for (const job of jobs) {
        await this.queues.get(job.queue).add(job.name, job.data, job.options);
      }
      await this.repository.markPublished(row.id, this.clock.now());
      return true;
    } catch (error) {
      const retryAt = new Date(
        this.clock.now().getTime() + outboxBackoffSeconds(row.attempts) * 1000
      );
      const message = error instanceof Error ? error.message : 'unknown error';
      await this.repository.markFailed(row.id, message, retryAt);
      this.logger.warn(
        {
          outboxId: row.id,
          eventType: row.eventType,
          attempts: row.attempts,
          err: toLoggableError(error),
        },
        'outbox row failed'
      );
      if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
        outboxExhausted.inc({ event_type: row.eventType });
        this.logger.error(
          { outboxId: row.id, eventType: row.eventType },
          'outbox row exhausted its attempts'
        );
      }
      return false;
    }
  }
}
