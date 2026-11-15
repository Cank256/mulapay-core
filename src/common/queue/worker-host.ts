/**
 * Runs BullMQ workers for the registered processors. Used only by the worker process.
 *
 * Failure behaviour: BullMQ retries a failed attempt per the queue's job options. When the
 * final attempt fails (or the processor throws UnrecoverableError) the job is copied to
 * the dead-letter queue under a deterministic job id, so a repeated failure event cannot
 * create two dead-letter entries. The original also stays in BullMQ's failed set for the
 * bounded `removeOnFail` window.
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SERVICE_NAME, type AppConfig } from '../../config/configuration';
import type { Clock } from '../clock/clock';
import { toLoggableError } from '../logging/redaction';
import { closeRedisClient, createRedisClient } from '../redis/redis.factory';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../tokens';
import { QUEUE_PROCESSORS, type QueueProcessor } from './queue-processor';
import { DEAD_LETTER_QUEUE } from './queue.definitions';
import { QueueRegistry } from './queue.registry';

export interface DeadLetterRecord {
  readonly queue: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly failedAt: string;
}

export function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts'>, error: Error): boolean {
  return error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

export function deadLetterJobId(queue: string, jobId: string): string {
  // BullMQ rejects custom ids containing ':'
  return `${queue}.${jobId}`.replaceAll(':', '_');
}

@Injectable()
export class WorkerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: Array<{ worker: Worker; connection: Redis }> = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUEUE_PROCESSORS) private readonly processors: readonly QueueProcessor[],
    private readonly queues: QueueRegistry
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const processor of this.processors) this.start(processor);
    // A worker closed before its connections are ready rejects internal promises nobody
    // awaits, so wait until each one is running.
    await Promise.all(this.workers.map(({ worker }) => worker.waitUntilReady()));
    this.logger.info(
      { queues: this.processors.map((p) => p.definition.name) },
      this.processors.length > 0 ? 'workers started' : 'no queue processors registered'
    );
  }

  private start(processor: QueueProcessor): void {
    const { definition } = processor;
    const connection = createRedisClient(this.config, 'queue-worker', this.logger);
    const worker = new Worker(definition.name, (job) => processor.process(job), {
      connection,
      prefix: this.config.QUEUE_PREFIX,
      concurrency: definition.concurrency,
      telemetry: new BullMQOtel(SERVICE_NAME),
    });
    worker.on('failed', (job, error) => {
      if (job) void this.onFailed(definition.name, job, error);
    });
    worker.on('error', (error) => {
      this.logger.error({ queue: definition.name, err: toLoggableError(error) }, 'worker error');
    });
    this.workers.push({ worker, connection });
  }

  private async onFailed(queue: string, job: Job, error: Error): Promise<void> {
    const final = isFinalFailure(job, error);
    const fields = { queue, jobId: job.id, attemptsMade: job.attemptsMade, final };
    this.logger.warn({ ...fields, err: toLoggableError(error) }, 'job attempt failed');
    if (!final || job.id === undefined) return;

    const record: DeadLetterRecord = {
      queue,
      jobId: job.id,
      jobName: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      failedReason: error.message,
      failedAt: this.clock.now().toISOString(),
    };
    try {
      await this.queues.get(DEAD_LETTER_QUEUE).add(queue, record, {
        jobId: deadLetterJobId(queue, job.id),
        removeOnComplete: false,
        removeOnFail: false,
      });
      this.logger.error(fields, 'job moved to dead-letter queue');
    } catch (dlqError) {
      // The job is still in BullMQ's failed set, so it is not lost.
      this.logger.error(
        { ...fields, err: toLoggableError(dlqError) },
        'failed to write dead-letter record'
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // close() waits for active jobs to finish before resolving.
    await Promise.all(this.workers.map(({ worker }) => worker.close()));
    await Promise.all(this.workers.map(({ connection }) => closeRedisClient(connection)));
    this.workers.length = 0;
  }
}
