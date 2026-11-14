/**
 * Queue infrastructure against real Redis: retries with backoff, the dead-letter path,
 * idempotent dead-lettering, depth snapshots and graceful shutdown.
 */
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, type Job } from 'bullmq';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QueueProcessor } from '../../src/common/queue/queue-processor';
import {
  DEAD_LETTER_QUEUE,
  QUEUE_PREFIX,
  QUEUES,
  type QueueDefinition,
} from '../../src/common/queue/queue.definitions';
import { QueueRegistry } from '../../src/common/queue/queue.registry';
import {
  WorkerHost,
  deadLetterJobId,
  type DeadLetterRecord,
} from '../../src/common/queue/worker-host';
import { FixedClock } from '../support/fixed-clock';
import { testConfig } from '../support/test-env';

const logger = pino({ level: 'silent' });

function definition(attempts: number): QueueDefinition {
  return {
    name: `test-${randomUUID()}`,
    concurrency: 2,
    jobOptions: { attempts, backoff: { type: 'fixed', delay: 20 } },
  };
}

function processor(def: QueueDefinition, handler: (job: Job) => Promise<unknown>): QueueProcessor {
  return { definition: def, process: handler };
}

describe('worker host', () => {
  const clock = new FixedClock('2025-06-01T12:00:00.000Z');
  let registry: QueueRegistry;
  const hosts: WorkerHost[] = [];
  const producers: Queue[] = [];

  beforeAll(() => {
    registry = new QueueRegistry(testConfig(), logger);
  });

  afterAll(async () => {
    await Promise.all(hosts.map((h) => h.onApplicationShutdown()));
    await Promise.all(producers.map((q) => q.obliterate({ force: true }).then(() => q.close())));
    await registry.onApplicationShutdown();
  });

  async function start(processors: QueueProcessor[]) {
    const host = new WorkerHost(testConfig(), logger, clock, processors, registry);
    host.onApplicationBootstrap();
    hosts.push(host);
    return host;
  }

  function producer(def: QueueDefinition): Queue {
    const queue = new Queue(def.name, {
      connection: { url: testConfig().REDIS_URL },
      prefix: QUEUE_PREFIX,
      defaultJobOptions: def.jobOptions,
    });
    producers.push(queue);
    return queue;
  }

  async function deadLetter(queue: string, jobId: string): Promise<DeadLetterRecord | undefined> {
    const job = await registry.get(DEAD_LETTER_QUEUE).getJob(deadLetterJobId(queue, jobId));
    return job?.data as DeadLetterRecord | undefined;
  }

  it('retries a failing job and completes it without dead-lettering', async () => {
    const def = definition(3);
    const handler = vi
      .fn<(job: Job) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce('done');
    await start([processor(def, handler)]);
    const job = await producer(def).add('work', { ref: 'abc' });

    await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), {
      timeout: 10_000,
    });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(await deadLetter(def.name, String(job.id))).toBeUndefined();
  });

  it('moves a job to the dead-letter queue after its final attempt', async () => {
    const def = definition(2);
    const handler = vi.fn(async () => {
      throw new Error('permanent failure');
    });
    await start([processor(def, handler)]);
    const job = await producer(def).add('work', { ref: 'xyz' });

    await vi.waitFor(async () => expect(await deadLetter(def.name, String(job.id))).toBeDefined(), {
      timeout: 10_000,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await deadLetter(def.name, String(job.id))).toEqual({
      queue: def.name,
      jobId: String(job.id),
      jobName: 'work',
      data: { ref: 'xyz' },
      attemptsMade: 2,
      failedReason: 'permanent failure',
      failedAt: '2025-06-01T12:00:00.000Z',
    });
    expect(await job.getState()).toBe('failed');
  });

  it('dead-letters immediately on UnrecoverableError', async () => {
    const def = definition(5);
    const handler = vi.fn(async () => {
      throw new UnrecoverableError('bad payload');
    });
    await start([processor(def, handler)]);
    const job = await producer(def).add('work', {});
    await vi.waitFor(async () => expect(await deadLetter(def.name, String(job.id))).toBeDefined(), {
      timeout: 10_000,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps one dead-letter entry when the same failure is reported twice', async () => {
    const dlq = registry.get(DEAD_LETTER_QUEUE);
    const id = deadLetterJobId(`dup-${randomUUID()}`, '1');
    await dlq.add('dup', { n: 1 }, { jobId: id });
    await dlq.add('dup', { n: 2 }, { jobId: id });
    const job = await dlq.getJob(id);
    expect(job?.data).toEqual({ n: 1 });
  });

  it('waits for an active job before shutting down', async () => {
    const def = definition(1);
    let finished = false;
    const host = await start([
      processor(def, async () => {
        await new Promise((r) => setTimeout(r, 300));
        finished = true;
      }),
    ]);
    const job = await producer(def).add('slow', {});
    await vi.waitFor(async () => expect(await job.getState()).toBe('active'), { timeout: 5000 });
    await host.onApplicationShutdown();
    expect(finished).toBe(true);
  });
});

describe('queue registry', () => {
  it('reports depth and oldest job age for every catalogue queue', async () => {
    const registry = new QueueRegistry(testConfig(), logger);
    const queue = registry.get(QUEUES.reportGenerate.name);
    try {
      await queue.obliterate({ force: true });
      await queue.add('a', {});
      await queue.add('b', {});
      const later = new Date(Date.now() + 60_000);
      const snapshot = await registry.snapshot(later);
      const entry = snapshot.find((s) => s.queue === QUEUES.reportGenerate.name);
      expect(entry?.depth).toBe(2);
      expect(entry?.oldestJobAgeSeconds).toBeGreaterThanOrEqual(59);
      expect(snapshot.map((s) => s.queue)).toEqual(expect.arrayContaining(registry.names()));
      expect(() => registry.get('no-such-queue')).toThrow('unknown queue');
    } finally {
      await queue.obliterate({ force: true });
      await registry.onApplicationShutdown();
    }
  });
});
