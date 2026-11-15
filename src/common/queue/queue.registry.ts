/**
 * Queue handles for inspection (metrics, operations tooling) and for the dead-letter
 * producer. Creating a Queue does not consume jobs; workers run only in the worker process
 * (spec section 9.2 rule 14).
 *
 * Nothing enqueues business work from a request handler: jobs come from the outbox
 * dispatcher (spec section 8.8, Phase 4).
 */
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SERVICE_NAME, type AppConfig } from '../../config/configuration';
import { toLoggableError } from '../logging/redaction';
import { closeRedisClient, createRedisClient } from '../redis/redis.factory';
import { APP_CONFIG, ROOT_LOGGER } from '../tokens';
import {
  DEAD_LETTER_QUEUE,
  QUEUE_DEFINITIONS,
  jobOptionsFor,
  type QueueDefinition,
} from './queue.definitions';

export interface QueueSnapshot {
  readonly queue: string;
  readonly depth: number;
  readonly oldestJobAgeSeconds: number;
}

@Injectable()
export class QueueRegistry implements OnApplicationShutdown {
  private readonly definitions = new Map<string, QueueDefinition>();
  private readonly queues = new Map<string, Queue>();
  private connection: Redis | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    for (const definition of QUEUE_DEFINITIONS) this.definitions.set(definition.name, definition);
    this.definitions.set(DEAD_LETTER_QUEUE, {
      name: DEAD_LETTER_QUEUE,
      concurrency: 0,
      jobOptions: { attempts: 1 },
    });
  }

  /** Queues and their shared connection are created on first use, not at construction. */
  private create(definition: QueueDefinition): Queue {
    this.connection ??= createRedisClient(this.config, 'queue-producer', this.logger);
    const queue = new Queue(definition.name, {
      connection: this.connection,
      prefix: this.config.QUEUE_PREFIX,
      defaultJobOptions: jobOptionsFor(definition),
      telemetry: new BullMQOtel(SERVICE_NAME),
    });
    queue.on('error', (error) => {
      this.logger.warn({ queue: definition.name, err: toLoggableError(error) }, 'queue error');
    });
    this.queues.set(definition.name, queue);
    return queue;
  }

  get(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`unknown queue: ${name}`);
    return this.create(definition);
  }

  names(): string[] {
    return [...this.definitions.keys()];
  }

  /** Depth (waiting + prioritized + delayed) and oldest waiting job age, per queue. */
  async snapshot(now: Date): Promise<QueueSnapshot[]> {
    return Promise.all(
      this.names().map(async (name) => {
        const queue = this.get(name);
        const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed');
        const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
        const depth = (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0);
        const age = oldest ? Math.max(0, (now.getTime() - oldest.timestamp) / 1000) : 0;
        return { queue: name, depth, oldestJobAgeSeconds: age };
      })
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.connection) await closeRedisClient(this.connection);
  }
}
