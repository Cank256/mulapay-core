/**
 * Queue operations (spec 6.14, 8.9): depth and age, retrying failed jobs, pausing and resuming.
 *
 * Retrying is safe by construction: every job is idempotent (spec 8.9), so a job that ran
 * halfway or twice has one effect. Pausing stops a queue from taking new jobs; running jobs
 * finish. The dead-letter queue is a parking lot, not a queue: it can be read but not paused,
 * and its jobs are retried by finding the original queue's job (OPERATIONS.md).
 *
 * Each action is audited after it succeeds and counted in `core_ops_actions_total`.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { DEAD_LETTER_QUEUE } from '../../common/queue/queue.definitions';
import { QueueRegistry } from '../../common/queue/queue.registry';
import { opsActions } from '../../common/telemetry/metrics';

export interface QueueView {
  readonly name: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly paused: boolean;
  readonly oldestWaitingSeconds: number;
}

const MAX_RETRY = 1000;

@Injectable()
export class QueueOpsService {
  constructor(
    private readonly queues: QueueRegistry,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService
  ) {}

  async list(now: Date): Promise<QueueView[]> {
    return Promise.all(this.queues.names().map((name) => this.view(name, now)));
  }

  async view(name: string, now: Date): Promise<QueueView> {
    const queue = this.queues.get(name);
    const counts = await queue.getJobCounts(
      'waiting',
      'prioritized',
      'active',
      'delayed',
      'failed'
    );
    const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
    return {
      name,
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      paused: await queue.isPaused(),
      oldestWaitingSeconds: oldest ? Math.max(0, (now.getTime() - oldest.timestamp) / 1000) : 0,
    };
  }

  async retryFailed(name: string, limit: number): Promise<{ retried: number }> {
    this.assertOperable(name);
    const queue = this.queues.get(name);
    const before = (await queue.getJobCounts('failed')).failed ?? 0;
    // BullMQ retries in batches of `count`; the cap keeps one call bounded.
    await queue.retryJobs({ state: 'failed', count: Math.min(limit, MAX_RETRY) });
    const after = (await queue.getJobCounts('failed')).failed ?? 0;
    const retried = Math.max(0, before - after);
    await this.record('queue.failed_retried', name, { retried, limit });
    return { retried };
  }

  async pause(name: string): Promise<void> {
    this.assertOperable(name);
    await this.queues.get(name).pause();
    await this.record('queue.paused', name, {});
  }

  async resume(name: string): Promise<void> {
    this.assertOperable(name);
    await this.queues.get(name).resume();
    await this.record('queue.resumed', name, {});
  }

  private assertOperable(name: string): void {
    if (!this.queues.names().includes(name)) throw new AppError('NOT_FOUND');
    if (name === DEAD_LETTER_QUEUE) {
      throw new AppError('OPS_INVALID', {
        messageParams: { reason: 'dead_letter_is_not_a_queue' },
        details: { reason: 'dead_letter_is_not_a_queue' },
      });
    }
  }

  private async record(
    action: string,
    queue: string,
    after: Record<string, unknown>
  ): Promise<void> {
    await this.unitOfWork.run((tx) =>
      this.audit.record(tx, { action, resourceType: 'queue', resourceId: queue, after })
    );
    opsActions.inc({ action });
  }
}
