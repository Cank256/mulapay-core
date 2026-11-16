import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { MessagingModule } from '../../integrations/messaging/messaging.module';
import { EventsModule } from '../events/events.module';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDeliverHandler, NotificationEventHandler } from './notification.handlers';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/** Notifications (spec 6.12): templates, preferences, in-app inbox, channel delivery with retry. */
@Module({
  imports: [EventsModule, MessagingModule, OutboxModule],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationDeliveryService,
    NotificationDeliverHandler,
    NotificationEventHandler,
  ],
  exports: [
    NotificationsRepository,
    NotificationsService,
    NotificationDeliveryService,
    NotificationDeliverHandler,
    NotificationEventHandler,
  ],
})
export class NotificationsModule {}
