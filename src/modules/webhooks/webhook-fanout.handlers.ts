/**
 * Outbox handlers that create webhook deliveries and queue their first attempt (spec 6.11,
 * 8.8). Both run in the outbox dispatcher, so neither is called from a request.
 *
 * `merchant_event.created` fans an event out to every active endpoint of the merchant and
 * environment that subscribes to its type, one delivery each. The delivery is created at the
 * event's own time with a dedupe key naming the endpoint and event, so running the handler
 * again for the same row (a crash after commit) adds nothing and returns the same jobs.
 *
 * `webhook.delivery_created` queues the first attempt of a delivery that already exists, as
 * created by a replay.
 */
import { Injectable, Inject } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { publicId, uuidv7 } from '../../common/ids/ids';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { CLOCK } from '../../common/tokens';
import { subscribes } from '../events/domain/event-types';
import { MerchantEventsRepository } from '../events/merchant-events.repository';
import { MERCHANT_EVENT_OUTBOX_TYPE } from '../events/merchant-events.service';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { DELIVERY_CREATED_OUTBOX_TYPE } from './webhook-deliveries.service';
import { DELIVERY_JOB, deliveryJobId } from './webhook-delivery.service';
import { WebhookEndpointsRepository } from './webhook-endpoints.repository';

function firstAttempt(ref: string): OutboxJob {
  return {
    queue: QUEUES.webhookDelivery.name,
    name: DELIVERY_JOB,
    data: { deliveryRef: ref },
    options: { jobId: deliveryJobId(ref, 1) },
  };
}

@Injectable()
export class MerchantEventFanoutHandler implements OutboxHandler {
  readonly eventType = MERCHANT_EVENT_OUTBOX_TYPE;

  constructor(
    private readonly events: MerchantEventsRepository,
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async handle(tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { eventId } = row.payload as { eventId: string };
    const event = await this.events.findById(eventId, tx);
    if (!event) throw new Error(`merchant event ${eventId} not found`);
    const jobs: OutboxJob[] = [];
    const targets = await this.endpoints.listActive(tx, event.merchantId, event.environment);
    for (const endpoint of targets) {
      if (!subscribes(endpoint.enabledEvents, event.type)) continue;
      const dedupeKey = `${endpoint.id}:${event.id}:original`;
      const now = this.clock.now();
      const ref = publicId('webhookDelivery', event.createdAt);
      await this.deliveries.insert(tx, {
        id: uuidv7(event.createdAt),
        ref,
        endpointId: endpoint.id,
        merchantId: event.merchantId,
        environment: event.environment,
        eventId: event.id,
        eventType: event.type,
        dedupeKey,
        nextAttemptAt: now,
        createdAt: event.createdAt,
      });
      const delivery = await this.deliveries.findByDedupeKey(tx, dedupeKey, event.createdAt);
      if (delivery && delivery.status === 'pending' && delivery.attempt === 0) {
        jobs.push(firstAttempt(delivery.ref));
      }
    }
    return jobs;
  }
}

@Injectable()
export class DeliveryCreatedHandler implements OutboxHandler {
  readonly eventType = DELIVERY_CREATED_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { deliveryRef } = row.payload as { deliveryRef: string };
    return [firstAttempt(deliveryRef)];
  }
}
