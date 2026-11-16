/**
 * Sends one notification delivery (spec 6.12: "delivery is per channel with its own retry").
 *
 * An attempt is claimed in a short transaction (the row is locked, `attempts` goes up and the
 * next-attempt time moves five minutes ahead as a lease), the vendor is called outside any
 * transaction, and the result is written in a second one. Consequently:
 *
 *  - Two workers holding the same job cannot both send: the second finds the row locked, already
 *    final, or claimed (a claim moves `next_attempt_at` forward by the lease), and does nothing.
 *  - A worker that dies after the vendor accepted a message but before recording it leaves the
 *    delivery pending; the sweep re-queues it after the lease and the message may be sent twice.
 *    Resend gets the delivery ref as an idempotency key, which prevents that for email.
 *  - A message the vendor accepted is final (`sent`) and is never retried.
 *  - A refusal that retrying cannot change (`rejected`, or no address to send to) fails the
 *    delivery at once. A vendor that is down, slow or rate limiting is retried with exponential
 *    backoff until `NOTIFICATION_MAX_ATTEMPTS`, then the delivery is `failed`.
 *
 * Every attempt is a structured log line and a metric (`core_notification_deliveries_total`),
 * carrying the channel and a reason code, never the address or the message.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import {
  EMAIL_SENDER,
  PUSH_SENDER,
  SMS_SENDER,
  type MessageSender,
} from '../../integrations/messaging/messaging.port';
import {
  metricRefreshers,
  notificationDeliveries as deliveryMetric,
  notificationDeliveriesBacklog,
} from '../../common/telemetry/metrics';
import type { notificationDeliveries as deliveriesTable } from '../../db/schema';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { retryDelaySeconds, type Channel } from './domain/notification-rules';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

const CLAIM_LEASE_MS = 5 * 60 * 1000;
/** A pending delivery older than a week is not chased any more. */
const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;

export type DeliveryOutcome = 'sent' | 'failed' | 'retry' | 'skipped';

@Injectable()
export class NotificationDeliveryService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(EMAIL_SENDER) private readonly email: MessageSender,
    @Inject(SMS_SENDER) private readonly sms: MessageSender,
    @Inject(PUSH_SENDER) private readonly push: MessageSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    metricRefreshers.set('notification_deliveries_backlog', () => this.refreshBacklogGauge());
  }

  /** One attempt. Returns what became of the delivery; `retry` means a later attempt will follow. */
  async deliver(deliveryId: string, createdAt: Date): Promise<DeliveryOutcome> {
    const claimed = await this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      const row = await this.repository.lockPending(tx, deliveryId, createdAt, now);
      if (!row) return undefined;
      const attempt = row.attempts + 1;
      await this.repository.updateDelivery(tx, row.id, row.createdAt, {
        attempts: attempt,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      });
      return { row, attempt };
    });
    if (!claimed) return 'skipped';
    const { row, attempt } = claimed;
    const channel = row.channel as Channel;

    const address = await this.addressOf(row.recipientId, channel);
    if (address === null) {
      return this.finish(row, channel, attempt, {
        kind: 'rejected',
        provider: 'none',
        reason: 'no_destination',
      });
    }
    const sender = this.senderFor(channel);
    const result = await sender.send({
      to: address,
      title: row.title,
      body: row.body,
      idempotencyKey: row.ref,
    });
    return this.finish(row, channel, attempt, result);
  }

  /** Pending deliveries whose time has passed (a lost job, a worker that died). */
  async stale(): Promise<Array<{ id: string; createdAt: Date; attempts: number }>> {
    const now = this.clock.now();
    return this.repository.stalePending(
      now,
      60_000,
      new Date(now.getTime() - SWEEP_LOOKBACK_MS),
      SWEEP_BATCH
    );
  }

  /** Brings `core_notification_deliveries_backlog` up to date: pending and failed, last day. */
  async refreshBacklogGauge(): Promise<void> {
    const since = new Date(this.clock.now().getTime() - 24 * 3600_000);
    const counts = await this.repository.deliveryCounts(since);
    notificationDeliveriesBacklog.reset();
    for (const c of counts)
      notificationDeliveriesBacklog.set({ channel: c.channel, status: c.status }, c.n);
  }

  private async finish(
    row: { id: string; createdAt: Date; ref: string },
    channel: Channel,
    attempt: number,
    result: Awaited<ReturnType<MessageSender['send']>>
  ): Promise<DeliveryOutcome> {
    const now = this.clock.now();
    const log = { delivery: row.ref, channel, attempt, provider: result.provider };
    if (result.kind === 'sent') {
      await this.write(row, {
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        sentAt: now,
        error: null,
        nextAttemptAt: null,
      });
      deliveryMetric.inc({ channel, outcome: 'sent', reason: 'ok' });
      this.logger.info(log, 'notification delivered to the vendor');
      return 'sent';
    }
    if (result.kind === 'rejected') {
      await this.write(row, {
        status: 'failed',
        provider: result.provider,
        error: result.reason,
        nextAttemptAt: null,
      });
      deliveryMetric.inc({ channel, outcome: 'failed', reason: result.reason });
      this.logger.warn({ ...log, reason: result.reason }, 'notification delivery rejected');
      return 'failed';
    }
    if (attempt >= this.config.NOTIFICATION_MAX_ATTEMPTS) {
      await this.write(row, {
        status: 'failed',
        provider: result.provider,
        error: result.reason,
        nextAttemptAt: null,
      });
      deliveryMetric.inc({ channel, outcome: 'failed', reason: result.reason });
      this.logger.error(
        { ...log, reason: result.reason },
        'notification delivery failed after the last attempt'
      );
      return 'failed';
    }
    const delay = retryDelaySeconds(attempt, this.config.NOTIFICATION_RETRY_BASE_SECONDS);
    await this.write(row, {
      provider: result.provider,
      error: result.reason,
      nextAttemptAt: new Date(now.getTime() + delay * 1000),
    });
    deliveryMetric.inc({ channel, outcome: 'retry', reason: result.reason });
    this.logger.warn(
      { ...log, reason: result.reason, retryInSeconds: delay },
      'notification delivery will be retried'
    );
    return 'retry';
  }

  private write(
    row: { id: string; createdAt: Date },
    patch: Partial<typeof deliveriesTable.$inferInsert>
  ): Promise<void> {
    return this.unitOfWork.run((tx) =>
      this.repository.updateDelivery(tx, row.id, row.createdAt, patch)
    );
  }

  private senderFor(channel: Channel): MessageSender {
    if (channel === 'email') return this.email;
    if (channel === 'sms') return this.sms;
    return this.push;
  }

  private async addressOf(recipientId: string, channel: Channel): Promise<string | null> {
    if (channel === 'email') return (await this.repository.emailOf(recipientId)) ?? null;
    const destination = await this.repository.findDestination(recipientId, channel);
    return destination ? this.notifications.decryptDestination(destination) : null;
  }
}
