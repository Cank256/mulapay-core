/**
 * The `aml-screen` queue (spec 8.9, concurrency 8): compliance work that must not run in a
 * request. Job names select the work.
 *
 *   kyc.screen-subject       screen one merchant, director or UBO of a KYC submission
 *   aml.monitor-transaction  evaluate the AML rules for one terminal live transaction
 *   aml.tick                 every minute: escalate alerts past their SLA, refresh the gauge
 *   aml.blocklist-rebuild    every 5 minutes: rebuild the Redis blocklist mirror from the database
 *   kyc.lifecycle-sweep      every hour: re-verification notices and expiry
 *
 * Every job is idempotent. A screening or a monitoring job is keyed by what it works on
 * (profile, submission and subject; transaction), so a retry, a duplicate or two workers give
 * one result. The sweeps lock and re-check each row. A screening whose provider does not
 * answer fails and is retried (8 attempts, about 21 minutes); after that it parks in the
 * dead-letter queue and the submission stays blocked until an analyst reruns it.
 */
import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { AmlAlertsService } from '../modules/aml/alerts/aml-alerts.service';
import { AmlBlocklistService } from '../modules/aml/blocklist/aml-blocklist.service';
import { AmlMonitoringService } from '../modules/aml/monitoring/aml-monitoring.service';
import { AML_MONITOR_JOB } from '../modules/aml/monitoring/aml-monitoring.trigger';
import { KycLifecycleService } from '../modules/kyc/kyc-lifecycle.service';
import { KYC_SCREEN_JOB } from '../modules/kyc/kyc-screening.handler';
import {
  KycScreeningService,
  type ScreeningSubjectJob,
} from '../modules/kyc/kyc-screening.service';

export const AML_JOBS = {
  tick: 'aml.tick',
  blocklistRebuild: 'aml.blocklist-rebuild',
  kycLifecycle: 'kyc.lifecycle-sweep',
} as const;

@Injectable()
export class AmlScreenProcessor implements QueueProcessor {
  readonly definition = QUEUES.amlScreen;

  constructor(
    private readonly screening: KycScreeningService,
    private readonly monitoring: AmlMonitoringService,
    private readonly alerts: AmlAlertsService,
    private readonly blocklist: AmlBlocklistService,
    private readonly lifecycle: KycLifecycleService
  ) {}

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case KYC_SCREEN_JOB:
        return this.screening.screenSubject(job.data as ScreeningSubjectJob);
      case AML_MONITOR_JOB:
        return this.monitoring.monitor((job.data as { transactionId: string }).transactionId);
      case AML_JOBS.tick: {
        const swept = await this.alerts.sweepOverdue();
        await this.alerts.refreshGauge();
        return swept;
      }
      case AML_JOBS.blocklistRebuild:
        return this.blocklist.rebuild();
      case AML_JOBS.kycLifecycle:
        return this.lifecycle.sweep();
      default:
        throw new UnrecoverableError(`unknown aml-screen job ${job.name}`);
    }
  }
}
