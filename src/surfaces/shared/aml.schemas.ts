/** Request and response shapes of the AML routes (admin). Strict by default. */
import { z } from 'zod';
import { RULE_TYPES } from '../../modules/aml/domain/rule-params';
import { refSchema } from './schemas';

const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(25);
const cursor = z.string().min(1).max(512).optional();
const dateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const iso = z.string();
const note = z.string().trim().min(1).max(2000);

export const refParam = z.strictObject({ ref: refSchema });
export const codeParam = z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/) });

// ---- alerts ----
export const alertStatusSchema = z.enum([
  'open',
  'investigating',
  'escalated',
  'closed_false_positive',
  'closed_confirmed',
]);
export const alertListQuerySchema = z.strictObject({
  status: alertStatusSchema.optional(),
  severity: severity.optional(),
  merchant: refSchema.optional(),
  assignee: refSchema.optional(),
  rule: z.string().max(64).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: limit(200),
  cursor,
});
export const alertSchema = z.object({
  id: z.string(),
  rule: z.string(),
  ruleVersion: z.number().int(),
  severity,
  merchant: z.string(),
  transaction: z.string().nullable(),
  score: z.number().int(),
  status: alertStatusSchema,
  action: z.enum(['flag', 'hold', 'block']),
  details: z.record(z.string(), z.unknown()),
  assignedTo: z.string().nullable(),
  dueAt: iso,
  overdue: z.boolean(),
  escalatedAt: iso.nullable(),
  escalationReason: z.enum(['manual', 'sla_breach']).nullable(),
  resolvedAt: iso.nullable(),
  resolutionNote: z.string().nullable(),
  hold: z.string().nullable(),
  case: z.string().nullable(),
  createdAt: iso,
});
export const alertPageSchema = z.object({
  items: z.array(alertSchema),
  nextCursor: z.string().nullable(),
});
export const assignAlertSchema = z.strictObject({ assignee: refSchema });
export const escalateAlertSchema = z.strictObject({ note: note.optional() });
export const resolveAlertSchema = z.strictObject({
  outcome: z.enum(['closed_false_positive', 'closed_confirmed']),
  note,
  /** Defaults to releasing the hold for a false positive and keeping it when confirmed. */
  releaseHold: z.boolean().optional(),
});

// ---- cases ----
export const caseOutcomeSchema = z.enum([
  'no_action',
  'false_positive',
  'suspicious_activity_reported',
  'merchant_blocked',
  'merchant_offboarded',
]);
export const caseListQuerySchema = z.strictObject({
  status: z.enum(['open', 'investigating', 'closed']).optional(),
  merchant: refSchema.optional(),
  assignee: refSchema.optional(),
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: limit(200),
  cursor,
});
export const caseSchema = z.object({
  id: z.string(),
  merchant: z.string(),
  status: z.enum(['open', 'investigating', 'closed']),
  severity,
  title: z.string(),
  summary: z.string(),
  source: z.enum(['screening', 'alert', 'manual']),
  assignedTo: z.string().nullable(),
  outcome: caseOutcomeSchema.nullable(),
  closedAt: iso.nullable(),
  strReference: z.string().nullable(),
  strFiledAt: iso.nullable(),
  createdAt: iso,
});
export const casePageSchema = z.object({
  items: z.array(caseSchema),
  nextCursor: z.string().nullable(),
});
export const caseDetailSchema = caseSchema.extend({
  alerts: z.array(alertSchema),
  notes: z.array(z.object({ at: iso, author: z.string().nullable(), body: z.string() })),
  strPackages: z.array(
    z.object({ id: z.string(), sha256: z.string(), sizeBytes: z.number().int(), createdAt: iso })
  ),
  history: z.array(
    z.object({ seq: z.number().int(), at: iso, action: z.string(), actor: z.string().nullable() })
  ),
});
export const createCaseSchema = z.strictObject({
  merchant: refSchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(5000).optional(),
  severity,
  alerts: z.array(refSchema).max(100).optional(),
});
export const patchCaseSchema = z.strictObject({
  assignee: refSchema.nullable().optional(),
  status: z.enum(['investigating', 'closed']).optional(),
  outcome: caseOutcomeSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(5000).optional(),
  severity: severity.optional(),
  note: note.optional(),
  addAlerts: z.array(refSchema).min(1).max(100).optional(),
  strReference: z.string().trim().min(1).max(100).optional(),
});
export const strResultSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  alertCount: z.number().int(),
  downloadUrl: z.string(),
  expiresAt: iso,
});

