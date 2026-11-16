/**
 * The `support-ops` queue (one at a time): the minute sweeps of support and operations.
 *
 *   complaints.sla-sweep      every minute: mark complaints past their SLA breached, tell staff
 *   disputes.deadline-sweep   every 5 minutes: warn of evidence deadlines near and passed
 *   approvals.expire          every 5 minutes: expire approval requests nobody decided
 *   ops.monitor               every `OPS_MONITOR_INTERVAL_SECONDS`: the automatic incident monitors
 *
 * Every sweep re-checks each row under its lock, so a late, repeated or concurrent tick has the
 * effect of one.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { ComplaintsService } from '../modules/complaints/complaints.service';
import { DisputesService } from '../modules/disputes/disputes.service';
import { ApprovalsService } from '../modules/operations/approvals/approvals.service';
import { OpsMonitorService } from '../modules/operations/ops-monitor.service';

export const SUPPORT_JOBS = {
  complaintSla: 'complaints.sla-sweep',
  disputeDeadlines: 'disputes.deadline-sweep',
  approvalsExpire: 'approvals.expire',
  monitor: 'ops.monitor',
} as const;

@Injectable()
export class SupportOpsProcessor implements QueueProcessor {
  readonly definition = QUEUES.supportOps;

  constructor(
    private readonly complaints: ComplaintsService,
    private readonly disputes: DisputesService,
    private readonly approvals: ApprovalsService,
    private readonly monitor: OpsMonitorService
  ) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case SUPPORT_JOBS.complaintSla: {
        const breached = await this.complaints.sweepSla();
        await this.complaints.refreshGauge();
        return breached;
      }
      case SUPPORT_JOBS.disputeDeadlines:
        return this.disputes.sweepDeadlines();
      case SUPPORT_JOBS.approvalsExpire:
        return this.approvals.expireOverdue();
      case SUPPORT_JOBS.monitor:
        return this.monitor.evaluate();
      default:
        throw new UnrecoverableError(`unknown support-ops job ${job.name}`);
    }
  }
}
