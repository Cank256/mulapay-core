/**
 * Zod schemas for refund request/response DTOs.
 */
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// Request schemas
export const CreateRefundBodySchema = z.object({
  paymentId: z.string().uuid(),
  amountMinor: z
    .union([z.string(), z.number(), z.bigint()])
    .transform((val) => BigInt(val)),
  reason: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string()).optional(),
});

export class CreateRefundBodyDto extends createZodDto(CreateRefundBodySchema) {}

export const RefundListQuerySchema = z.object({
  status: z
    .enum(['created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled'])
    .optional(),
  currency: z.string().length(3).optional(),
  paymentRef: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().optional(),
});

export class RefundListQueryDto extends createZodDto(RefundListQuerySchema) {}

// Response schemas (for OpenAPI documentation)
export const RefundViewSchema = z.object({
  id: z.string(),
  ref: z.string(),
  transactionRef: z.string(),
  merchantId: z.string(),
  environment: z.enum(['test', 'live']),
  paymentId: z.string(),
  paymentRef: z.string(),
  amountMinor: z.string(),
  currency: z.string(),
  status: z.enum([
    'created',
    'pending_approval',
    'processing',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  reason: z.string().nullable(),
  metadata: z.record(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class RefundViewDto extends createZodDto(RefundViewSchema) {}

export const RefundListResponseSchema = z.object({
  data: z.array(RefundViewSchema),
  pagination: z.object({
    limit: z.number(),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export class RefundListResponseDto extends createZodDto(RefundListResponseSchema) {}
