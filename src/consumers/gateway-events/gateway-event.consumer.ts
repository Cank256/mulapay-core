/**
 * Gateway event consumer (spec 10.2): reads events from the gateway event source, applies them
 * idempotently, and advances the cursor. One transaction per event: insert, handler, cursor
 * update (spec 10.2 rule). After 3 failed attempts, marks the event `failed`, advances the
 * cursor, raises a reconciliation exception, and opens a sev2 incident (head-of-line blocking
 * is worse than a flagged exception).
 *
 * Adaptive polling: 250ms when events are flowing, 2s when idle. Heartbeat every loop updates
 * `consumer_cursors.heartbeat_at` (fixes the `never_started` cursor route, P8-05).
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { DB_RO } from '../../common/db/tokens';
import type { Transaction } from '../../common/db/database.types';
import {
  GATEWAY_EVENT_SOURCE,
  type GatewayEvent,
  type GatewayEventSource,
} from '../../integrations/gateway/gateway-event-source.port';
import { GatewayEventHandlerRegistry } from './handler.registry';

const CURSOR_NAME = 'gateway';
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 2000;
const MAX_ATTEMPTS = 3;

interface CursorRow {
  position: string;
}

interface EventRow {
  id: bigint;
}

@Injectable()
export class GatewayEventConsumer implements OnModuleInit {
  private running = false;
  private pollMs = MIN_POLL_MS;

  constructor(
    @Inject(GATEWAY_EVENT_SOURCE) private readonly eventSource: GatewayEventSource,
    private readonly uow: UnitOfWork,
    @Inject(DB_RO) private readonly ro: PostgresJsDatabase,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly handlerRegistry: GatewayEventHandlerRegistry
  ) {}

  async onModuleInit(): Promise<void> {
    // Start the consumer loop on module init
    this.running = true;
    void this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async run(): Promise<void> {
    this.logger.info('gateway event consumer started');

    while (this.running) {
      try {
        await this.processNextBatch();
      } catch (error) {
        this.logger.error({ err: error }, 'consumer loop error');
        // Wait before retrying to avoid tight error loops
        await this.sleep(MAX_POLL_MS);
      }
    }

    this.logger.info('gateway event consumer stopped');
  }

  private async processNextBatch(): Promise<void> {
    // Read cursor (no lock needed for read)
    const cursor = await this.readCursor();
    const afterId = BigInt(cursor.position);

    // Fetch events from source
    const events = await this.eventSource.fetchEvents(
      afterId,
      this.config.GATEWAY_EVENT_BATCH_SIZE
    );

    if (events.length === 0) {
      // No events: slow down polling and update heartbeat
      this.pollMs = Math.min(this.pollMs * 2, MAX_POLL_MS);
      await this.updateHeartbeat();
      await this.sleep(this.pollMs);
      return;
    }

    // Events flowing: speed up polling
    this.pollMs = MIN_POLL_MS;

    // Process each event in its own transaction
    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async processEvent(event: GatewayEvent): Promise<void> {
    try {
      await this.uow.run(async (tx) => {
        // 1. Insert event with dedupe (ON CONFLICT DO NOTHING)
        const inserted = await this.insertEvent(tx, event);

        if (!inserted) {
          // Event already processed (dedupe on gateway_event_id)
          this.logger.debug({ eventId: event.eventId }, 'event already processed, skipping');
          await this.advanceCursor(tx, event.id);
          return;
        }

        // 2. Apply handler using registry
        const handler = this.handlerRegistry.getHandler(event.operationType, event.status);
        if (handler) {
          await handler.handle(tx, event);
        } else {
          this.logger.warn(
            { operationType: event.operationType, status: event.status },
            'no handler registered for event type/status combination'
          );
        }

        await this.markEventApplied(tx, event.eventId);

        // 3. Advance cursor (never moves backwards)
        await this.advanceCursor(tx, event.id);
      });
    } catch (error) {
      // Increment attempts and check if we should give up
      await this.handleFailedEvent(event, error);
    }
  }

  private async insertEvent(tx: Transaction, event: GatewayEvent): Promise<boolean> {
    const result = await tx.execute(sql`
      INSERT INTO core.gateway_events (
        gateway_event_id, gateway_id, operation_id, provider_id, operation_type,
        external_id, reference_id, provider_transaction_id, status, previous_status,
        amount, currency, reason, source, occurred_at
      ) VALUES (
        ${event.eventId}, ${event.id.toString()}, ${event.operationId}, ${event.providerId},
        ${event.operationType}, ${event.externalId}, ${event.referenceId},
        ${event.providerTransactionId}, ${event.status}, ${event.previousStatus},
        ${event.amount}, ${event.currency}, ${event.reason}, ${event.source}, ${event.occurredAt}
      )
      ON CONFLICT (gateway_event_id) DO NOTHING
      RETURNING id
    `);

    return (result as unknown as EventRow[]).length > 0;
  }

  private async markEventApplied(tx: Transaction, eventId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE core.gateway_events
      SET apply_status = 'applied',
          processed_at = now() AT TIME ZONE 'UTC'
      WHERE gateway_event_id = ${eventId}
    `);
  }

  private async advanceCursor(tx: Transaction, eventId: bigint): Promise<void> {
    // Cursor never moves backwards (use GREATEST)
    await tx.execute(sql`
      UPDATE core.consumer_cursors
      SET position = GREATEST(position, ${eventId.toString()}::bigint),
          heartbeat_at = now() AT TIME ZONE 'UTC'
      WHERE name = ${CURSOR_NAME}
    `);
  }

  private async updateHeartbeat(): Promise<void> {
    await this.uow.run(async (tx) => {
      await tx.execute(sql`
        UPDATE core.consumer_cursors
        SET heartbeat_at = now() AT TIME ZONE 'UTC'
        WHERE name = ${CURSOR_NAME}
      `);
    });
  }

  private async readCursor(): Promise<CursorRow> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- drizzle execute returns unknown
    const rows = await this.ro.execute(sql`
      SELECT position::text as position
      FROM core.consumer_cursors
      WHERE name = ${CURSOR_NAME}
    `);

    const typedRows = rows as unknown as CursorRow[];
    if (!typedRows || typedRows.length === 0 || !typedRows[0]) {
      throw new Error('gateway cursor not found');
    }

    return typedRows[0];
  }

  private async handleFailedEvent(event: GatewayEvent, error: unknown): Promise<void> {
    // Increment attempts
    await this.uow.run(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE core.gateway_events
        SET attempts = attempts + 1,
            apply_error = ${String(error)}
        WHERE gateway_event_id = ${event.eventId}
        RETURNING attempts
      `);

      const typedResult = result as unknown as { attempts: number }[];
      const attempts =
        typedResult && typedResult.length > 0 && typedResult[0] ? typedResult[0].attempts : 0;

      if (attempts >= MAX_ATTEMPTS) {
        // Give up after 3 attempts: mark failed, advance cursor, raise exception
        this.logger.error(
          { eventId: event.eventId, attempts, err: error },
          'event failed after max attempts, marking failed and advancing cursor'
        );

        await tx.execute(sql`
          UPDATE core.gateway_events
          SET apply_status = 'failed'
          WHERE gateway_event_id = ${event.eventId}
        `);

        await this.advanceCursor(tx, event.id);

        // TODO P3-09: raise reconciliation exception and open sev2 incident
      } else {
        this.logger.warn(
          { eventId: event.eventId, attempts, err: error },
          'event processing failed, will retry'
        );
      }
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
