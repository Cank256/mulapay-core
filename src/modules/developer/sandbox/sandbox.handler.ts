/**
 * Starts the simulation of a test-environment payment (spec 6.11). The payment creator
 * writes the outbox row in the transaction that creates the payment; this handler, run by
 * the outbox dispatcher after commit, queues the first simulation step. Nothing is queued
 * from the request.
 */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../../common/outbox/outbox.repository';
import { QUEUES } from '../../../common/queue/queue.definitions';
import { SANDBOX_PAYMENT_OUTBOX_TYPE } from '../../payments/payment-creator';
import { SANDBOX_JOB, sandboxJobId } from './sandbox.service';

@Injectable()
export class SandboxPaymentHandler implements OutboxHandler {
  readonly eventType = SANDBOX_PAYMENT_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { paymentId } = row.payload as { paymentId: string };
    return [
      {
        queue: QUEUES.gatewayChase.name,
        name: SANDBOX_JOB,
        data: { paymentId, step: 'start' },
        options: { jobId: sandboxJobId(paymentId, 'start') },
      },
    ];
  }
}
