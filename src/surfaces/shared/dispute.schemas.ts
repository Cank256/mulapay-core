/** Request shapes of the dispute routes (dashboard and admin). Strict by default. */
import { z } from 'zod';
import { DISPUTE_KINDS, DISPUTE_OUTCOMES } from '../../modules/disputes/domain/dispute-state';
import { refSchema } from './schemas';

const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(25);
const cursor = z.string().min(1).max(512).optional();
const dateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const minor = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, 'must be a positive integer in minor units')
  .transform((v) => BigInt(v));

export const disputeListQuerySchema = z.strictObject({
  status: z.enum(['open', 'under_review', 'resolved']).optional(),
  limit: limit(100),
  cursor,
});
export const adminDisputeListQuerySchema = z.strictObject({
  status: z.enum(['open', 'under_review', 'resolved']).optional(),
  merchant: refSchema.optional(),
  limit: limit(200),
  cursor,
});
export const evidenceBodySchema = z.strictObject({ text: z.string().trim().min(1).max(2000) });

export const openDisputeSchema = z.strictObject({
  merchant: refSchema,
  transaction: refSchema,
  kind: z.enum(DISPUTE_KINDS),
  amountMinor: minor,
  reasonCode: z.string().trim().min(1).max(64),
  evidenceDueAt: dateTime.optional(),
  internalNote: z.string().trim().min(1).max(2000).optional(),
});
export const patchDisputeSchema = z.strictObject({
  status: z.literal('under_review').optional(),
  evidenceDueAt: dateTime.nullable().optional(),
  internalNote: z.string().trim().min(1).max(2000).optional(),
});
export const resolveDisputeSchema = z.strictObject({
  outcome: z.enum(DISPUTE_OUTCOMES),
  note: z.string().trim().min(1).max(2000),
  /** Lets a lost dispute take the merchant's balance below zero. Audited. */
  acceptDeficit: z.boolean().optional(),
});
