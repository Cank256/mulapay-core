/**
 * Gateway request recorder (P3-11): records every HTTP call to the gateway in `gateway_requests`
 * for reconciliation, debugging and metrics. Records http_status, latency, error_code, attempt
 * number and external_id. Links to transaction_id when available. Runs async (fire-and-forget)
 * to avoid blocking gateway calls.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB_RW } from '../../common/db/tokens';
import { ROOT_LOGGER } from '../../common/tokens';

export interface GatewayRequestRecord {
  readonly transactionId?: string;
  readonly provider: string;
  readonly operationType: 'collection' | 'disbursement' | 'refund' | 'query' | 'balance';
  readonly externalId: string;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly attempt: number;
  readonly requestId?: string;
}

@Injectable()
export class GatewayRequestRecorder {
  constructor(
    @Inject(DB_RW) private readonly db: PostgresJsDatabase,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Records a gateway request asynchronously (fire-and-forget). If recording fails,
   * logs the error but does not throw (the gateway call result is more important than
   * the audit record).
   */
  async record(request: GatewayRequestRecord): Promise<void> {
    void this.recordInternal(request);
  }

  private async recordInternal(request: GatewayRequestRecord): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO core.gateway_requests (
          transaction_id, provider, operation_type, external_id,
          http_status, latency_ms, error_code, attempt, request_id
        ) VALUES (
          ${request.transactionId ?? null},
          ${request.provider},
          ${request.operationType},
          ${request.externalId},
          ${request.httpStatus ?? null},
          ${request.latencyMs ?? null},
          ${request.errorCode ?? null},
          ${request.attempt},
          ${request.requestId ?? null}
        )
      `);
    } catch (error) {
      this.logger.warn(
        { err: error, provider: request.provider, externalId: request.externalId },
        'failed to record gateway request'
      );
    }
  }
}
