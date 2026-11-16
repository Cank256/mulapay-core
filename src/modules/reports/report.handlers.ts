/** Outbox handler: queues the generation of a report once its request has committed (spec 8.8). */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { REPORT_REQUESTED_OUTBOX_TYPE } from './reports.service';

export const REPORT_GENERATE_JOB = 'report.generate';

@Injectable()
export class ReportRequestedHandler implements OutboxHandler {
  readonly eventType = REPORT_REQUESTED_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { reportId } = row.payload as { reportId: string };
    return [
      {
        queue: QUEUES.reportGenerate.name,
        name: REPORT_GENERATE_JOB,
        data: { reportId },
        // One job per report: the outbox row delivered twice queues it once.
        options: { jobId: `report.${reportId}` },
      },
    ];
  }
}
