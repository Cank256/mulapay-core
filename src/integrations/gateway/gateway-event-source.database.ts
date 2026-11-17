/**
 * Database event source: reads `public.operation_events` from the gateway's database through
 * the read-only pool. Enforces the mandatory 2-second lag and filters by tenant_id (spec 3.6).
 *
 * This is the primary source: lower latency than HTTP polling, and the gateway's database is
 * already Postgres, so core can query it directly. The HTTP source is a fallback for
 * deployments where direct database access is not available.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB_RO } from '../../common/db/tokens';
import { ROOT_LOGGER, APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import type { GatewayEvent, GatewayEventSource } from './gateway-event-source.port';

@Injectable()
export class DatabaseGatewayEventSource implements GatewayEventSource {
  private readonly tenantId: string;
  private readonly lagSeconds: number;

  constructor(
    @Inject(DB_RO) private readonly ro: PostgresJsDatabase,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) config: AppConfig
  ) {
    this.tenantId = config.GATEWAY_TENANT_ID;
    this.lagSeconds = config.GATEWAY_EVENT_LAG_SECONDS;
  }

  async fetchEvents(afterId: bigint, limit: number): Promise<readonly GatewayEvent[]> {
    // eslint-disable-next-line no-restricted-syntax -- safe: interval value is from validated config
    const lagInterval = sql.raw(`interval '${this.lagSeconds} seconds'`);

    type RowType = {
      id: string;
      event_id: string;
      operation_id: string | null;
      tenant_id: string;
      provider_id: string;
      operation_type: string;
      external_id: string;
      reference_id: string | null;
      provider_transaction_id: string | null;
      status: string;
      previous_status: string | null;
      amount: string;
      currency: string;
      reason: string | null;
      source: string;
      occurred_at: Date;
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- drizzle execute returns unknown[]
    const rows = await this.ro.execute<RowType>(sql`
      SELECT
        id, event_id, operation_id, tenant_id, provider_id, operation_type,
        external_id, reference_id, provider_transaction_id, status, previous_status,
        amount, currency, reason, source, occurred_at
      FROM public.operation_events
      WHERE tenant_id = ${this.tenantId}
        AND id > ${afterId.toString()}
        AND occurred_at <= now() - ${lagInterval}
      ORDER BY id ASC
      LIMIT ${limit}
    `);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- rows is typed above
    return rows.map((row: RowType): GatewayEvent => ({
      id: BigInt(row.id),
      eventId: row.event_id,
      operationId: row.operation_id,
      tenantId: row.tenant_id,
      providerId: row.provider_id,
      operationType: row.operation_type as GatewayEvent['operationType'],
      externalId: row.external_id,
      referenceId: row.reference_id,
      providerTransactionId: row.provider_transaction_id,
      status: row.status,
      previousStatus: row.previous_status,
      amount: row.amount,
      currency: row.currency,
      reason: row.reason,
      source: row.source,
      occurredAt: row.occurred_at,
    }));
  }
}
