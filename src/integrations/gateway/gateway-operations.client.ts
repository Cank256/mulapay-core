/**
 * HTTP adapter for `GatewayOperationsPort`, over undici, with the API key, timeouts and
 * retries from configuration (`GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, `GATEWAY_TIMEOUT_MS`,
 * `GATEWAY_MAX_RETRIES`).
 *
 * Retries 429 and 5xx (except 504) with exponential backoff up to `GATEWAY_MAX_RETRIES`.
 * A 504, transport error or timeout is `ambiguous` for a disbursement (spec 3.5). The
 * circuit breaker is checked before every call and updated after every result. Request
 * and response bodies are never logged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import type { Logger } from 'pino';
import { toLoggableError } from '../../common/logging/redaction';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { APP_CONFIG, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { assertGatewayEligible } from '../../modules/developer/sandbox/domain/gateway-boundary';
import type { PaymentProvider } from '../../modules/payments/domain/payment-event';
import type { RedisCircuitBreaker } from './circuit-breaker';
import {
  type BalanceAccountType,
  type CollectionRequest,
  type CollectionResult,
  type DisbursementRequest,
  type DisbursementResult,
  type GatewayBalance,
  type GatewayOperation,
  type GatewayOperationsPort,
  type GatewayOperationType,
  type GatewayStatus,
  type OperationLookup,
  type OperationPage,
} from './gateway-operations.port';
import { toGatewayAmount, toMinor } from './money';
import { GatewayRequestRecorder } from './gateway-request.recorder';

/**
 * Exponential backoff with jitter for gateway retries (spec 3.5): base 1s, doubling per
 * attempt, capped at 16s, plus up to 500ms jitter. Returns milliseconds to wait.
 */
export function retryDelayMs(attempt: number): number {
  const base = 1000;
  const maxDelay = 16000;
  const jitter = Math.random() * 500;
  const exponential = Math.min(base * 2 ** attempt, maxDelay);
  return exponential + jitter;
}

const STATUSES: readonly string[] = [
  'pending',
  'unknown',
  'successful',
  'failed',
  'expired',
  'cancelled',
];
const OPERATION_TYPES: readonly string[] = ['collection', 'disbursement', 'refund'];

interface CallMetadata {
  readonly provider: string;
  readonly operationType: 'collection' | 'disbursement' | 'refund' | 'query' | 'balance';
  readonly externalId: string;
  readonly attempt: number;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Maps one operation object from the gateway, or undefined when it is not well formed. */
export function parseOperation(value: unknown): GatewayOperation | undefined {
  const o = record(value);
  if (!o) return undefined;
  const status = text(o.status);
  const operationType = text(o.operationType);
  const externalId = text(o.externalId);
  const amount = text(o.amount);
  const currency = text(o.currency);
  const providerId = text(o.providerId);
  const createdAt = new Date(String(o.createdAt));
  const updatedAt = new Date(String(o.updatedAt));
  if (
    !status ||
    !STATUSES.includes(status) ||
    !operationType ||
    !OPERATION_TYPES.includes(operationType) ||
    !externalId ||
    !amount ||
    !currency ||
    !providerId ||
    Number.isNaN(createdAt.getTime()) ||
    Number.isNaN(updatedAt.getTime())
  ) {
    return undefined;
  }
  return {
    providerId,
    operationType: operationType as GatewayOperationType,
    referenceId: text(o.referenceId) ?? null,
    externalId,
    status: status as GatewayStatus,
    amount,
    currency,
    createdAt,
    updatedAt,
  };
}

/** Balance string to non-negative minor units; zero is a valid balance (`toMinor` refuses it). */
export function balanceToMinor(amount: string, currency: string): bigint {
  return /^0+(\.0+)?$/.test(amount) ? 0n : toMinor(amount, currency);
}

@Injectable()
export class GatewayOperationsClient implements GatewayOperationsPort {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly breaker: RedisCircuitBreaker,
    private readonly recorder: GatewayRequestRecorder
  ) {}

