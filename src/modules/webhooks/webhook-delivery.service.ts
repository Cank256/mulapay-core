/**
 * One webhook delivery attempt (spec 6.11). Runs in the worker.
 *
 * Properties:
 *  - One sender per attempt: a 30-second lease on the delivery row, then a conditional
 *    update that records the result only if the delivery is still at the attempt it was
 *    leased at. A duplicate job (a retry of a stalled job, the recovery sweep) finds the
 *    lease taken or the attempt already recorded and sends nothing.
 *  - No transaction is open while the request is in flight. The result is recorded in one
 *    short transaction together with the endpoint's failure counter.
 *  - Success is a 2xx within 10 seconds. A 3xx is a failure: redirects are not followed.
 *  - Failures follow the schedule 0 s, 30 s, 2 m, 10 m, 1 h, 6 h, 24 h with jitter. After
 *    the seventh the delivery is `exhausted`.
 *  - An endpoint that is not active is not contacted: the delivery ends `failed` and can be
 *    replayed once the endpoint is enabled.
 *  - The 50th consecutive failure of an endpoint disables it (`auto_disabled`) and, in the
 *    same transaction, announces it to the merchant with a `webhook_endpoint.auto_disabled`
 *    event and an audit row. Only the call that makes the change announces it.
 *  - The payload is identical on every attempt and every replay of an event, and
 *    `MulaPay-Event-Id` identifies it, so receivers deduplicate on the event id. Only the
 *    signature timestamp changes between attempts.
 *  - Logs carry refs, status and timings, never the URL, the payload or the response body.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { toLoggableError } from '../../common/logging/redaction';
import { QUEUES } from '../../common/queue/queue.definitions';
import { QueueRegistry } from '../../common/queue/queue.registry';
import {
  webhookDeliveryDuration,
  webhookEndpointsAutoDisabled,
} from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { MerchantEventsRepository } from '../events/merchant-events.repository';
import { MerchantEventsService } from '../events/merchant-events.service';
import { toMerchantEventView } from '../events/merchant-event.views';
import { AUTO_DISABLE_AFTER_FAILURES, nextAttemptDelayMs } from './domain/retry-schedule';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from './domain/webhook-signature';
import {
  WebhookDeliveriesRepository,
  type WebhookDeliveryRow,
} from './webhook-deliveries.repository';
import { WebhookEndpointsRepository } from './webhook-endpoints.repository';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WEBHOOK_TRANSPORT, type WebhookTransport } from './webhook-transport';

export const DELIVERY_JOB = 'deliver';
const LEASE_MS = 30_000;

export type AttemptOutcome =
  'skipped' | 'succeeded' | 'retry_scheduled' | 'exhausted' | 'endpoint_inactive' | 'superseded';

/** The queue job id of attempt `attempt` of a delivery: one job per attempt, never reused. */
export function deliveryJobId(ref: string, attempt: number): string {
  return `wd_${ref}_${attempt}`;
}

@Injectable()
export class WebhookDeliveryService {
  constructor(
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly endpointService: WebhookEndpointsService,
    private readonly events: MerchantEventsRepository,
    private readonly merchantEvents: MerchantEventsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly queues: QueueRegistry,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async attempt(ref: string): Promise<AttemptOutcome> {
    const now = this.clock.now();
    const delivery = await this.deliveries.lease(ref, now, LEASE_MS);
    if (!delivery) return 'skipped';
    const endpoint = await this.endpoints.findById(delivery.endpointId);
    const event = await this.events.findById(delivery.eventId);
    if (!endpoint || !event || endpoint.deletedAt !== null || endpoint.status !== 'active') {
      await this.unitOfWork.run((tx) =>
        this.deliveries.finishAttempt(tx, delivery, {
          attempt: delivery.attempt,
          status: 'failed',
          httpStatus: null,
          responseMs: 0,
          excerpt: null,
          error: 'endpoint_disabled',
          nextAttemptAt: null,
          at: now,
        })
      );
      return 'endpoint_inactive';
    }

    const body = JSON.stringify(toMerchantEventView(event));
    const timestamp = Math.floor(now.getTime() / 1000);
    const result = await this.transport.post({
      url: endpoint.url,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'MulaPay-Webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(
          this.endpointService.signingSecrets(endpoint, now),
          timestamp,
          body
        ),
        'MulaPay-Event-Id': event.ref,
        'MulaPay-Event-Type': event.type,
        'MulaPay-Delivery-Id': delivery.ref,
        'MulaPay-Delivery-Attempt': String(delivery.attempt + 1),
      },
    });

