/**
 * SQL for notifications (spec 5.2, 6.12): templates, preferences, destinations, the
 * notifications themselves and their delivery log. Reads of `notification_deliveries` always
 * carry a `created_at` bound (spec 9.2 rule 6); a ref embeds its creation time.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import {
  notificationDeliveries,
  notificationDestinations,
  notificationPreferences,
  notificationTemplates,
  notifications,
  users,
} from '../../db/schema';
import type { Channel, PreferenceRow } from './domain/notification-rules';

export type TemplateRow = typeof notificationTemplates.$inferSelect;
export type NewTemplate = typeof notificationTemplates.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type DestinationRow = typeof notificationDestinations.$inferSelect;

export interface DeliveryFilter {
  readonly status?: string;
  readonly channel?: string;
  readonly from: Date;
  readonly to: Date;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  // -- templates ---------------------------------------------------------------------

  activeTemplates(
    tx: Executor,
    code: string,
    locale: string
  ): Promise<Array<Pick<TemplateRow, 'channel' | 'subject' | 'body' | 'variables' | 'mandatory'>>> {
    return tx
      .select({
        channel: notificationTemplates.channel,
        subject: notificationTemplates.subject,
        body: notificationTemplates.body,
        variables: notificationTemplates.variables,
        mandatory: notificationTemplates.mandatory,
      })
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.code, code),
          eq(notificationTemplates.locale, locale),
          eq(notificationTemplates.active, true)
        )
      );
  }

  listTemplates(filter: { code?: string; channel?: string }): Promise<TemplateRow[]> {
    return this.db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          filter.code ? eq(notificationTemplates.code, filter.code) : undefined,
          filter.channel ? eq(notificationTemplates.channel, filter.channel) : undefined
        )
      )
      .orderBy(
        notificationTemplates.code,
        notificationTemplates.channel,
        notificationTemplates.locale
      );
  }

  async findTemplate(
    tx: Executor,
    code: string,
    channel: string,
    locale: string
  ): Promise<TemplateRow | undefined> {
    const [row] = await tx
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.code, code),
          eq(notificationTemplates.channel, channel),
          eq(notificationTemplates.locale, locale)
        )
      )
      .for('update');
    return row;
  }

  async insertTemplate(tx: Executor, values: NewTemplate): Promise<TemplateRow> {
    const [row] = await tx.insert(notificationTemplates).values(values).returning();
    if (!row) throw new Error('template insert returned no row');
    return row;
  }

  async updateTemplate(
    tx: Executor,
    id: string,
    patch: Partial<Pick<NewTemplate, 'subject' | 'body' | 'variables' | 'mandatory' | 'active'>>
  ): Promise<TemplateRow> {
    const [row] = await tx
      .update(notificationTemplates)
      .set({ ...patch, version: sql`${notificationTemplates.version} + 1` })
      .where(eq(notificationTemplates.id, id))
      .returning();
    if (!row) throw new Error('template update returned no row');
    return row;
  }

  // -- preferences and destinations ----------------------------------------------------

  async preferencesOf(
    tx: Executor,
    userIds: readonly string[],
    code: string
  ): Promise<Map<string, PreferenceRow[]>> {
    const out = new Map<string, PreferenceRow[]>();
    if (userIds.length === 0) return out;
    const rows = await tx
      .select({
        userId: notificationPreferences.userId,
        templateCode: notificationPreferences.templateCode,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(
        and(
          inArray(notificationPreferences.userId, [...userIds]),
          inArray(notificationPreferences.templateCode, [code, '*'])
        )
      );
    for (const r of rows) {
      const list = out.get(r.userId) ?? [];
      list.push({
        templateCode: r.templateCode,
        channel: r.channel as Channel,
        enabled: r.enabled,
      });
      out.set(r.userId, list);
    }
    return out;
  }

  listPreferences(userId: string): Promise<PreferenceRow[]> {
    return this.db
      .select({
        templateCode: notificationPreferences.templateCode,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .orderBy(notificationPreferences.templateCode, notificationPreferences.channel) as Promise<
      PreferenceRow[]
    >;
  }

  async upsertPreference(
    tx: Executor,
    row: { id: string; userId: string; templateCode: string; channel: string; enabled: boolean }
  ): Promise<void> {
    await tx
      .insert(notificationPreferences)
      .values(row)
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.templateCode,
          notificationPreferences.channel,
        ],
        set: { enabled: row.enabled },
      });
  }

  async destinationChannels(
    tx: Executor,
    userIds: readonly string[]
  ): Promise<Map<string, Set<Channel>>> {
    const out = new Map<string, Set<Channel>>();
    if (userIds.length === 0) return out;
    const rows = await tx
      .select({
        userId: notificationDestinations.userId,
        channel: notificationDestinations.channel,
      })
      .from(notificationDestinations)
      .where(inArray(notificationDestinations.userId, [...userIds]));
    for (const r of rows) {
      const set = out.get(r.userId) ?? new Set<Channel>();
      set.add(r.channel as Channel);
      out.set(r.userId, set);
    }
    return out;
  }

  async findDestination(
    userId: string,
    channel: string,
    tx: Executor = this.db
  ): Promise<DestinationRow | undefined> {
    const [row] = await tx
      .select()
      .from(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.userId, userId),
          eq(notificationDestinations.channel, channel)
        )
      )
      .limit(1);
    return row;
  }

  listDestinations(userId: string): Promise<DestinationRow[]> {
    return this.db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.userId, userId));
  }

  async upsertDestination(
    tx: Executor,
    row: { id: string; userId: string; channel: string; addressEnc: string; addressHint: string }
  ): Promise<DestinationRow> {
    const [saved] = await tx
      .insert(notificationDestinations)
      .values(row)
      .onConflictDoUpdate({
        target: [notificationDestinations.userId, notificationDestinations.channel],
        set: { addressEnc: row.addressEnc, addressHint: row.addressHint },
      })
      .returning();
    if (!saved) throw new Error('destination upsert returned no row');
    return saved;
  }

  async deleteDestination(tx: Executor, userId: string, channel: string): Promise<boolean> {
    const rows = await tx
      .delete(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.userId, userId),
          eq(notificationDestinations.channel, channel)
        )
      )
      .returning({ id: notificationDestinations.id });
    return rows.length > 0;
  }

  // -- audiences -------------------------------------------------------------------------

  /** Active members of a merchant whose role grants `permission`. */
  async merchantUsersWith(tx: Executor, merchantId: string, permission: string): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(sql`
      select distinct m.user_id
        from core.merchant_members m
        join core.role_permissions rp on rp.role_key = m.role and rp.permission_key = ${permission}
        join core.users u on u.id = m.user_id and u.status = 'active'
       where m.merchant_id = ${merchantId} and m.status = 'active'`);
    return result.rows.map((r) => r.user_id);
  }

  /** Active staff holding a role that grants `permission`. */
  async staffWith(tx: Executor, permission: string): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(sql`
      select distinct a.user_id
        from core.staff_role_assignments a
        join core.role_permissions rp on rp.role_key = a.role_key and rp.permission_key = ${permission}
        join core.users u on u.id = a.user_id and u.status = 'active' and u.type = 'staff'`);
    return result.rows.map((r) => r.user_id);
  }

  /** Of these ids, those that are active users. */
  async activeUsers(tx: Executor, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')));
    return rows.map((r) => r.id);
  }

  /** Owners and admins of active merchants, optionally limited to some merchants. */
  async broadcastMerchantUsers(
    tx: Executor,
    merchantIds: readonly string[] | undefined,
    limit: number
  ): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(sql`
      select distinct m.user_id
        from core.merchant_members m
        join core.merchants mc on mc.id = m.merchant_id and mc.status = 'active'
        join core.users u on u.id = m.user_id and u.status = 'active'
       where m.status = 'active' and m.role in ('owner', 'admin')
         and (${merchantIds === undefined}::boolean
              or m.merchant_id in (select (jsonb_array_elements_text(${JSON.stringify(merchantIds ?? [])}::jsonb))::uuid))
       limit ${limit}`);
    return result.rows.map((r) => r.user_id);
  }

  emailOf(userId: string, tx: Executor = this.db): Promise<string | undefined> {
    return tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0]?.email);
  }

  // -- notifications -----------------------------------------------------------------------

  /** True when this recipient got this template for this resource since `since`. */
  async existsSince(
    tx: Executor,
    recipientId: string,
    templateCode: string,
    resourceKey: string,
    since: Date
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          eq(notifications.templateCode, templateCode),
          eq(notifications.resourceKey, resourceKey),
          gte(notifications.createdAt, since)
        )
      )
      .limit(1);
    return row !== undefined;
  }

  /** Inserts; returns undefined when the `source_key` already exists (the same fact twice). */
  async insertNotification(
    tx: Executor,
    values: typeof notifications.$inferInsert
  ): Promise<NotificationRow | undefined> {
    const [row] = await tx
      .insert(notifications)
      .values(values)
      .onConflictDoNothing({ target: notifications.sourceKey })
      .returning();
    return row;
  }

  async insertDelivery(tx: Executor, values: typeof notificationDeliveries.$inferInsert) {
    const [row] = await tx.insert(notificationDeliveries).values(values).returning();
    if (!row) throw new Error('delivery insert returned no row');
    return row;
  }

  inbox(
    userId: string,
    filter: { unreadOnly: boolean; after?: CursorKey; limit: number }
  ): Promise<NotificationRow[]> {
    const conditions: SQL[] = [
      eq(notifications.recipientId, userId),
      eq(notifications.channel, 'in_app'),
    ];
    if (filter.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (filter.after) {
      const keyset = or(
        lt(notifications.createdAt, filter.after.createdAt),
        and(
          eq(notifications.createdAt, filter.after.createdAt),
          lt(notifications.ref, filter.after.id)
        )
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.ref))
      .limit(filter.limit + 1);
  }

  async unreadCount(userId: string): Promise<number> {
    const result = await this.db.execute<{ n: string }>(sql`
      select count(*)::text as n from core.notifications
       where recipient_id = ${userId} and channel = 'in_app' and read_at is null`);
    return Number(result.rows[0]?.n ?? 0);
  }

  async markRead(tx: Executor, userId: string, ref: string, now: Date): Promise<boolean> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.ref, ref),
          eq(notifications.recipientId, userId),
          eq(notifications.channel, 'in_app'),
          isNull(notifications.readAt)
        )
      )
      .returning({ id: notifications.id });
    return rows.length > 0;
  }

  async exists(userId: string, ref: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.ref, ref),
          eq(notifications.recipientId, userId),
          eq(notifications.channel, 'in_app')
        )
      )
      .limit(1);
    return row !== undefined;
  }

  async markAllRead(tx: Executor, userId: string, now: Date): Promise<number> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.recipientId, userId),
          eq(notifications.channel, 'in_app'),
          isNull(notifications.readAt)
        )
      )
      .returning({ id: notifications.id });
    return rows.length;
  }

  // -- deliveries --------------------------------------------------------------------------

  /**
   * Locks a pending delivery for one attempt; undefined when it is final, being worked (its claim
   * has not lapsed) or not yet due. A claim moves `next_attempt_at` forward by the lease, so a second
   * worker that arrives after the first one's claim committed finds the delivery not due.
   */
  async lockPending(
    tx: Executor,
    id: string,
    createdAt: Date,
    now: Date
  ): Promise<
    (DeliveryRow & { title: string | null; body: string; notificationRef: string }) | undefined
  > {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select d.*, n.title as n_title, n.body as n_body, n.ref as n_ref
        from core.notification_deliveries d
        join core.notifications n on n.id = d.notification_id
       where d.id = ${id} and d.created_at = ${createdAt} and d.status = 'pending'
         and (d.next_attempt_at is null or d.next_attempt_at <= ${now})
       for update of d skip locked`);
    const r = result.rows[0];
    if (!r) return undefined;
    return {
      id: r.id as string,
      ref: r.ref as string,
      notificationId: r.notification_id as string,
      recipientId: r.recipient_id as string,
      templateCode: r.template_code as string,
      channel: r.channel as string,
      provider: (r.provider as string | null) ?? null,
      providerMessageId: (r.provider_message_id as string | null) ?? null,
      status: r.status as string,
      error: (r.error as string | null) ?? null,
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at as string) : null,
      lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at as string) : null,
      sentAt: r.sent_at ? new Date(r.sent_at as string) : null,
      deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
      title: (r.n_title as string | null) ?? null,
      body: r.n_body as string,
      notificationRef: r.n_ref as string,
    };
  }

  async updateDelivery(
    tx: Executor,
    id: string,
    createdAt: Date,
    patch: Partial<typeof notificationDeliveries.$inferInsert>
  ): Promise<void> {
    await tx
      .update(notificationDeliveries)
      .set(patch)
      .where(
        and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.createdAt, createdAt))
      );
  }

  /** Pending deliveries whose attempt time passed: the recovery sweep re-queues them. */
  async stalePending(
    now: Date,
    graceMs: number,
    since: Date,
    limit: number
  ): Promise<Array<{ id: string; createdAt: Date; attempts: number }>> {
    const rows = await this.db
      .select({
        id: notificationDeliveries.id,
        createdAt: notificationDeliveries.createdAt,
        attempts: notificationDeliveries.attempts,
      })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.status, 'pending'),
          gte(notificationDeliveries.createdAt, since),
          lte(notificationDeliveries.nextAttemptAt, new Date(now.getTime() - graceMs))
        )
      )
      .orderBy(notificationDeliveries.nextAttemptAt)
      .limit(limit);
    return rows;
  }

  deliveryLog(filter: DeliveryFilter): Promise<DeliveryRow[]> {
    const conditions: SQL[] = [
      gte(notificationDeliveries.createdAt, filter.from),
      lte(notificationDeliveries.createdAt, filter.to),
    ];
    if (filter.status) conditions.push(eq(notificationDeliveries.status, filter.status));
    if (filter.channel) conditions.push(eq(notificationDeliveries.channel, filter.channel));
    if (filter.after) {
      const keyset = or(
        lt(notificationDeliveries.createdAt, filter.after.createdAt),
        and(
          eq(notificationDeliveries.createdAt, filter.after.createdAt),
          lt(notificationDeliveries.ref, filter.after.id)
        )
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(and(...conditions))
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.ref))
      .limit(filter.limit + 1);
  }

  /** Pending and failed counts per channel over the last day, for gauges and the ops overview. */
  async deliveryCounts(
    since: Date
  ): Promise<Array<{ channel: string; status: string; n: number }>> {
    const result = await this.db.execute<{ channel: string; status: string; n: string }>(sql`
      select channel, status, count(*)::text as n from core.notification_deliveries
       where created_at >= ${since} and status in ('pending', 'failed')
       group by channel, status`);
    return result.rows.map((r) => ({ channel: r.channel, status: r.status, n: Number(r.n) }));
  }
}
