/** Turns a KYC submission's outbox row into one screening job per subject (spec 8.8). */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { KycScreeningService, screeningJobId } from './kyc-screening.service';
import { KYC_SCREENING_OUTBOX_TYPE } from './kyc-submission.service';

export const KYC_SCREEN_JOB = 'kyc.screen-subject';

@Injectable()
export class KycScreeningRequestedHandler implements OutboxHandler {
  readonly eventType = KYC_SCREENING_OUTBOX_TYPE;

  constructor(private readonly screening: KycScreeningService) {}

  async handle(tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { kycProfileId, submissionNo } = row.payload as {
      kycProfileId: string;
      submissionNo: number;
    };
    const subjects = await this.screening.subjectJobs(tx, kycProfileId, submissionNo);
    return subjects.map((subject) => ({
      queue: QUEUES.amlScreen.name,
      name: KYC_SCREEN_JOB,
      data: { ...subject },
      options: { jobId: screeningJobId(subject) },
    }));
  }
}