  async submitDisbursement(req: DisbursementRequest): Promise<DisbursementResult> {
    assertGatewayEligible(req.environment);
    if (!this.configured() || !isSupportedCurrency(req.currency)) {
      return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 0 };
    }

    // Check circuit breaker before attempting the call
    const allowed = await this.breaker.allow(req.providerId, 'disbursement');
    if (!allowed) {
      this.logger.warn({ providerId: req.providerId }, 'circuit breaker open for disbursement');
      return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 0 };
    }

    const body = JSON.stringify({
      amount: toGatewayAmount(req.amountMinor, req.currency),
      currency: req.currency,
      externalId: req.externalId,
      payee: req.payee,
      metadata: req.metadata,
    });

    let reply: Reply;
    try {
      reply = await this.callWithRetry(
        'POST',
        `/api/v1/payment/${req.providerId}/disbursement`,
        body,
        req.providerId,
        'disbursement',
        req.externalId
      );
    } catch (error) {
      // A timeout or a dropped connection: the gateway may have the operation (spec 3.5).
      this.logger.warn({ err: toLoggableError(error) }, 'gateway disbursement call failed');
      await this.breaker.record(req.providerId, 'disbursement', 'failure');
      return { kind: 'ambiguous', referenceId: null, httpStatus: null };
    }

    const data = record(record(reply.body)?.data);
    const details = record(record(record(reply.body)?.error)?.details);

    // Determine if this was a success or failure for the circuit breaker
    const isSuccess = reply.status === 200 || reply.status === 201;
    const isAmbiguous = reply.status >= 500;
    await this.breaker.record(
      req.providerId,
      'disbursement',
      isSuccess ? 'success' : isAmbiguous ? 'failure' : 'success'
    );

    switch (reply.status) {
      case 200:
      case 201: {
        const referenceId = text(data?.referenceId);
        const status = text(data?.status);
        if (!referenceId || !status || !STATUSES.includes(status)) {
          return { kind: 'ambiguous', referenceId: referenceId ?? null, httpStatus: reply.status };
        }
        return {
          kind: 'accepted',
          duplicate: reply.status === 200,
          referenceId,
          status: status as GatewayStatus,
        };
      }
      case 400:
        return { kind: 'rejected', reason: 'validation', httpStatus: 400 };
      case 409:
        return { kind: 'rejected', reason: 'conflict', httpStatus: 409 };
      case 401:
      case 403:
        return { kind: 'rejected', reason: 'unauthorized', httpStatus: reply.status };
      case 404:
        return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 404 };
      case 429:
        return { kind: 'rate_limited', retryAfterMs: null };
      default:
        return {
          kind: 'ambiguous',
          referenceId: text(details?.referenceId) ?? null,
          httpStatus: reply.status,
        };
    }
  }

  async submitCollection(req: CollectionRequest): Promise<CollectionResult> {
    assertGatewayEligible(req.environment);
    if (!this.configured() || !isSupportedCurrency(req.currency)) {
      return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 0 };
    }

    // Check circuit breaker before attempting the call
    const allowed = await this.breaker.allow(req.providerId, 'collection');
    if (!allowed) {
      this.logger.warn({ providerId: req.providerId }, 'circuit breaker open for collection');
      return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 0 };
    }

    const body = JSON.stringify({
      amount: toGatewayAmount(req.amountMinor, req.currency),
      currency: req.currency,
      externalId: req.externalId,
      payer: req.payer,
      metadata: req.metadata,
    });

    let reply: Reply;
    try {
      reply = await this.callWithRetry(
        'POST',
        `/api/v1/payment/${req.providerId}/collection`,
        body,
        req.providerId,
        'collection',
        req.externalId
      );
    } catch (error) {
      // A timeout or a dropped connection: the gateway may have the operation (spec 3.5).
      this.logger.warn({ err: toLoggableError(error) }, 'gateway collection call failed');
      await this.breaker.record(req.providerId, 'collection', 'failure');
      return { kind: 'ambiguous', referenceId: null, httpStatus: null };
    }

    const data = record(record(reply.body)?.data);
    const details = record(record(record(reply.body)?.error)?.details);

    // Determine if this was a success or failure for the circuit breaker
    const isSuccess = reply.status === 200 || reply.status === 201;
    const isAmbiguous = reply.status >= 500;
    await this.breaker.record(
      req.providerId,
      'collection',
      isSuccess ? 'success' : isAmbiguous ? 'failure' : 'success'
    );

    switch (reply.status) {
      case 200:
      case 201: {
        const referenceId = text(data?.referenceId);
        const status = text(data?.status);
        if (!referenceId || !status || !STATUSES.includes(status)) {
          return { kind: 'ambiguous', referenceId: referenceId ?? null, httpStatus: reply.status };
        }
        return {
          kind: 'accepted',
          duplicate: reply.status === 200,
          referenceId,
          status: status as GatewayStatus,
        };
      }
      case 400:
        return { kind: 'rejected', reason: 'validation', httpStatus: 400 };
      case 409:
        return { kind: 'rejected', reason: 'conflict', httpStatus: 409 };
      case 401:
      case 403:
        return { kind: 'rejected', reason: 'unauthorized', httpStatus: reply.status };
      case 404:
        return { kind: 'rejected', reason: 'provider_unavailable', httpStatus: 404 };
      case 429:
        return { kind: 'rate_limited', retryAfterMs: null };
      default:
        return {
          kind: 'ambiguous',
          referenceId: text(details?.referenceId) ?? null,
          httpStatus: reply.status,
        };
    }
  }

  async findByExternalId(
    externalId: string,
    filter: { providerId?: string; operationType?: GatewayOperationType } = {}
  ): Promise<OperationLookup> {
    if (!this.configured()) return { kind: 'unavailable', reason: 'gateway_not_configured' };
    const query = new URLSearchParams();
    if (filter.providerId) query.set('providerId', filter.providerId);
    if (filter.operationType) query.set('operationType', filter.operationType);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    try {
      const reply = await this.call(
        'GET',
        `/api/v1/transaction/by-external-id/${encodeURIComponent(externalId)}${suffix}`
      );
      if (reply.status === 404) return { kind: 'not_found' };
      if (reply.status === 409) return { kind: 'unavailable', reason: 'ambiguous_external_id' };
      if (reply.status !== 200) return { kind: 'unavailable', reason: `http_${reply.status}` };
      const operation = parseOperation(record(record(reply.body)?.data)?.operation);
      return operation
        ? { kind: 'found', operation }
        : { kind: 'unavailable', reason: 'malformed_response' };
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'gateway lookup failed');
      return { kind: 'unavailable', reason: 'transport_error' };
    }
  }

  async listOperations(query: {
    operationType?: GatewayOperationType;
    providerId?: string;
    limit: number;
    offset: number;
  }): Promise<OperationPage> {
    if (!this.configured()) return { kind: 'unavailable', reason: 'gateway_not_configured' };
    const params = new URLSearchParams({
      limit: String(Math.min(query.limit, 100)),
      offset: String(query.offset),
    });
    if (query.operationType) params.set('operationType', query.operationType);
    if (query.providerId) params.set('providerId', query.providerId);
    try {
      const reply = await this.call('GET', `/api/v1/transaction?${params.toString()}`);
      if (reply.status !== 200) return { kind: 'unavailable', reason: `http_${reply.status}` };
      const data = record(record(reply.body)?.data);
      const rows = Array.isArray(data?.operations) ? (data.operations as unknown[]) : undefined;
      const pagination = record(data?.pagination);
      if (!rows) return { kind: 'unavailable', reason: 'malformed_response' };
      const operations = rows.map(parseOperation);
      if (operations.some((o) => o === undefined)) {
        return { kind: 'unavailable', reason: 'malformed_response' };
      }
      return {
        kind: 'ok',
        operations: operations as GatewayOperation[],
        total: Number(pagination?.total ?? operations.length),
      };
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'gateway list failed');
      return { kind: 'unavailable', reason: 'transport_error' };
    }
  }

  async getBalance(
    providerId: PaymentProvider,
    accountType: BalanceAccountType,
    currency: string
  ): Promise<GatewayBalance> {
    if (!this.configured()) return { kind: 'unavailable', reason: 'gateway_not_configured' };
    try {
      const reply = await this.call(
        'GET',
        `/api/v1/payment/${providerId}/balance?accountType=${accountType}`
      );
      if (reply.status !== 200) return { kind: 'unavailable', reason: `http_${reply.status}` };
      const data = record(record(reply.body)?.data);
      const available = text(data?.availableBalance);
      const reported = text(data?.currency);
      if (!available || reported !== currency) {
        return { kind: 'unavailable', reason: 'currency_or_shape_mismatch' };
      }
      return { kind: 'ok', availableMinor: balanceToMinor(available, currency), currency };
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'gateway balance failed');
      return { kind: 'unavailable', reason: 'transport_error' };
    }
  }

  private configured(): boolean {
    return Boolean(this.config.GATEWAY_BASE_URL && this.config.GATEWAY_API_KEY);
  }

  /**
   * Wraps `call` with retry logic. Retries 429 and 5xx (except 504) up to `GATEWAY_MAX_RETRIES`
   * with exponential backoff (spec 3.5). A 504 is never retried because the outcome is ambiguous.
   * Records each attempt in gateway_requests.
   */
  private async callWithRetry(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    providerId: string,
    operationType: 'collection' | 'disbursement' | 'refund',
    externalId: string
  ): Promise<Reply> {
    const maxRetries = this.config.GATEWAY_MAX_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const reply = await this.call(method, path, body, {
          provider: providerId,
          operationType,
          externalId,
          attempt,
        });

        // Don't retry on these status codes
        if (
          reply.status < 429 ||
          reply.status === 504 ||
          (reply.status > 429 && reply.status < 500)
        ) {
          return reply;
        }

        // Retry on 429 and 5xx (except 504)
        if (reply.status === 429 || reply.status >= 500) {
          if (attempt < maxRetries) {
            const delayMs = retryDelayMs(attempt);
            this.logger.info(
              { providerId, operation: operationType, attempt, status: reply.status, delayMs },
              'retrying gateway call after error'
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          // Exhausted retries
          return reply;
        }

        return reply;
      } catch (error) {
        if (attempt < maxRetries) {
          const delayMs = retryDelayMs(attempt);
          this.logger.info(
            { providerId, operation: operationType, attempt, err: toLoggableError(error), delayMs },
            'retrying gateway call after transport error'
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        // Exhausted retries, rethrow
        throw error;
      }
    }

    // Should never reach here due to the loop logic, but TypeScript needs a return
    throw new Error('gateway call failed after retries');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    metadata?: CallMetadata
  ): Promise<Reply> {
    const start = Date.now();
    let httpStatus: number | undefined;
    let errorCode: string | undefined;

    try {
      const timeout = this.config.GATEWAY_TIMEOUT_MS;
      const response = await request(new URL(path, this.config.GATEWAY_BASE_URL), {
        method,
        headers: {
          [this.config.GATEWAY_API_KEY_HEADER]: this.config.GATEWAY_API_KEY ?? '',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body }),
        headersTimeout: timeout,
        bodyTimeout: timeout,
        signal: AbortSignal.timeout(timeout),
      });
      httpStatus = response.statusCode;
      const raw = await response.body.text();
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      const latencyMs = Date.now() - start;

      // Record the successful request
      if (metadata) {
        void this.recorder.record({
          provider: metadata.provider,
          operationType: metadata.operationType,
          externalId: metadata.externalId,
          httpStatus,
          latencyMs,
          attempt: metadata.attempt,
        });
      }

      return { status: response.statusCode, body: parsed };
    } catch (error) {
      const latencyMs = Date.now() - start;
      errorCode = error instanceof Error ? error.name : 'unknown_error';

      // Record the failed request
      if (metadata) {
        void this.recorder.record({
          provider: metadata.provider,
          operationType: metadata.operationType,
          externalId: metadata.externalId,
          httpStatus,
          latencyMs,
          errorCode,
          attempt: metadata.attempt,
        });
      }

      throw error;
    }
  }
}
