/**
 * The reconciliation queues (spec 6.8, 8.9).
 *
 *   reconciliation-run   gateway gap (every RECON_GAP_INTERVAL_SECONDS), ledger integrity
 *                        (hourly) and the balance proof (daily)
 *   statement-match      one job per uploaded statement
 *
 * Every job runs a window keyed by its time bucket or statement, so a duplicate tick, a retry
 * or a second worker is the same run (see ReconciliationRunService). A run that fails throws,
 * and BullMQ retries it with backoff under the same key.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { ReconciliationScheduler } from '../modules/reconciliation/reconciliation-scheduler.service';

export const RECONCILIATION_JOBS = {
  gap: 'reconciliation.gateway-gap',
  integrity: 'reconciliation.ledger-integrity',
  proof: 'reconciliation.balance-proof',
} as const;
export const STATEMENT_MATCH_JOB = 'statement.match';

@Injectable()
export class ReconciliationRunProcessor implements QueueProcessor {
  readonly definition = QUEUES.reconciliationRun;

  constructor(private readonly scheduler: ReconciliationScheduler) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case RECONCILIATION_JOBS.gap:
        return (await this.scheduler.runScheduled('gateway_gap')).outcome;
      case RECONCILIATION_JOBS.integrity:
        return (await this.scheduler.runScheduled('ledger_integrity')).outcome;
      case RECONCILIATION_JOBS.proof:
        return (await this.scheduler.runScheduled('balance_proof')).outcome;
      default:
        throw new UnrecoverableError(`unknown reconciliation-run job ${job.name}`);
    }
  }
}

@Injectable()
export class StatementMatchProcessor implements QueueProcessor {
  readonly definition = QUEUES.statementMatch;

  constructor(private readonly scheduler: ReconciliationScheduler) {}

  async process(job: Job): Promise<unknown> {
    if (job.name !== STATEMENT_MATCH_JOB) {
      throw new UnrecoverableError(`unknown statement-match job ${job.name}`);
    }
    const { statementRef } = job.data as { statementRef: string };
    return (await this.scheduler.runStatementMatch(statementRef)).outcome;
  }
}
