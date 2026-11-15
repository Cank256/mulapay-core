import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import { EventsModule } from '../events/events.module';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDeliveryProcessor, WebhookDeliveryRecovery } from './webhook-delivery.processor';
import { WebhookEndpointsRepository } from './webhook-endpoints.repository';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { DeliveryCreatedHandler, MerchantEventFanoutHandler } from './webhook-fanout.handlers';
import { UndiciWebhookTransport, WEBHOOK_TRANSPORT } from './webhook-transport';

/** Merchant webhooks: endpoints, signed delivery with retries, the delivery log and replay (spec 6.11). */
@Module({
  imports: [EventsModule, OutboxModule],
  providers: [
    WebhookEndpointsRepository,
    WebhookDeliveriesRepository,
    WebhookEndpointsService,
    WebhookDeliveriesService,
    WebhookDeliveryService,
    WebhookDeliveryProcessor,
    WebhookDeliveryRecovery,
    MerchantEventFanoutHandler,
    DeliveryCreatedHandler,
    {
      provide: WEBHOOK_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new UndiciWebhookTransport(config.WEBHOOK_ALLOW_PRIVATE_NETWORKS),
    },
  ],
  exports: [
    WebhookEndpointsService,
    WebhookDeliveriesService,
    WebhookDeliveryService,
    WebhookDeliveryProcessor,
    WebhookDeliveryRecovery,
    MerchantEventFanoutHandler,
    DeliveryCreatedHandler,
  ],
})
export class WebhooksModule {}