// ---- screenings ----
export const screeningSchema = z.object({
  id: z.string(),
  merchant: z.string().nullable(),
  subjectType: z.enum(['merchant', 'director', 'ubo', 'customer', 'counterparty']),
  subject: z.string(),
  provider: z.string(),
  lists: z.array(z.string()),
  hitCount: z.number().int(),
  highestScore: z.number().nullable(),
  status: z.enum(['clear', 'potential_match', 'confirmed_match']),
  hits: z.array(
    z.object({
      entityId: z.string(),
      caption: z.string(),
      score: z.number(),
      categories: z.array(z.string()),
      datasets: z.array(z.string()),
    })
  ),
  screenedAt: iso,
  reviewedAt: iso.nullable(),
  reviewNote: z.string().nullable(),
  case: z.string().nullable(),
});
export const screeningPageSchema = z.object({
  items: z.array(screeningSchema),
  nextCursor: z.string().nullable(),
});
export const screeningListQuerySchema = z.strictObject({
  status: z.enum(['clear', 'potential_match', 'confirmed_match']).optional(),
  merchant: refSchema.optional(),
  subjectType: z.enum(['merchant', 'director', 'ubo', 'customer', 'counterparty']).optional(),
  limit: limit(200),
  cursor,
});
export const adHocScreeningSchema = z.strictObject({
  subjectType: z.enum(['merchant', 'director', 'ubo', 'customer', 'counterparty']),
  /** A ref that names the subject without naming the person: a merchant ref, a customer ref. */
  subjectId: z.string().trim().min(1).max(64),
  merchant: refSchema.optional(),
  entityType: z.enum(['person', 'organization']),
  name: z.string().trim().min(2).max(300),
  birthDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
export const decideScreeningSchema = z.strictObject({
  decision: z.enum(['clear', 'confirm']),
  note,
});

// ---- rules ----
export const ruleSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  ruleType: z.enum(RULE_TYPES as [string, ...string[]]),
  params: z.record(z.string(), z.unknown()),
  severity,
  action: z.enum(['flag', 'hold', 'block']),
  enabled: z.boolean(),
  version: z.number().int(),
  effectiveFrom: iso,
  effectiveTo: iso.nullable(),
  updatedAt: iso,
});
export const ruleListSchema = z.object({ items: z.array(ruleSchema) });
export const createRuleSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  ruleType: z.enum(RULE_TYPES as [string, ...string[]]),
  params: z.record(z.string(), z.unknown()),
  severity,
  action: z.enum(['flag', 'hold', 'block']),
  enabled: z.boolean().optional(),
  effectiveFrom: dateTime.optional(),
  effectiveTo: dateTime.nullable().optional(),
});
export const patchRuleSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  severity: severity.optional(),
  action: z.enum(['flag', 'hold', 'block']).optional(),
  enabled: z.boolean().optional(),
  effectiveFrom: dateTime.optional(),
  effectiveTo: dateTime.nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

// ---- blocklist and blocks ----
export const blocklistEntrySchema = z.object({
  id: z.string(),
  type: z.enum(['msisdn', 'email', 'account', 'bin', 'device', 'name']),
  hint: z.string(),
  reason: z.string(),
  source: z.string(),
  expiresAt: iso.nullable(),
  removedAt: iso.nullable(),
  createdAt: iso,
});
export const blocklistPageSchema = z.object({
  items: z.array(blocklistEntrySchema),
  nextCursor: z.string().nullable(),
});
export const blocklistQuerySchema = z.strictObject({
  type: z.enum(['msisdn', 'email', 'account', 'bin', 'device', 'name']).optional(),
  includeRemoved: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: limit(200),
  cursor,
});
export const addBlocklistSchema = z.strictObject({
  type: z.enum(['msisdn', 'email', 'account', 'bin', 'device', 'name']),
  value: z.string().trim().min(1).max(320),
  reason: z.string().trim().min(1).max(500),
  expiresAt: dateTime.optional(),
});

export const blockSchema = z.object({
  id: z.string(),
  merchant: z.string(),
  status: z.enum(['active', 'lifted']),
  reason: z.string(),
  source: z.enum(['rule', 'case', 'manual']),
  heldCurrencies: z.array(z.string()),
  createdAt: iso,
  liftedAt: iso.nullable(),
  created: z.boolean().optional(),
});
export const blockListSchema = z.object({ items: z.array(blockSchema) });
export const blockQuerySchema = z.strictObject({
  merchant: refSchema.optional(),
  status: z.enum(['active', 'lifted']).optional(),
  limit: limit(200),
});
export const createBlockSchema = z.strictObject({
  merchant: refSchema,
  reason: z.string().trim().min(1).max(500),
});
export const liftBlockSchema = z.strictObject({ note });