    const attemptNo = delivery.attempt + 1;
    const success = result.kind === 'response' && result.status >= 200 && result.status < 300;
    const delayMs = success ? null : nextAttemptDelayMs(attemptNo);
    const finishedAt = this.clock.now();
    const status = success ? 'succeeded' : delayMs === null ? 'exhausted' : 'pending';
    const nextAttemptAt =
      status === 'pending' ? new Date(finishedAt.getTime() + (delayMs ?? 0)) : null;
    const error = success
      ? null
      : result.kind === 'response'
        ? `http_${result.status}`
        : result.outcome;
    webhookDeliveryDuration.observe(
      { outcome: success ? 'success' : result.kind === 'response' ? 'http_error' : result.outcome },
      result.elapsedMs / 1000
    );

    const applied = await this.unitOfWork.run(async (tx) => {
      const recorded = await this.deliveries.finishAttempt(tx, delivery, {
        attempt: attemptNo,
        status,
        httpStatus: result.kind === 'response' ? result.status : null,
        responseMs: result.elapsedMs,
        excerpt: result.kind === 'response' ? result.excerpt : null,
        error,
        nextAttemptAt,
        at: finishedAt,
      });
      if (!recorded) return false;
      if (success) await this.endpoints.recordSuccess(tx, endpoint.id, finishedAt);
      else await this.recordFailure(tx, endpoint.id, endpoint.merchantId, finishedAt);
      return true;
    });
    if (!applied) return 'superseded';

    this.logger.info(
      {
        deliveryRef: delivery.ref,
        endpointRef: endpoint.ref,
        attempt: attemptNo,
        status,
        httpStatus: result.kind === 'response' ? result.status : null,
        error,
        elapsedMs: result.elapsedMs,
      },
      'webhook delivery attempt'
    );
    if (status === 'pending' && nextAttemptAt) {
      await this.schedule(delivery, attemptNo + 1, nextAttemptAt.getTime() - finishedAt.getTime());
      return 'retry_scheduled';
    }
    return status === 'succeeded' ? 'succeeded' : 'exhausted';
  }

  /** Adds the next attempt's delayed job. If this fails the recovery sweep re-adds it. */
  private async schedule(delivery: WebhookDeliveryRow, attempt: number, delayMs: number) {
    try {
      await this.queues.get(QUEUES.webhookDelivery.name).add(
        DELIVERY_JOB,
        { deliveryRef: delivery.ref },
        {
          delay: Math.max(0, delayMs),
          jobId: deliveryJobId(delivery.ref, attempt),
        }
      );
    } catch (error) {
      this.logger.warn(
        { deliveryRef: delivery.ref, err: toLoggableError(error) },
        'webhook retry not queued; the recovery sweep will queue it'
      );
    }
  }

  /** Counts the failure and, on the 50th in a row, disables the endpoint and tells the merchant. */
  private async recordFailure(
    tx: Transaction,
    endpointId: string,
    merchantId: string,
    at: Date
  ): Promise<void> {
    const updated = await this.endpoints.recordFailure(tx, endpointId, at);
    if (updated.failureCount < AUTO_DISABLE_AFTER_FAILURES || updated.status !== 'active') return;
    const disabled = await this.endpoints.autoDisable(tx, endpointId, at);
    if (!disabled) return;
    webhookEndpointsAutoDisabled.inc();
    await this.merchantEvents.emit(tx, {
      merchantId,
      environment: disabled.environment as 'test' | 'live',
      type: 'webhook_endpoint.auto_disabled',
      resourceType: 'webhook_endpoint',
      resourceId: disabled.ref,
      object: {
        id: disabled.ref,
        status: disabled.status,
        failureCount: disabled.failureCount,
        disabledAt: at.toISOString(),
      },
    });
    await this.audit.record(tx, {
      action: 'webhook_endpoint.auto_disabled',
      resourceType: 'webhook_endpoint',
      resourceId: disabled.ref,
      merchantId,
      after: { status: disabled.status, failureCount: disabled.failureCount },
      actor: { type: 'system', id: null, label: 'webhook-delivery' },
    });
    this.logger.warn(
      { endpointRef: disabled.ref, failureCount: disabled.failureCount },
      'webhook endpoint auto-disabled after consecutive failures'
    );
  }
}
