/**
 * Outbox handlers of the notification service (spec 8.8).
 *
 *   notification.deliver         queues the first send of a delivery (one job per delivery)
 *   notification.merchant_event  turns a live merchant event into notifications for the
 *                                merchant's people (spec 6.12), through the event's template
 *
 * Both are idempotent: the job id is the delivery's, and a notification made from an event
 * carries a source key, so handling the same outbox row twice adds nothing.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from '../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { NOTIFICATION_EVENT_OUTBOX_TYPE } from '../events/domain/notifiable-events';
import { MerchantEventsRepository } from '../events/merchant-events.repository';
import { EVENT_TRIGGERS } from './domain/event-triggers';
import { NOTIFICATION_DELIVER_OUTBOX_TYPE, NotificationsService } from './notifications.service';

export const NOTIFICATION_DELIVER_JOB = 'notification.deliver';

export function deliveryJobId(deliveryId: string, attempts: number): string {
  return `ntfd.${deliveryId}.${attempts}`;
}

@Injectable()
export class NotificationDeliverHandler implements OutboxHandler {
  readonly eventType = NOTIFICATION_DELIVER_OUTBOX_TYPE;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { deliveryId, deliveryCreatedAt } = row.payload as {
      deliveryId: string;
      deliveryCreatedAt: string;
    };
    return [
      {
        queue: QUEUES.notificationSend.name,
        name: NOTIFICATION_DELIVER_JOB,
        data: { deliveryId, deliveryCreatedAt },
        options: {
          jobId: deliveryJobId(deliveryId, 0),
          // BullMQ spaces the retries (30 s, 60 s, 120 s, ...); the delivery row counts them
          // and stops at the same number.
          attempts: this.config.NOTIFICATION_MAX_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: this.config.NOTIFICATION_RETRY_BASE_SECONDS * 1000,
          },
        },
      },
    ];
  }
}

@Injectable()
export class NotificationEventHandler implements OutboxHandler {
  readonly eventType = NOTIFICATION_EVENT_OUTBOX_TYPE;

  constructor(
    private readonly events: MerchantEventsRepository,
    private readonly notifications: NotificationsService
  ) {}

  async handle(tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { eventId } = row.payload as { eventId: string };
    const event = await this.events.findById(eventId, tx);
    if (!event) throw new Error(`merchant event ${eventId} not found`);
    const trigger = EVENT_TRIGGERS[event.type];
    if (!trigger) return [];
    const object = (event.payload as { object?: Record<string, unknown> }).object ?? {};
    await this.notifications.notify(tx, {
      templateCode: trigger.template,
      audience: { kind: 'merchant', merchantId: event.merchantId, permission: trigger.permission },
      resourceKey: event.resourceId,
      sourceKey: `event:${event.id}`,
      variables: trigger.variables({ type: event.type, resourceId: event.resourceId, object }),
      data: { event: event.ref },
    });
    return [];
  }
}
