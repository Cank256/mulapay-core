/** The merchant-facing shape of an event, in the feed and in webhook payloads. */
import { z } from 'zod';
import { MERCHANT_EVENT_TYPES } from './domain/event-types';
import type { MerchantEventRow } from './merchant-events.repository';

export const merchantEventSchema = z.object({
  id: z.string(),
  type: z.enum(MERCHANT_EVENT_TYPES),
  environment: z.enum(['test', 'live']),
  resourceType: z.string(),
  resourceId: z.string(),
  createdAt: z.iso.datetime(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type MerchantEventView = z.infer<typeof merchantEventSchema>;

export const merchantEventPageSchema = z.object({
  items: z.array(merchantEventSchema),
  nextCursor: z.string().nullable(),
});

export function toMerchantEventView(row: MerchantEventRow): MerchantEventView {
  const payload = row.payload as { object?: Record<string, unknown> };
  return {
    id: row.ref,
    type: row.type as MerchantEventView['type'],
    environment: row.environment as MerchantEventView['environment'],
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    createdAt: row.createdAt.toISOString(),
    data: { object: payload.object ?? {} },
  };
}
