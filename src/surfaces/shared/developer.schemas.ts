/**
 * Request schema pieces for the developer platform routes (events, webhook endpoints and
 * deliveries, request logs, balances, holds), shared by the public and dashboard surfaces.
 * Strict by default (spec 11): an unknown property is a 400.
 */
import { z } from 'zod';
import { MAX_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { ALL_EVENTS, MERCHANT_EVENT_TYPES } from '../../modules/events/domain/event-types';
import { MAX_SECRET_GRACE_HOURS } from '../../modules/webhooks/webhook-endpoints.service';
import { dateTimeSchema, environmentSchema } from './payment.schemas';
import { currencySchema } from './schemas';

export const eventTypeSchema = z.enum(MERCHANT_EVENT_TYPES);

export const listEventsSchema = z.strictObject({
  type: eventTypeSchema.optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

export const listBalanceTransactionsSchema = z.strictObject({
  currency: currencySchema.optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

export const listHoldsSchema = z.strictObject({
  state: z.enum(['active', 'captured', 'released', 'expired']).optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

const enabledEventsSchema = z
  .array(z.union([eventTypeSchema, z.literal(ALL_EVENTS)]))
  .min(1)
  .max(MERCHANT_EVENT_TYPES.length + 1);

export const createWebhookEndpointSchema = z.strictObject({
  url: z.string().min(10).max(2048),
  description: z.string().trim().min(1).max(200).optional(),
  enabledEvents: enabledEventsSchema,
});

export const updateWebhookEndpointSchema = z
  .strictObject({
    url: z.string().min(10).max(2048).optional(),
    description: z.string().trim().min(1).max(200).nullable().optional(),
    enabledEvents: enabledEventsSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const rotateSecretSchema = z.strictObject({
  graceHours: z.number().int().min(0).max(MAX_SECRET_GRACE_HOURS).default(24),
});

/** The dashboard picks the environment per request; API keys carry it. */
export const environmentQuerySchema = z.strictObject({
  environment: environmentSchema.default('live'),
});

export const listWebhookDeliveriesSchema = z.strictObject({
  environment: environmentSchema.default('live'),
  endpoint: z.string().min(1).max(64).optional(),
  eventType: eventTypeSchema.optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'exhausted']).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

export const replayDeliveriesSchema = z.strictObject({
  endpoint: z.string().min(1).max(64).optional(),
  eventType: eventTypeSchema.optional(),
  statuses: z
    .array(z.enum(['succeeded', 'failed', 'exhausted']))
    .min(1)
    .max(3)
    .default(['failed', 'exhausted']),
  from: dateTimeSchema,
  to: dateTimeSchema,
});

export const listRequestLogsSchema = z.strictObject({
  environment: environmentSchema.default('live'),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  requestId: z.string().min(1).max(128).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});
