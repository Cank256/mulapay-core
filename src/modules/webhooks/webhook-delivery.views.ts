/** Merchant-facing webhook delivery log entry. Internal ids and the lease never leave. */
import { z } from 'zod';
import type { WebhookDeliveryRow } from './webhook-deliveries.repository';

export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  environment: z.enum(['test', 'live']),
  status: z.enum(['pending', 'succeeded', 'failed', 'exhausted']),
  attempts: z.number().int(),
  httpStatus: z.number().int().nullable(),
  responseMs: z.number().int().nullable(),
  responseBodyExcerpt: z.string().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  replayOf: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type WebhookDeliveryView = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveryPageSchema = z.object({
  items: z.array(webhookDeliverySchema),
  nextCursor: z.string().nullable(),
});

export const replayResultSchema = z.object({
  replayed: z.number().int(),
  /** True when more deliveries matched than one request replays; send it again. */
  truncated: z.boolean(),
});

export function toWebhookDeliveryView(
  row: WebhookDeliveryRow,
  refs: { readonly endpoint: string; readonly event: string }
): WebhookDeliveryView {
  return {
    id: row.ref,
    endpointId: refs.endpoint,
    eventId: refs.event,
    eventType: row.eventType,
    environment: row.environment as WebhookDeliveryView['environment'],
    status: row.status as WebhookDeliveryView['status'],
    attempts: row.attempt,
    httpStatus: row.httpStatus,
    responseMs: row.responseMs,
    responseBodyExcerpt: row.responseBodyExcerpt,
    error: row.error,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    replayOf: row.replayOfRef,
    createdAt: row.createdAt.toISOString(),
  };
}
