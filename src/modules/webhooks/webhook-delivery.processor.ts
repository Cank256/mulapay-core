/**
 * The `webhook-delivery` queue (spec 8.9): one job per delivery attempt, plus the recovery
 * sweep that re-queues attempts whose job was lost (Redis restarted, a queue call failed).
 *
 * Retry and failure behaviour: the delivery service owns the retry schedule (0 s to 24 h,
 * 7 attempts) and records every outcome in Postgres, so an unsuccessful HTTP exchange is a
 * normal result and never throws. BullMQ's own retries (3, exponential) cover only
 * infrastructure failures such as the database being unreachable; a job that exhausts
 * them goes to the dead-letter queue, and the recovery sweep still finds its delivery
 * pending and queues it again.
 *
 * Idempotency: attempting a delivery twice sends once (lease and conditional update), so
 * a duplicate or recovered job is harmless.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Clock } from '../../common/clock/clock';
import type { QueueProcessor } from '../../common/queue/queue-processor';
import { QUEUES } from '../../common/queue/queue.definitions';
import { QueueRegistry } from '../../common/queue/queue.registry';
import { CLOCK } from '../../common/tokens';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { DELIVERY_JOB, WebhookDeliveryService, deliveryJobId } from './webhook-delivery.service';

@Injectable()
export class WebhookDeliveryProcessor implements QueueProcessor<{ deliveryRef: string }> {
  readonly definition = QUEUES.webhookDelivery;

  constructor(private readonly service: WebhookDeliveryService) {}

  async process(job: Job<{ deliveryRef: string }>): Promise<string> {
    return this.service.attempt(job.data.deliveryRef);
  }
}

@Injectable()
export class WebhookDeliveryRecovery {
  constructor(
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly queues: QueueRegistry,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Queues an attempt for every delivery that is pending and overdue by more than a minute.
   * The job id carries the current minute, so a recovery job is never swallowed by an
   * earlier job with the same attempt number that already finished.
   */
  async recover(limit = 200): Promise<number> {
    const now = this.clock.now();
    const overdue = await this.deliveries.listOverdue(now, limit);
    const minute = Math.floor(now.getTime() / 60_000);
    const queue = this.queues.get(QUEUES.webhookDelivery.name);
    for (const delivery of overdue) {
      await queue.add(
        DELIVERY_JOB,
        { deliveryRef: delivery.ref },
        { jobId: `${deliveryJobId(delivery.ref, delivery.attempt + 1)}_r${minute}` }
      );
    }
    return overdue.length;
  }
}
