/** Queues the payout submission once the release transaction has committed (spec 8.8). */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { SETTLEMENT_SUBMIT_OUTBOX_TYPE } from './settlement-release.service';

export const SETTLEMENT_SUBMIT_JOB = 'settlement.submit-payout';
export const settlementSubmitJobId = (batchId: string) => `settlement_submit_${batchId}`;

@Injectable()
export class SettlementSubmitHandler implements OutboxHandler {
  readonly eventType = SETTLEMENT_SUBMIT_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { batchId } = row.payload as { batchId: string };
    return [
      {
        queue: QUEUES.settlementRun.name,
        name: SETTLEMENT_SUBMIT_JOB,
        data: { batchId },
        options: { jobId: settlementSubmitJobId(batchId) },
      },
    ];
  }
}
