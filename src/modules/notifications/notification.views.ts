/** What notifications look like on the API (spec 7.2, 7.3). Delivery details are staff-only. */
import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../../db/schema';
import type {
  DeliveryRow,
  DestinationRow,
  NotificationRow,
  TemplateRow,
} from './notifications.repository';

const iso = z.string();
const channel = z.enum(NOTIFICATION_CHANNELS);

export const inAppNotificationSchema = z.object({
  id: z.string(),
  template: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  data: z.record(z.string(), z.string()),
  read: z.boolean(),
  readAt: iso.nullable(),
  createdAt: iso,
});
export const inAppNotificationPageSchema = z.object({
  items: z.array(inAppNotificationSchema),
  nextCursor: z.string().nullable(),
});
export const unreadCountSchema = z.object({ unread: z.number().int() });
export const readAllSchema = z.object({ marked: z.number().int() });
export const markedReadSchema = z.object({ read: z.literal(true) });

export const preferenceSchema = z.object({
  template: z.string(),
  channel,
  enabled: z.boolean(),
});
export const preferencesSchema = z.object({ items: z.array(preferenceSchema) });

export const destinationSchema = z.object({
  channel: z.enum(['sms', 'push']),
  hint: z.string(),
  updatedAt: iso,
});
export const destinationsSchema = z.object({ items: z.array(destinationSchema) });

export const templateSchema = z.object({
  code: z.string(),
  channel,
  locale: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  mandatory: z.boolean(),
  audience: z.enum(['staff', 'merchant', 'any']),
  version: z.number().int(),
  active: z.boolean(),
  updatedAt: iso,
});
export const templatesSchema = z.object({ items: z.array(templateSchema) });

export const deliverySchema = z.object({
  id: z.string(),
  template: z.string(),
  channel,
  provider: z.string().nullable(),
  status: z.enum(['pending', 'sent', 'delivered', 'failed']),
  error: z.string().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: iso.nullable(),
  lastAttemptAt: iso.nullable(),
  sentAt: iso.nullable(),
  createdAt: iso,
});
export const deliveryPageSchema = z.object({
  items: z.array(deliverySchema),
  nextCursor: z.string().nullable(),
});
export const broadcastResultSchema = z.object({
  recipients: z.number().int(),
  created: z.number().int(),
  deduplicated: z.number().int(),
});

export const toInAppNotification = (
  n: NotificationRow
): z.infer<typeof inAppNotificationSchema> => ({
  id: n.ref,
  template: n.templateCode,
  title: n.title,
  body: n.body,
  data: n.data,
  read: n.readAt !== null,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

export const toDestination = (d: DestinationRow): z.infer<typeof destinationSchema> => ({
  channel: d.channel as 'sms' | 'push',
  hint: d.addressHint,
  updatedAt: d.updatedAt.toISOString(),
});

export const toTemplate = (t: TemplateRow): z.infer<typeof templateSchema> => ({
  code: t.code,
  channel: t.channel as z.infer<typeof templateSchema>['channel'],
  locale: t.locale,
  subject: t.subject,
  body: t.body,
  variables: t.variables,
  mandatory: t.mandatory,
  audience: t.audience as 'staff' | 'merchant' | 'any',
  version: t.version,
  active: t.active,
  updatedAt: t.updatedAt.toISOString(),
});

export const toDelivery = (d: DeliveryRow): z.infer<typeof deliverySchema> => ({
  id: d.ref,
  template: d.templateCode,
  channel: d.channel as z.infer<typeof deliverySchema>['channel'],
  provider: d.provider,
  status: d.status as z.infer<typeof deliverySchema>['status'],
  error: d.error,
  attempts: d.attempts,
  nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
  lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
  sentAt: d.sentAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});
