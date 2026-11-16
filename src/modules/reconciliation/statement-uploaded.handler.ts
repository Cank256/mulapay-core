/** Queues the matching of an uploaded statement after the upload transaction commits. */
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../common/db/database.types';
import type { OutboxHandler, OutboxJob } from '../../common/outbox/outbox-handler';
import type { OutboxRow } from '../../common/outbox/outbox.repository';
import { QUEUES } from '../../common/queue/queue.definitions';
import { STATEMENT_UPLOADED_OUTBOX_TYPE } from './statements.service';

@Injectable()
export class StatementUploadedHandler implements OutboxHandler {
  readonly eventType = STATEMENT_UPLOADED_OUTBOX_TYPE;

  async handle(_tx: Transaction, row: OutboxRow): Promise<readonly OutboxJob[]> {
    const { statementId, statementRef } = row.payload as {
      statementId: string;
      statementRef: string;
    };
    return [
      {
        queue: QUEUES.statementMatch.name,
        name: 'statement.match',
        data: { statementRef },
        options: { jobId: `statement_match_${statementId}` },
      },
    ];
  }
}
