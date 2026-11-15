/**
 * The delivery log and replay (spec 6.11, 7.2 `/webhook-deliveries`).
 *
 * A replay is a new delivery of the same event to the same endpoint: it links to the
 * delivery it repeats (`replayOf`), starts at attempt 1, and goes through the outbox like
 * any first delivery. The original is never changed, which the database enforces (a delivery
 * that left `pending` is final). The payload and `MulaPay-Event-Id` are those of the
 * original event, so a receiver that deduplicates on the event id applies it once.
 *
 * Replays are not themselves idempotent: replaying twice sends the event twice. Receivers
 * must deduplicate on the event id, as for any at-least-once delivery.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { OutboxService } from '../../common/outbox/outbox.service';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { CLOCK } from '../../common/tokens';
import { MerchantEventsRepository } from '../events/merchant-events.repository';
import {
  WebhookDeliveriesRepository,
  type DeliveryFilter,
  type WebhookDeliveryRow,
} from './webhook-deliveries.repository';
import { toWebhookDeliveryView, type WebhookDeliveryView } from './webhook-delivery.views';
import { WebhookEndpointsRepository } from './webhook-endpoints.repository';

export const DELIVERY_CREATED_OUTBOX_TYPE = 'webhook.delivery_created';
/** Deliveries one bulk replay request creates at most. */
export const BULK_REPLAY_LIMIT = 500;

