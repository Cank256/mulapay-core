/**
 * Registers the repeating jobs of the worker (spec 8.1, 8.8): BullMQ job schedulers, which
 * are keyed by id, so any number of workers booting at once registers each schedule once.
 */
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '../common/queue/queue.definitions';
import { QueueRegistry } from '../common/queue/queue.registry';
import { TICK_JOBS } from './outbox-dispatch.processor';

const SCHEDULES = [
  { id: 'outbox-tick', every: 1_000, name: TICK_JOBS.outbox },
  { id: 'request-logs-flush', every: 2_000, name: TICK_JOBS.requestLogs },
  { id: 'api-keys-flush-last-used', every: 10_000, name: TICK_JOBS.lastUsed },
] as const;

@Injectable()
export class JobSchedulers implements OnApplicationBootstrap {
  constructor(private readonly queues: QueueRegistry) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QUEUES.outboxDispatch.name);
    for (const schedule of SCHEDULES) {
      await queue.upsertJobScheduler(
        schedule.id,
        { every: schedule.every },
        {
          name: schedule.name,
          // A tick that fails is replaced by the next one; keep little history.
          opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 200 },
        }
      );
    }
  }
}
