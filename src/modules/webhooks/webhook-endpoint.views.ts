/** Merchant-facing webhook endpoint. Ciphertexts and internal ids never leave. */
import { z } from 'zod';
import type { WebhookEndpointRow } from './webhook-endpoints.repository';

export const webhookEndpointSchema = z.object({
  id: z.string(),
  environment: z.enum(['test', 'live']),
  url: z.string(),
  description: z.string().nullable(),
  enabledEvents: z.array(z.string()),
  status: z.enum(['active', 'disabled', 'auto_disabled']),
  failureCount: z.number().int(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type WebhookEndpointView = z.infer<typeof webhookEndpointSchema>;

/** Create and rotate return the signing secret, once. */
export const createdWebhookEndpointSchema = webhookEndpointSchema.extend({ secret: z.string() });
export type CreatedWebhookEndpointView = z.infer<typeof createdWebhookEndpointSchema>;

export function toWebhookEndpointView(row: WebhookEndpointRow): WebhookEndpointView {
  return {
    id: row.ref,
    environment: row.environment as WebhookEndpointView['environment'],
    url: row.url,
    description: row.description,
    enabledEvents: row.enabledEvents,
    status: row.status as WebhookEndpointView['status'],
    failureCount: row.failureCount,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
