import { Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository';
import { OutboxService } from './outbox.service';

/**
 * The write side of the transactional outbox (spec 8.8), for every process that changes
 * state. The dispatcher (`OutboxDispatcher`) needs handlers and queues and is provided by
 * the worker's JobsModule only.
 */
@Module({
  providers: [OutboxRepository, OutboxService],
  exports: [OutboxRepository, OutboxService],
})
export class OutboxModule {}
