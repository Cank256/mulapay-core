/**
 * The write side of the transactional outbox (spec 8.8).
 *
 * Any state change that another module or a merchant cares about calls `enqueue` inside the
 * same transaction as the change, so the fact and its announcement commit or roll back
 * together. Nothing enqueues a queue job from a request handler: the dispatcher does, after
 * commit, from these rows.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../clock/clock';
import type { Executor } from '../db/database.types';
import { uuidv7 } from '../ids/ids';
import { CLOCK } from '../tokens';
import { OutboxRepository } from './outbox.repository';

export interface OutboxMessage {
  /** `{domain}.{action}`: selects the handler. */
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Identifiers only. The handler reads whatever else it needs. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  /** The same business fact always has the same key, so a repeat adds no second row. */
  readonly dedupeKey: string;
  /** Earliest time the dispatcher may publish it. */
  readonly availableAt?: Date;
}

@Injectable()
export class OutboxService {
  constructor(
    private readonly repository: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Writes the message in `tx`. Returns false when the dedupe key already exists. */
  enqueue(tx: Executor, message: OutboxMessage): Promise<boolean> {
    const now = this.clock.now();
    return this.repository.insert(tx, {
      id: uuidv7(now),
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      dedupeKey: message.dedupeKey,
      availableAt: message.availableAt ?? now,
      createdAt: now,
    });
  }
}
