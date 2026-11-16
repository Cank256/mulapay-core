/**
 * Merchant events (spec 6.11, 8.8).
 *
 * `emit` writes the event and its outbox row in the caller's transaction, so a merchant
 * never sees an event for a change that rolled back, and never misses one for a change that
 * committed. The webhook fan-out and the sandbox hang off the outbox row, after commit.
 *
 * Payloads are what the API shows for the resource at that moment (refs, status, string
 * minor-unit amounts). They never carry secrets, provider payloads or full phone numbers.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { OutboxService } from '../../common/outbox/outbox.service';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { CLOCK } from '../../common/tokens';
import type { MerchantEventType } from './domain/event-types';
import { NOTIFIABLE_EVENT_TYPES, NOTIFICATION_EVENT_OUTBOX_TYPE } from './domain/notifiable-events';
import { MerchantEventsRepository } from './merchant-events.repository';
import { toMerchantEventView, type MerchantEventView } from './merchant-event.views';

export const MERCHANT_EVENT_OUTBOX_TYPE = 'merchant_event.created';

export interface EmitEventInput {
  readonly merchantId: string;
  readonly environment: 'test' | 'live';
  readonly type: MerchantEventType;
  readonly resourceType: string;
  readonly resourceId: string;
  /** The resource as the API shows it. JSON-serialisable, no bigint. */
  readonly object: Readonly<Record<string, unknown>>;
}

export interface ListEventsQuery {
  readonly type?: MerchantEventType;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class MerchantEventsService {
  constructor(
    private readonly repository: MerchantEventsRepository,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Writes the event and announces it through the outbox. Call inside the state change's transaction. */
  async emit(tx: Executor, input: EmitEventInput): Promise<{ id: string; ref: string }> {
    const now = this.clock.now();
    const row = await this.repository.insert(tx, {
      id: uuidv7(now),
      ref: publicId('merchantEvent', now),
      merchantId: input.merchantId,
      environment: input.environment,
      type: input.type,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payload: { object: input.object },
      createdAt: now,
    });
    await this.outbox.enqueue(tx, {
      eventType: MERCHANT_EVENT_OUTBOX_TYPE,
      aggregateType: 'merchant_event',
      aggregateId: row.id,
      payload: { eventId: row.id },
      dedupeKey: `merchant_event:${row.id}`,
    });
    // Live events that concern the merchant's people also become notifications (spec 6.12).
    if (input.environment === 'live' && NOTIFIABLE_EVENT_TYPES.has(input.type)) {
      await this.outbox.enqueue(tx, {
        eventType: NOTIFICATION_EVENT_OUTBOX_TYPE,
        aggregateType: 'merchant_event',
        aggregateId: row.id,
        payload: { eventId: row.id },
        dedupeKey: `notification_event:${row.id}`,
      });
    }
    return { id: row.id, ref: row.ref };
  }

  async get(scope: MerchantScope, ref: string): Promise<MerchantEventView> {
    const row = await this.repository.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    return toMerchantEventView(row);
  }

  async list(scope: MerchantScope, query: ListEventsQuery): Promise<Page<MerchantEventView>> {
    const window = resolveWindow(query, this.clock.now());
    const fingerprint = filterFingerprint({
      environment: scope.environment,
      type: query.type,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.list({
      scope,
      type: query.type,
      ...window,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.createdAt,
      id: row.ref,
    }));
    return { items: page.items.map(toMerchantEventView), nextCursor: page.nextCursor };
  }
}
