/**
 * Renders the Prometheus exposition. Gauges that describe shared state (pool usage,
 * queue depth) are refreshed on scrape rather than on a timer.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../clock/clock';
import { poolStats, type DatabasePools } from '../db/pools';
import { DB_POOLS } from '../db/tokens';
import { toLoggableError } from '../logging/redaction';
import { QueueRegistry } from '../queue/queue.registry';
import { CLOCK, ROOT_LOGGER } from '../tokens';
import { dbPoolConnections, metricsRegistry, queueDepth, queueOldestJobSeconds } from './metrics';

/** A slow or unavailable Redis must not stall the scrape. */
const QUEUE_SNAPSHOT_TIMEOUT_MS = 2000;

@Injectable()
export class MetricsService {
  constructor(
    @Inject(DB_POOLS) private readonly pools: DatabasePools,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly queues: QueueRegistry
  ) {}

  get contentType(): string {
    return metricsRegistry.contentType;
  }

  async render(): Promise<string> {
    this.collectPoolStats();
    await this.collectQueueStats();
    return metricsRegistry.metrics();
  }

  private collectPoolStats(): void {
    dbPoolConnections.reset();
    for (const s of poolStats(this.pools)) {
      dbPoolConnections.set({ pool: s.pool, state: 'total' }, s.total);
      dbPoolConnections.set({ pool: s.pool, state: 'idle' }, s.idle);
      dbPoolConnections.set({ pool: s.pool, state: 'waiting' }, s.waiting);
    }
  }

  private async collectQueueStats(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const snapshot = await Promise.race([
        this.queues.snapshot(this.clock.now()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('queue snapshot timed out')),
            QUEUE_SNAPSHOT_TIMEOUT_MS
          );
        }),
      ]);
      queueDepth.reset();
      queueOldestJobSeconds.reset();
      for (const q of snapshot) {
        queueDepth.set({ queue: q.queue }, q.depth);
        queueOldestJobSeconds.set({ queue: q.queue }, q.oldestJobAgeSeconds);
      }
    } catch (error) {
      // Leave the previous values in place; absence of fresh data is visible via scrape age.
      this.logger.warn({ err: toLoggableError(error) }, 'queue metrics unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
