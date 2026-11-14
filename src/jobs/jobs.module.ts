/**
 * BullMQ processors run by the worker process. Each phase registers its processors here
 * (outbox dispatch in Phase 4, webhook delivery in Phase 5, ...). Phase 0 has none.
 */
import { Module } from '@nestjs/common';
import { QUEUE_PROCESSORS, type QueueProcessor } from '../common/queue/queue-processor';

const processors: readonly QueueProcessor[] = [];

@Module({
  providers: [{ provide: QUEUE_PROCESSORS, useValue: processors }],
  exports: [QUEUE_PROCESSORS],
})
export class JobsModule {}
