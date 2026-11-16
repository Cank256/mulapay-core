/**
 * Notifications (spec 6.12): templates, channel selection by preference, deduplication, and
 * the in-app inbox.
 *
 * `notify(tx, ...)` is called by the domain services inside the transaction of the change that
 * caused the notification, so a notification exists exactly when its cause committed. It writes
 * one `notifications` row per recipient and channel, one delivery row for it, and an outbox row
 * that makes a worker send it; nothing is sent from the request. The in-app channel is complete
 * when the row exists (its delivery is recorded as delivered at once).
 *
 * Invariants upheld:
 *  - Deduplication: a recipient is not notified again of the same template for the same
 *    resource within five minutes (spec 6.12). The check runs under an advisory lock on
 *    (recipient, template, resource), so two concurrent transactions cannot both pass it.
 *    Repeating the same fact (`sourceKey`) never creates a second row, however much later.
 *  - A missing or inactive template, or one that fails to render, is logged, counted and
 *    skipped. It never fails the business transaction that asked for the notification.
 *  - A recipient's preferences are respected unless the template is mandatory.
 *  - Messages hold what the template renders from the variables the caller supplied: callers
 *    pass references and short labels, never personal data or secrets.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Executor, Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { OutboxService } from '../../common/outbox/outbox.service';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { notificationsCreated, notificationsSuppressed } from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import {
  DEDUPE_WINDOW_MS,
  DEFAULT_LOCALE,
  MissingTemplateVariableError,
  render,
  selectChannels,
  templateProblems,
  type Channel,
} from './domain/notification-rules';
import {
  NotificationsRepository,
  type DestinationRow,
  type NotificationRow,
  type TemplateRow,
} from './notifications.repository';

export const NOTIFICATION_DELIVER_OUTBOX_TYPE = 'notification.deliver';

export type Audience =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'users'; readonly userIds: readonly string[] }
  /** Active members of the merchant whose role holds the permission. */
  | { readonly kind: 'merchant'; readonly merchantId: string; readonly permission: string }
  /** Active staff whose role holds the permission. */
  | { readonly kind: 'staff'; readonly permission: string };

export interface NotifyInput {
  readonly templateCode: string;
  readonly audience: Audience;
  /** What the notification is about (a ref). Notifications for it are deduplicated per recipient. */
  readonly resourceKey: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly data?: Readonly<Record<string, string>>;
  /**
   * Identifies the fact being announced (`complaint.created:{ref}`). Handling the same fact
   * twice creates nothing the second time, whatever the dedupe window says.
   */
  readonly sourceKey?: string;
}

export interface NotifyResult {
  readonly created: number;
  readonly deduplicated: number;
}

export interface TemplateInput {
  readonly code: string;
  readonly channel: Channel;
  readonly subject?: string | null;
  readonly body: string;
  readonly variables: readonly string[];
  readonly mandatory?: boolean;
  readonly audience: 'staff' | 'merchant' | 'any';
  readonly active?: boolean;
}

