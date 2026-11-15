/**
 * The `outbox-dispatch` queue (spec 8.8, 8.9): the platform's short, frequent jobs. Job
 * names select the work; `JobSchedulers` queues each on its own interval.
 *
 *   outbox.tick               publish due outbox rows, then re-queue overdue webhook attempts
 *   request-logs.flush        store buffered API request logs (every 2 s, batches of 500)
 *   api-keys.flush-last-used  write `last_used_at` for keys used since the last flush
 *
 * Every tick is idempotent and safe to overlap with itself: the dispatcher claims rows
 * with `FOR UPDATE SKIP LOCKED`, the log flush claims whole batches atomically, and the
 * usage flush pops entries once. A failed tick is not retried: the next one is due within
 * seconds, and BullMQ keeps the failure for inspection.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ApiKeyUsageTracker } from '../common/auth/api-key-usage.tracker';
import { OutboxDispatcher } from '../common/outbox/outbox-dispatcher';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { RequestLogService } from '../modules/developer/request-logs/request-log.service';
import { WebhookDeliveryRecovery } from '../modules/webhooks/webhook-delivery.processor';

export const TICK_JOBS = {
  outbox: 'outbox.tick',
  requestLogs: 'request-logs.flush',
  lastUsed: 'api-keys.flush-last-used',
} as const;

@Injectable()
export class OutboxDispatchProcessor implements QueueProcessor {
  readonly definition = QUEUES.outboxDispatch;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly recovery: WebhookDeliveryRecovery,
    private readonly requestLogs: RequestLogService,
    private readonly usage: ApiKeyUsageTracker
  ) {}

  async process(job: Job): Promise<number> {
    switch (job.name) {
      case TICK_JOBS.outbox: {
        const published = await this.dispatcher.dispatch();
        await this.recovery.recover();
        return published;
      }
      case TICK_JOBS.requestLogs:
        return this.requestLogs.flush();
      case TICK_JOBS.lastUsed:
        return this.usage.flush();
      default:
        throw new UnrecoverableError(`unknown outbox-dispatch job ${job.name}`);
    }
  }
}
