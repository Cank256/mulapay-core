/**
 * DTOs for fee-related responses (Phase 4).
 *
 * These are not exposed in external APIs but used internally and in admin/dashboard
 * surfaces for fee breakdown display.
 */
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Fee breakdown response showing how a fee was calculated.
 * Amounts are decimal strings (converted from bigint at the edge).
 */
export const FeeBreakdownSchema = z.object({
  merchantFee: z.string().describe('Fee charged to merchant (decimal string, e.g. "2.50")'),
  platformFee: z.string().describe('Platform revenue (currently equals merchantFee)'),
  providerFee: z.string().describe('Provider fee (currently always "0")'),
  netAmount: z.string().describe('Amount after fees'),
  appliedRule: z
    .object({
      feePlanRef: z.string().describe('Fee plan reference (fp_...)'),
      ruleId: z.string().describe('Rule ID (uuid)'),
      percentBps: z.number().describe('Percentage in basis points (10000 = 100%)'),
      fixedAmount: z.string().describe('Fixed fee (decimal string)'),
      minAmount: z.string().describe('Minimum fee (decimal string)'),
      maxAmount: z.string().describe('Maximum fee, 0 = no max (decimal string)'),
      tierThreshold: z.string().describe('Tier threshold (decimal string)'),
    })
    .nullable()
    .describe('Rule that was applied (null if zero fees)'),
});

export class FeeBreakdownDto extends createZodDto(FeeBreakdownSchema) {}

/**
 * Fee plan summary (for listing).
 */
export const FeePlanSummarySchema = z.object({
  ref: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  version: z.number(),
  active: z.boolean(),
  ruleCount: z.number().describe('Number of active rules in this plan'),
});

export class FeePlanSummaryDto extends createZodDto(FeePlanSummarySchema) {}

/**
 * Fee plan detail (for admin view).
 */
export const FeePlanDetailSchema = FeePlanSummarySchema.extend({
  rules: z.array(
    z.object({
      id: z.string(),
      operationType: z.enum(['payment', 'payout', 'refund']),
      provider: z.string().nullable(),
      currency: z.string().nullable(),
      channel: z.string().nullable(),
      percentBps: z.number(),
      fixedAmount: z.string(),
      minAmount: z.string(),
      maxAmount: z.string(),
      tierThreshold: z.string(),
      priority: z.number(),
    })
  ),
});

export class FeePlanDetailDto extends createZodDto(FeePlanDetailSchema) {}
