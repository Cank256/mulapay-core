/**
 * The `notification-send` queue (spec 8.9, concurrency 16): one job per delivery, plus a
 * recovery sweep.
 *
 *   notification.deliver   one attempt to send one delivery; a transient vendor failure throws,
 *                          so BullMQ retries it with backoff, and the delivery row counts
 *                          the attempts and fails at `NOTIFICATION_MAX_ATTEMPTS`
 *   notifications.sweep    every minute: re-queue deliveries still pending after their time
 *                          (a lost job, a worker that died mid-attempt)
 *
 * Idempotent: a delivery that is final or locked by another worker is skipped.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { QueueRegistry } from '../common/queue/queue.registry';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/configuration';
import { NotificationDeliveryService } from '../modules/notifications/notification-delivery.service';
import {
  NOTIFICATION_DELIVER_JOB,
  deliveryJobId,
} from '../modules/notifications/notification.handlers';

export const NOTIFICATION_JOBS = { sweep: 'notifications.sweep' } as const;

@Injectable()
export class NotificationSendProcessor implements QueueProcessor {
  readonly definition = QUEUES.notificationSend;

  constructor(
    private readonly delivery: NotificationDeliveryService,
    private readonly queues: QueueRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case NOTIFICATION_DELIVER_JOB: {
        const data = job.data as { deliveryId: string; deliveryCreatedAt: string };
        const outcome = await this.delivery.deliver(
          data.deliveryId,
          new Date(data.deliveryCreatedAt)
        );
        if (outcome === 'retry') throw new Error('notification delivery will be retried');
        return outcome;
      }
      case NOTIFICATION_JOBS.sweep:
        return this.sweep();
      default:
        throw new UnrecoverableError(`unknown notification-send job ${job.name}`);
    }
  }

  private async sweep(): Promise<number> {
    const stale = await this.delivery.stale();
    const queue = this.queues.get(QUEUES.notificationSend.name);
    for (const d of stale) {
      await queue.add(
        NOTIFICATION_DELIVER_JOB,
        { deliveryId: d.id, deliveryCreatedAt: d.createdAt.toISOString() },
        {
          // One job per delivery and attempt count: a repeated sweep adds nothing.
          jobId: deliveryJobId(d.id, d.attempts),
          attempts: this.config.NOTIFICATION_MAX_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: this.config.NOTIFICATION_RETRY_BASE_SECONDS * 1000,
          },
        }
      );
    }
    return stale.length;
  }
}
