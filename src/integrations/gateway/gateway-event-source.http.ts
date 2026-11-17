/**
 * HTTP event source: calls `GET /api/v1/events` on the gateway (spec 3.2, 3.6). Fallback for
 * deployments where direct database access is not available. The gateway enforces the
 * mandatory 2-second lag and filters by tenant (via the API key).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { request } from 'undici';
import { toLoggableError } from '../../common/logging/redaction';
import { ROOT_LOGGER } from '../../common/tokens';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import type { GatewayEvent, GatewayEventSource } from './gateway-event-source.port';

interface EventResponse {
  success: boolean;
  data?: {
    events: Array<{
      id: string | number;
      eventId: string;
      operationId?: string | null;
      tenantId: string;
      providerId: string;
      operationType: string;
      externalId: string;
      referenceId?: string | null;
      providerTransactionId?: string | null;
      status: string;
      previousStatus?: string | null;
      amount: string;
      currency: string;
      reason?: string | null;
      source: string;
      occurredAt: string;
    }>;
  };
}

@Injectable()
export class HttpGatewayEventSource implements GatewayEventSource {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiKeyHeader: string;
  private readonly timeout: number;
  private readonly lagSeconds: number;

  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) config: AppConfig
  ) {
    this.baseUrl = config.GATEWAY_BASE_URL ?? '';
    this.apiKey = config.GATEWAY_API_KEY ?? '';
    this.apiKeyHeader = config.GATEWAY_API_KEY_HEADER;
    this.timeout = config.GATEWAY_TIMEOUT_MS;
    this.lagSeconds = config.GATEWAY_EVENT_LAG_SECONDS;
  }

  async fetchEvents(afterId: bigint, limit: number): Promise<readonly GatewayEvent[]> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('gateway not configured');
    }

    const url = new URL('/api/v1/events', this.baseUrl);
    url.searchParams.set('afterId', afterId.toString());
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('lagSeconds', String(this.lagSeconds));

    try {
      const response = await request(url, {
        method: 'GET',
        headers: {
          [this.apiKeyHeader]: this.apiKey,
          accept: 'application/json',
        },
        headersTimeout: this.timeout,
        bodyTimeout: this.timeout,
        signal: AbortSignal.timeout(this.timeout),
      });

      const raw = await response.body.text();
      if (response.statusCode !== 200) {
        throw new Error(`gateway events HTTP ${response.statusCode}`);
      }

      const body = JSON.parse(raw) as EventResponse;
      if (!body.success || !body.data?.events) {
        throw new Error('gateway events malformed response');
      }

      return body.data.events.map((event) => ({
        id: typeof event.id === 'string' ? BigInt(event.id) : BigInt(event.id),
        eventId: event.eventId,
        operationId: event.operationId ?? null,
        tenantId: event.tenantId,
        providerId: event.providerId,
        operationType: event.operationType as GatewayEvent['operationType'],
        externalId: event.externalId,
        referenceId: event.referenceId ?? null,
        providerTransactionId: event.providerTransactionId ?? null,
        status: event.status,
        previousStatus: event.previousStatus ?? null,
        amount: event.amount,
        currency: event.currency,
        reason: event.reason ?? null,
        source: event.source,
        occurredAt: new Date(event.occurredAt),
      }));
    } catch (error) {
      this.logger.error({ err: toLoggableError(error) }, 'gateway event fetch failed');
      throw error;
    }
  }
}
