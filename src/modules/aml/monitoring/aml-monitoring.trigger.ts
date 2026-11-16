/**
 * Queues post-transaction monitoring when a live transaction reaches a terminal state (spec
 * 6.13: "on every terminal transaction event"). The lifecycle of each money domain calls
 * `enqueue` in the same transaction as the status change; the outbox dispatcher then queues
 * the `aml-screen` job after commit, so monitoring exists for exactly the transitions that
 * happened, and nothing enqueues from a request handler (spec 8.8).
 */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../../common/outbox/outbox.repository';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { QUEUES } from '../../../common/queue/queue.definitions';

export const AML_TERMINAL_OUTBOX_TYPE = 'aml.transaction_terminal';
export const AML_MONITOR_JOB = 'aml.monitor-transaction';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

@Injectable()
export class AmlMonitoringTrigger {
  constructor(private readonly outbox: OutboxService) {}

  /** Test-environment and non-terminal transitions are ignored. A transaction has one terminal event. */
  async enqueue(
    tx: Transaction,
    transaction: { id: string; environment: 'test' | 'live'; status: string }
  ): Promise<void> {
    if (transaction.environment !== 'live' || !TERMINAL.has(transaction.status)) return;
    await this.outbox.enqueue(tx, {
      eventType: AML_TERMINAL_OUTBOX_TYPE,
      aggregateType: 'transaction',
      aggregateId: transaction.id,
      payload: { transactionId: transaction.id },
      dedupeKey: `aml:terminal:${transaction.id}`,
    });
  }
}

@Injectable()
export class AmlTerminalHandler implements OutboxHandler {
  readonly eventType = AML_TERMINAL_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { transactionId } = row.payload as { transactionId: string };
    return [
      {
        queue: QUEUES.amlScreen.name,
        name: AML_MONITOR_JOB,
        data: { transactionId },
        options: { jobId: `aml_monitor_${transactionId}` },
      },
    ];
  }
}