const MAX_BROADCAST_RECIPIENTS = 1000;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly outbox: OutboxService,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Creates the notifications for an audience. See the file comment for what it guarantees. */
  async notify(tx: Transaction, input: NotifyInput): Promise<NotifyResult> {
    const now = this.clock.now();
    const templates = await this.repository.activeTemplates(tx, input.templateCode, DEFAULT_LOCALE);
    if (templates.length === 0) {
      notificationsSuppressed.inc({ reason: 'no_template' });
      this.logger.warn(
        { template: input.templateCode },
        'notification skipped: no active template'
      );
      return { created: 0, deduplicated: 0 };
    }
    const userIds = await this.resolveAudience(tx, input.audience);
    if (userIds.length === 0) return { created: 0, deduplicated: 0 };

    const rendered = new Map<Channel, { title: string | null; body: string }>();
    try {
      const variables = input.variables ?? {};
      for (const t of templates) {
        rendered.set(t.channel as Channel, {
          title: t.subject === null ? null : render(t.subject, variables),
          body: render(t.body, variables),
        });
      }
    } catch (error) {
      if (!(error instanceof MissingTemplateVariableError)) throw error;
      notificationsSuppressed.inc({ reason: 'render_failed' });
      this.logger.error(
        { template: input.templateCode, variable: error.variable },
        'notification skipped: template could not be rendered'
      );
      return { created: 0, deduplicated: 0 };
    }

    const preferences = await this.repository.preferencesOf(tx, userIds, input.templateCode);
    const destinations = await this.repository.destinationChannels(tx, userIds);
    let created = 0;
    let deduplicated = 0;
    for (const userId of userIds) {
      const channels = selectChannels({
        templates: templates.map((t) => ({
          channel: t.channel as Channel,
          mandatory: t.mandatory,
        })),
        templateCode: input.templateCode,
        preferences: preferences.get(userId) ?? [],
        destinations: destinations.get(userId) ?? new Set<Channel>(),
      });
      if (channels.length === 0) continue;

      await this.lockSubject(tx, userId, input.templateCode, input.resourceKey);
      const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
      if (
        await this.repository.existsSince(tx, userId, input.templateCode, input.resourceKey, since)
      ) {
        deduplicated += 1;
        notificationsSuppressed.inc({ reason: 'deduplicated' });
        continue;
      }
      for (const channel of channels) {
        const message = rendered.get(channel);
        if (!message) continue;
        const wrote = await this.write(tx, now, userId, channel, input, message);
        if (wrote) {
          created += 1;
          notificationsCreated.inc({ channel });
        }
      }
    }
    return { created, deduplicated };
  }

  /** Runs `notify` in its own transaction, for callers that have none open. */
  notifyStandalone(input: NotifyInput): Promise<NotifyResult> {
    return this.unitOfWork.run((tx) => this.notify(tx, input));
  }

  // -- in-app inbox ---------------------------------------------------------------------

  async inbox(
    userId: string,
    query: { unreadOnly: boolean; limit: number; cursor?: string }
  ): Promise<Page<NotificationRow>> {
    const fingerprint = filterFingerprint({ unread: query.unreadOnly });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.inbox(userId, {
      unreadOnly: query.unreadOnly,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  unreadCount(userId: string): Promise<number> {
    return this.repository.unreadCount(userId);
  }

  /** Marks one notification read. Reading it again is a no-op; someone else's is "not found". */
  async markRead(userId: string, ref: string): Promise<void> {
    if (!(await this.repository.exists(userId, ref))) throw new AppError('NOT_FOUND');
    await this.unitOfWork.run((tx) => this.repository.markRead(tx, userId, ref, this.clock.now()));
  }

  /** Marks every unread in-app notification of the user read. Returns how many changed. */
  markAllRead(userId: string): Promise<number> {
    return this.unitOfWork.run((tx) => this.repository.markAllRead(tx, userId, this.clock.now()));
  }

  // -- preferences and destinations ---------------------------------------------------------

  listPreferences(userId: string) {
    return this.repository.listPreferences(userId);
  }

  /** Sets preferences. A mandatory template's channel cannot be switched off. */
  async setPreferences(
    userId: string,
    items: ReadonlyArray<{ templateCode: string; channel: Channel; enabled: boolean }>
  ): Promise<void> {
    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      for (const item of items) {
        if (item.templateCode !== '*') {
          const templates = await this.repository.activeTemplates(
            tx,
            item.templateCode,
            DEFAULT_LOCALE
          );
          if (templates.length === 0) {
            throw new AppError('NOTIFICATION_TEMPLATE_INVALID', {
              messageParams: { reason: 'unknown_template' },
              details: { reason: 'unknown_template', template: item.templateCode },
            });
          }
          const locked = templates.some((t) => t.channel === item.channel && t.mandatory);
          if (locked && !item.enabled) {
            throw new AppError('NOTIFICATION_PREFERENCE_LOCKED', {
              details: { template: item.templateCode, channel: item.channel },
            });
          }
        }
        await this.repository.upsertPreference(tx, {
          id: uuidv7(now),
          userId,
          templateCode: item.templateCode,
          channel: item.channel,
          enabled: item.enabled,
        });
      }
      await this.audit.record(tx, {
        action: 'notification_preferences.updated',
        resourceType: 'notification_preferences',
        resourceId: userId,
        after: { changes: items.length },
      });
    });
  }

  async listDestinations(userId: string): Promise<DestinationRow[]> {
    return this.repository.listDestinations(userId);
  }

  /** Sets where a user receives SMS or push. The address is stored encrypted. */
  async setDestination(
    userId: string,
    channel: 'sms' | 'push',
    address: string
  ): Promise<DestinationRow> {
    if (!this.encryption.available) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('no data encryption key is configured'),
      });
    }
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const saved = await this.repository.upsertDestination(tx, {
        id: uuidv7(now),
        userId,
        channel,
        addressEnc: this.encryption.encrypt(address, destinationContext(userId, channel)),
        addressHint: address.slice(-4),
      });
      await this.audit.record(tx, {
        action: 'notification_destination.set',
        resourceType: 'notification_destination',
        resourceId: userId,
        after: { channel, hint: saved.addressHint },
      });
      return saved;
    });
  }

  async removeDestination(userId: string, channel: 'sms' | 'push'): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const removed = await this.repository.deleteDestination(tx, userId, channel);
      if (!removed) throw new AppError('NOT_FOUND');
      await this.audit.record(tx, {
        action: 'notification_destination.removed',
        resourceType: 'notification_destination',
        resourceId: userId,
        after: { channel },
      });
    });
  }

  /** The clear address of a destination, for the delivery worker only. */
  decryptDestination(destination: DestinationRow): string {
    return this.encryption.decrypt(
      destination.addressEnc,
      destinationContext(destination.userId, destination.channel)
    );
  }

  // -- templates (admin) ---------------------------------------------------------------------

  listTemplates(filter: { code?: string; channel?: string }): Promise<TemplateRow[]> {
    return this.repository.listTemplates(filter);
  }

  /** Creates or replaces a template. Every placeholder must be declared, and no declared one unused. */
  async saveTemplate(input: TemplateInput): Promise<TemplateRow> {
    const subject = input.subject ?? null;
    const { undeclared, unused } = templateProblems(input.variables, subject, input.body);
    if (undeclared.length > 0 || unused.length > 0) {
      throw new AppError('NOTIFICATION_TEMPLATE_INVALID', {
        messageParams: {
          reason: undeclared.length > 0 ? 'undeclared_variable' : 'unused_variable',
        },
        details: { undeclared, unused },
      });
    }
    if (input.channel !== 'sms' && subject === null) {
      throw new AppError('NOTIFICATION_TEMPLATE_INVALID', {
        messageParams: { reason: 'subject_required' },
        details: { reason: 'subject_required' },
      });
    }
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const existing = await this.repository.findTemplate(
        tx,
        input.code,
        input.channel,
        DEFAULT_LOCALE
      );
      const saved = existing
        ? await this.repository.updateTemplate(tx, existing.id, {
            subject,
            body: input.body,
            variables: [...input.variables],
            mandatory: input.mandatory ?? existing.mandatory,
            active: input.active ?? existing.active,
          })
        : await this.repository.insertTemplate(tx, {
            id: uuidv7(now),
            code: input.code,
            channel: input.channel,
            locale: DEFAULT_LOCALE,
            subject,
            body: input.body,
            variables: [...input.variables],
            mandatory: input.mandatory ?? false,
            audience: input.audience,
            active: input.active ?? true,
          });
      await this.audit.record(tx, {
        action: existing ? 'notification_template.updated' : 'notification_template.created',
        resourceType: 'notification_template',
        resourceId: `${saved.code}:${saved.channel}`,
        before: existing
          ? { version: existing.version, active: existing.active, mandatory: existing.mandatory }
          : null,
        after: { version: saved.version, active: saved.active, mandatory: saved.mandatory },
      });
      return saved;
    });
  }

  // -- broadcast (admin) ---------------------------------------------------------------------

  /** Announces something to all staff, or to the owners and admins of merchants. */
  async broadcast(input: {
    readonly audience: 'staff' | 'merchants';
    readonly merchantIds?: readonly string[];
    readonly headline: string;
    readonly message: string;
  }): Promise<NotifyResult & { recipients: number }> {
    return this.unitOfWork.run(async (tx) => {
      const userIds =
        input.audience === 'staff'
          ? await this.repository.staffWith(tx, 'support:read')
          : await this.repository.broadcastMerchantUsers(
              tx,
              input.merchantIds,
              MAX_BROADCAST_RECIPIENTS + 1
            );
      if (userIds.length > MAX_BROADCAST_RECIPIENTS) {
        throw new AppError('BROADCAST_TOO_LARGE', { details: { max: MAX_BROADCAST_RECIPIENTS } });
      }
      const key = `broadcast:${uuidv7(this.clock.now())}`;
      const result = await this.notify(tx, {
        templateCode: 'broadcast.announcement',
        audience: { kind: 'users', userIds },
        resourceKey: key,
        sourceKey: key,
        variables: { headline: input.headline, message: input.message },
      });
      await this.audit.record(tx, {
        action: 'notification.broadcast',
        resourceType: 'notification',
        resourceId: key,
        after: { audience: input.audience, recipients: userIds.length, created: result.created },
      });
      return { ...result, recipients: userIds.length };
    });
  }

  // -- internals ---------------------------------------------------------------------------

  /** The recipients, sorted: concurrent notifications lock them in one order, so they cannot deadlock. */
  private async resolveAudience(tx: Executor, audience: Audience): Promise<string[]> {
    const ids = await (async () => {
      switch (audience.kind) {
        case 'user':
          return this.repository.activeUsers(tx, [audience.userId]);
        case 'users':
          return this.repository.activeUsers(tx, audience.userIds);
        case 'merchant':
          return this.repository.merchantUsersWith(tx, audience.merchantId, audience.permission);
        case 'staff':
          return this.repository.staffWith(tx, audience.permission);
      }
    })();
    return [...new Set(ids)].sort();
  }

  private async lockSubject(
    tx: Executor,
    userId: string,
    templateCode: string,
    resourceKey: string
  ): Promise<void> {
    await tx.execute(sqlLock(`notify:${userId}:${templateCode}:${resourceKey}`));
  }

  private async write(
    tx: Transaction,
    now: Date,
    userId: string,
    channel: Channel,
    input: NotifyInput,
    message: { title: string | null; body: string }
  ): Promise<boolean> {
    const row = await this.repository.insertNotification(tx, {
      id: uuidv7(now),
      ref: publicId('notification', now),
      recipientType: 'user',
      recipientId: userId,
      channel,
      templateCode: input.templateCode,
      resourceKey: input.resourceKey,
      sourceKey: input.sourceKey ? `${input.sourceKey}:${userId}:${channel}` : null,
      title: message.title,
      body: message.body,
      data: { ...(input.data ?? {}) },
      createdAt: now,
    });
    if (!row) return false;
    const inApp = channel === 'in_app';
    const delivery = await this.repository.insertDelivery(tx, {
      id: uuidv7(now),
      ref: publicId('notificationDelivery', now),
      notificationId: row.id,
      recipientId: userId,
      templateCode: input.templateCode,
      channel,
      status: inApp ? 'delivered' : 'pending',
      attempts: 0,
      nextAttemptAt: inApp ? null : now,
      deliveredAt: inApp ? now : null,
      createdAt: now,
    });
    if (!inApp) {
      await this.outbox.enqueue(tx, {
        eventType: NOTIFICATION_DELIVER_OUTBOX_TYPE,
        aggregateType: 'notification_delivery',
        aggregateId: delivery.id,
        payload: { deliveryId: delivery.id, deliveryCreatedAt: delivery.createdAt.toISOString() },
        dedupeKey: `notification_delivery:${delivery.id}`,
      });
    }
    return true;
  }
}

export function destinationContext(userId: string, channel: string): string {
  return `notification_destinations:${userId}:${channel}`;
}

function sqlLock(key: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
