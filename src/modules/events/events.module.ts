import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { MerchantEventsRepository } from './merchant-events.repository';
import { MerchantEventsService } from './merchant-events.service';

/** Merchant events: the merchant-visible log, written through the outbox (spec 6.11). */
@Module({
  imports: [OutboxModule],
  providers: [MerchantEventsRepository, MerchantEventsService],
  exports: [MerchantEventsRepository, MerchantEventsService],
})
export class EventsModule {}