export interface ListDeliveriesQuery {
  readonly endpoint?: string;
  readonly eventType?: string;
  readonly status?: 'pending' | 'succeeded' | 'failed' | 'exhausted';
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

export interface BulkReplayRequest {
  readonly endpoint?: string;
  readonly eventType?: string;
  /** Which finished deliveries to repeat. Defaults to the ones that did not succeed. */
  readonly statuses: readonly ('succeeded' | 'failed' | 'exhausted')[];
  readonly from: Date;
  readonly to: Date;
}

@Injectable()
export class WebhookDeliveriesService {
  constructor(
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly events: MerchantEventsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async get(scope: MerchantScope, ref: string): Promise<WebhookDeliveryView> {
    const row = await this.deliveries.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    return (await this.views([row]))[0] as WebhookDeliveryView;
  }

  async list(scope: MerchantScope, query: ListDeliveriesQuery): Promise<Page<WebhookDeliveryView>> {
    const window = resolveWindow(query, this.clock.now());
    const fingerprint = filterFingerprint({
      environment: scope.environment,
      endpoint: query.endpoint,
      eventType: query.eventType,
      status: query.status,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const endpointId = await this.endpointId(scope, query.endpoint);
    if (endpointId === null) return { items: [], nextCursor: null };
    const rows = await this.deliveries.list({
      scope,
      ...window,
      eventType: query.eventType,
      endpointId,
      statuses: query.status ? [query.status] : undefined,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.createdAt,
      id: row.ref,
    }));
    return { items: await this.views(page.items), nextCursor: page.nextCursor };
  }

  /** Replays one finished delivery. The endpoint must be active. */
  async replay(scope: MerchantScope, ref: string): Promise<WebhookDeliveryView> {
    const original = await this.deliveries.findByRef(scope, ref);
    if (!original) throw new AppError('NOT_FOUND');
    if (original.status === 'pending') throw new AppError('WEBHOOK_DELIVERY_NOT_REPLAYABLE');
    const replay = await this.unitOfWork.run(async (tx) => {
      if (!(await this.endpointIsActive(tx, original))) {
        throw new AppError('WEBHOOK_ENDPOINT_NOT_ACTIVE');
      }
      const created = await this.createReplay(tx, original);
      await this.audit.record(tx, {
        action: 'webhook_delivery.replayed',
        resourceType: 'webhook_delivery',
        resourceId: original.ref,
        merchantId: scope.merchantId,
        after: { replay: created.ref },
      });
      return created;
    });
    return (await this.views([replay]))[0] as WebhookDeliveryView;
  }

  /** Replays the finished deliveries matching `request`, at most BULK_REPLAY_LIMIT. */
  async replayBulk(
    scope: MerchantScope,
    request: BulkReplayRequest
  ): Promise<{ replayed: number; truncated: boolean }> {
    const window = resolveWindow(request, this.clock.now());
    const endpointId = await this.endpointId(scope, request.endpoint);
    if (endpointId === null) return { replayed: 0, truncated: false };
    const filter: DeliveryFilter = {
      scope,
      ...window,
      eventType: request.eventType,
      endpointId,
      statuses: request.statuses,
    };
    const originals = await this.deliveries.listForReplay(filter, BULK_REPLAY_LIMIT + 1);
    const batch = originals.slice(0, BULK_REPLAY_LIMIT);
    const replayed = await this.unitOfWork.run(async (tx) => {
      let count = 0;
      for (const original of batch) {
        if (!(await this.endpointIsActive(tx, original))) continue;
        await this.createReplay(tx, original);
        count += 1;
      }
      await this.audit.record(tx, {
        action: 'webhook_delivery.bulk_replayed',
        resourceType: 'webhook_delivery',
        merchantId: scope.merchantId,
        after: {
          replayed: count,
          eventType: request.eventType ?? null,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
      });
      return count;
    });
    return { replayed, truncated: originals.length > BULK_REPLAY_LIMIT };
  }

  /** The endpoint's internal id, undefined for "any", null when the ref names no endpoint of the merchant. */
  private async endpointId(scope: MerchantScope, ref: string | undefined) {
    if (ref === undefined) return undefined;
    const endpoint = await this.endpoints.findByRef(scope, ref);
    return endpoint?.id ?? null;
  }

  private async endpointIsActive(tx: Transaction, original: WebhookDeliveryRow): Promise<boolean> {
    const endpoint = await this.endpoints.findById(original.endpointId, tx);
    return endpoint !== undefined && endpoint.deletedAt === null && endpoint.status === 'active';
  }

  /** Inserts the replay and its outbox row. The caller has checked that the endpoint is active. */
  private async createReplay(
    tx: Transaction,
    original: WebhookDeliveryRow
  ): Promise<WebhookDeliveryRow> {
    const now = this.clock.now();
    const ref = publicId('webhookDelivery', now);
    const row: WebhookDeliveryRow = {
      id: uuidv7(now),
      ref,
      endpointId: original.endpointId,
      merchantId: original.merchantId,
      environment: original.environment,
      eventId: original.eventId,
      eventType: original.eventType,
      dedupeKey: `${original.endpointId}:${original.eventId}:replay:${ref}`,
      replayOfRef: original.ref,
      attempt: 0,
      status: 'pending',
      httpStatus: null,
      responseMs: null,
      responseBodyExcerpt: null,
      error: null,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deliveries.insert(tx, row);
    await this.outbox.enqueue(tx, {
      eventType: DELIVERY_CREATED_OUTBOX_TYPE,
      aggregateType: 'webhook_delivery',
      aggregateId: ref,
      payload: { deliveryRef: ref },
      dedupeKey: `webhook_delivery:${ref}`,
    });
    return row;
  }

  /** Resolves the endpoint and event refs of a page of deliveries with two queries. */
  private async views(rows: readonly WebhookDeliveryRow[]): Promise<WebhookDeliveryView[]> {
    const [endpointRefs, eventRefs] = await Promise.all([
      this.endpoints.refsByIds([...new Set(rows.map((r) => r.endpointId))]),
      this.events.refsByIds([...new Set(rows.map((r) => r.eventId))]),
    ]);
    return rows.map((row) =>
      toWebhookDeliveryView(row, {
        endpoint: endpointRefs.get(row.endpointId) ?? '',
        event: eventRefs.get(row.eventId) ?? '',
      })
    );
  }
}
