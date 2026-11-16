/**
 * The `report-generate` queue (spec 8.9, concurrency 2: memory-heavy, streamed).
 *
 *   report.generate   stream one report into object storage; idempotent (a ready, failed or
 *                     expired report is left alone, and a lease stops two workers sharing one)
 *   reports.tick      every minute: create the report of every schedule whose time has come
 *   reports.expire    every hour: delete files older than seven days
 *
 * A generation that fails is retried by BullMQ (3 attempts, 30 s apart, exponential); the report
 * row counts the attempts and fails for good on the last, telling its requester.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { ReportGenerationService } from '../modules/reports/report-generation.service';
import { ReportSchedulesService } from '../modules/reports/report-schedules.service';
import { REPORT_GENERATE_JOB } from '../modules/reports/report.handlers';
import { ReportsService } from '../modules/reports/reports.service';

export const REPORT_JOBS = { tick: 'reports.tick', expire: 'reports.expire' } as const;

@Injectable()
export class ReportGenerateProcessor implements QueueProcessor {
  readonly definition = QUEUES.reportGenerate;

  constructor(
    private readonly generation: ReportGenerationService,
    private readonly schedules: ReportSchedulesService,
    private readonly reports: ReportsService
  ) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case REPORT_GENERATE_JOB: {
        const outcome = await this.generation.generate((job.data as { reportId: string }).reportId);
        if (outcome === 'retry') throw new Error('report generation will be retried');
        return outcome;
      }
      case REPORT_JOBS.tick:
        return this.schedules.tick();
      case REPORT_JOBS.expire:
        return this.reports.expireOld();
      default:
        throw new UnrecoverableError(`unknown report-generate job ${job.name}`);
    }
  }
}
