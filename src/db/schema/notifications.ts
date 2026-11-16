/**
 * Notifications (spec 5.2, 6.12, Phase 8): templates, preferences, one `notifications` row per
 * recipient, template and channel (the in-app inbox is the `in_app` rows), and a delivery log
 * per row. Partitioned monthly on `created_at` (spec 5.1): `notification_deliveries` only
 * (hand edit in migration 0008, like `webhook_deliveries`), so every query on it carries a
 * `created_at` bound; its ref embeds the creation time, so a lookup by ref reads one partition.
 *
 * Deduplication (spec 6.12): a notification for the same (recipient, template, resource) within
 * five minutes is not created again. `source_key` makes the creation of one notification idempotent
 * for an outbox row that is handled twice.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';

export const NOTIFICATION_CHANNELS = ['email', 'sms', 'push', 'in_app'] as const;
export const RECIPIENT_TYPES = ['user', 'merchant', 'admin_group'] as const;
export const DELIVERY_STATUSES = ['pending', 'sent', 'delivered', 'failed'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** One template per (code, channel, locale). Spec 5.2 says `code unique`, but a code is sent on several channels. */
export const notificationTemplates = core.table(
  'notification_templates',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    channel: text('channel').notNull(),
    locale: text('locale').notNull().default('en'),
    /** Email subject, push and in-app title. SMS has none. */
    subject: text('subject'),
    /** `{{name}}` placeholders; every one must be in `variables`. */
    body: text('body').notNull(),
    variables: jsonb('variables').$type<string[]>().notNull().default([]),
    /** A mandatory template (security, a breached SLA) ignores the recipient's preferences. */
    mandatory: boolean('mandatory').notNull().default(false),
    /** `staff` templates are for the admin console, `merchant` for the dashboard, `any` for either. */
    audience: text('audience').notNull(),
    version: integer('version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_templates_key').on(t.code, t.channel, t.locale),
    index('notification_templates_code_idx')
      .on(t.code)
      .where(sql`${t.active}`),
    check('notification_templates_code_check', sql`${t.code} ~ '^[a-z][a-z0-9_.]{2,80}$'`),
    check(
      'notification_templates_channel_check',
      sql`${t.channel} in (${list(NOTIFICATION_CHANNELS)})`
    ),
    check(
      'notification_templates_audience_check',
      sql`${t.audience} in ('staff', 'merchant', 'any')`
    ),
    check('notification_templates_body_check', sql`char_length(${t.body}) between 1 and 5000`),
    check(
      'notification_templates_subject_check',
      sql`${t.subject} is null or char_length(${t.subject}) between 1 and 200`
    ),
    // Email and push need a title; SMS has none.
    check(
      'notification_templates_subject_channel_check',
      sql`${t.channel} not in ('email', 'push', 'in_app') or ${t.subject} is not null`
    ),
  ]
);

/** `template_code = '*'` is the channel-wide preference. A specific row wins over it. */
export const notificationPreferences = core.table(
  'notification_preferences',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    templateCode: text('template_code').notNull(),
    channel: text('channel').notNull(),
    enabled: boolean('enabled').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_preferences_key').on(t.userId, t.templateCode, t.channel),
    check(
      'notification_preferences_channel_check',
      sql`${t.channel} in (${list(NOTIFICATION_CHANNELS)})`
    ),
  ]
);

/** Where a user receives SMS and push. The address is encrypted; one per user and channel. */
export const notificationDestinations = core.table(
  'notification_destinations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: text('channel').notNull(),
    /** AES-256-GCM (FieldEncryption), bound to the row id. A phone number or a push token. */
    addressEnc: text('address_enc').notNull(),
    /** The last four characters, for display. */
    addressHint: text('address_hint').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_destinations_key').on(t.userId, t.channel),
    check('notification_destinations_channel_check', sql`${t.channel} in ('sms', 'push')`),
  ]
);

export const notifications = core.table(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    /** Stored rows are per user: a merchant or admin-group audience is expanded before insert. */
    recipientType: text('recipient_type').notNull().default('user'),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id),
    channel: text('channel').notNull(),
    templateCode: text('template_code').notNull(),
    /** What the notification is about (a complaint ref, a dispute ref). The dedupe subject. */
    resourceKey: text('resource_key').notNull(),
    /** Makes creating this notification idempotent: `{source}:{recipient}:{template}:{channel}`. */
    sourceKey: text('source_key'),
    title: text('title'),
    body: text('body').notNull(),
    data: jsonb('data').$type<Record<string, string>>().notNull().default({}),
    readAt: timestamptz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_ref_key').on(t.ref),
    uniqueIndex('notifications_source_key').on(t.sourceKey),
    index('notifications_inbox_idx')
      .on(t.recipientId, t.createdAt.desc(), t.ref.desc())
      .where(sql`${t.channel} = 'in_app'`),
    index('notifications_unread_idx')
      .on(t.recipientId)
      .where(sql`${t.channel} = 'in_app' and ${t.readAt} is null`),
    index('notifications_dedupe_idx').on(
      t.recipientId,
      t.templateCode,
      t.resourceKey,
      t.createdAt.desc()
    ),
    check('notifications_ref_check', sql`${t.ref} ~ '^ntf_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('notifications_channel_check', sql`${t.channel} in (${list(NOTIFICATION_CHANNELS)})`),
    check(
      'notifications_recipient_type_check',
      sql`${t.recipientType} in (${list(RECIPIENT_TYPES)})`
    ),
    check('notifications_read_check', sql`${t.readAt} is null or ${t.channel} = 'in_app'`),
  ]
);

/** Partitioned by month on `created_at` (hand edit in migration 0008). */
export const notificationDeliveries = core.table(
  'notification_deliveries',
  {
    id: uuid('id').notNull(),
    ref: text('ref').notNull(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id),
    templateCode: text('template_code').notNull(),
    channel: text('channel').notNull(),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull().default('pending'),
    /** A short code (`provider_unavailable`, `invalid_address`), never a provider payload. */
    error: text('error'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    lastAttemptAt: timestamptz('last_attempt_at'),
    sentAt: timestamptz('sent_at'),
    deliveredAt: timestamptz('delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex('notification_deliveries_ref_key').on(t.ref, t.createdAt),
    uniqueIndex('notification_deliveries_notification_key').on(t.notificationId, t.createdAt),
    index('notification_deliveries_pending_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('notification_deliveries_log_idx').on(t.status, t.channel, t.createdAt.desc()),
    index('notification_deliveries_recipient_idx').on(t.recipientId, t.createdAt.desc()),
    check(
      'notification_deliveries_channel_check',
      sql`${t.channel} in ('email', 'sms', 'push', 'in_app')`
    ),
    check('notification_deliveries_status_check', sql`${t.status} in (${list(DELIVERY_STATUSES)})`),
    check('notification_deliveries_attempts_check', sql`${t.attempts} >= 0`),
  ]
);
