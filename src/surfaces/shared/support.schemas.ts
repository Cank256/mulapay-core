/** Request shapes of the Phase 8 support and operations routes. Strict by default. */
import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/cursor';
import { COMPLAINT_PRIORITIES, COMPLAINT_STATUSES } from '../../db/schema';
import {
  INCIDENT_SERVICES,
  INCIDENT_STATUSES,
  SEVERITIES,
} from '../../modules/incidents/domain/incident-rules';
import { REPORT_TYPES } from '../../modules/reports/domain/report-params';
import { refSchema } from './schemas';

const page = (max: number) => pageQuerySchema(max);
const text = (max: number) => z.string().trim().min(1).max(max);
const environment = z.enum(['test', 'live']).default('live');
const minorString = z
  .string()
  .regex(/^\d{1,18}$/, 'must be a non-negative integer in minor units')
  .transform((v) => BigInt(v));

// -- complaints -----------------------------------------------------------------------------

export const fileComplaintSchema = z.strictObject({
  category: z.string().min(1).max(41),
  subject: text(200),
  description: text(5000),
  transaction: refSchema.optional(),
  priority: z.enum(COMPLAINT_PRIORITIES).optional(),
});
export const recordComplaintSchema = fileComplaintSchema.extend({
  source: z.enum(['merchant', 'customer', 'admin']),
  merchant: refSchema.optional(),
  customerContact: text(254).optional(),
});
export const merchantComplaintListSchema = z.strictObject({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  category: z.string().min(1).max(41).optional(),
  ...page(100),
});
export const adminComplaintListSchema = z.strictObject({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  category: z.string().min(1).max(41).optional(),
  priority: z.enum(COMPLAINT_PRIORITIES).optional(),
  source: z.enum(['merchant', 'customer', 'admin']).optional(),
  merchant: refSchema.optional(),
  assignee: refSchema.optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  breached: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  ...page(200),
});
export const complaintBreachListSchema = z.strictObject(page(200));
export const merchantMessageSchema = z.strictObject({ body: text(5000) });
export const adminMessageSchema = z.strictObject({
  body: text(5000),
  internal: z.boolean().optional(),
  awaitCustomer: z.boolean().optional(),
});
export const closeComplaintSchema = z.strictObject({
  satisfactionScore: z.number().int().min(1).max(5).optional(),
});
export const assignSchema = z.strictObject({ assignee: refSchema });
export const escalateComplaintSchema = z.strictObject({ reason: text(1000) });
export const resolveComplaintSchema = z.strictObject({ resolution: text(5000) });

// -- disputes (Phase 8 additions) ----------------------------------------------------------------

export const disputeNoteBodySchema = z.strictObject({ body: text(2000) });
export const adminDisputeQueueSchema = z.strictObject({
  status: z.enum(['open', 'under_review', 'resolved']).optional(),
  merchant: refSchema.optional(),
  assignee: refSchema.optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  deadline: z.enum(['overdue', 'due_soon']).optional(),
  ...page(200),
});

// -- incidents -------------------------------------------------------------------------------

const services = z.array(z.enum(INCIDENT_SERVICES)).max(20);
export const createIncidentSchema = z.strictObject({
  title: text(200),
  severity: z.enum(SEVERITIES),
  impact: text(4000),
  affectedServices: services.default([]),
  affectedMerchants: z.array(refSchema).max(200).optional(),
  commander: refSchema.optional(),
  startedAt: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  message: text(4000).optional(),
});
export const updateIncidentSchema = z.strictObject({
  title: text(200).optional(),
  severity: z.enum(SEVERITIES).optional(),
  impact: text(4000).optional(),
  status: z.enum(['investigating', 'identified', 'monitoring']).optional(),
  affectedServices: services.optional(),
  affectedMerchants: z.array(refSchema).max(200).optional(),
  commander: refSchema.nullable().optional(),
  /** Only `false` is accepted: a public update is what makes an incident public. */
  public: z.literal(false).optional(),
});
export const incidentUpdateBodySchema = z.strictObject({
  body: text(4000),
  status: z.enum(['investigating', 'identified', 'monitoring']).optional(),
  public: z.boolean().optional(),
});
export const resolveIncidentSchema = z.strictObject({
  body: text(4000),
  public: z.boolean().optional(),
});
export const postmortemBodySchema = z.strictObject({
  summary: text(8000),
  rootCause: text(8000),
  timeline: z
    .array(z.strictObject({ at: z.string().max(40), event: text(1000) }))
    .max(200)
    .default([]),
  actionItems: z
    .array(
      z.strictObject({
        title: text(500),
        owner: z.string().max(100).nullable().default(null),
        due: z.string().max(40).nullable().default(null),
      })
    )
    .max(100)
    .default([]),
  publish: z.boolean().optional(),
});
export const incidentListSchema = z.strictObject({
  status: z.enum(INCIDENT_STATUSES).optional(),
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  severity: z.enum(SEVERITIES).optional(),
  source: z.enum(['manual', 'reconciliation', 'consumer', 'monitor']).optional(),
  ...page(200),
});

// -- notifications -------------------------------------------------------------------------------

export const inboxListSchema = z.strictObject({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  ...page(100),
});
const channel = z.enum(['email', 'sms', 'push', 'in_app']);
export const setPreferencesSchema = z.strictObject({
  preferences: z
    .array(
      z.strictObject({
        template: z.string().min(1).max(81),
        channel,
        enabled: z.boolean(),
      })
    )
    .min(1)
    .max(100),
});
export const destinationParamSchema = z.strictObject({ channel: z.enum(['sms', 'push']) });
export const setDestinationSchema = z.strictObject({ address: z.string().trim().min(4).max(4096) });
export const readParamSchema = z.strictObject({ ref: refSchema });
export const templateParamSchema = z.strictObject({
  code: z.string().min(3).max(81),
  channel,
});
export const templateListSchema = z.strictObject({
  code: z.string().min(3).max(81).optional(),
  channel: channel.optional(),
});
export const saveTemplateSchema = z.strictObject({
  subject: text(200).nullable().optional(),
  body: text(5000),
  variables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(30),
  mandatory: z.boolean().optional(),
  audience: z.enum(['staff', 'merchant', 'any']),
  active: z.boolean().optional(),
});
export const broadcastSchema = z.strictObject({
  audience: z.enum(['staff', 'merchants']),
  merchants: z.array(refSchema).max(200).optional(),
  headline: text(200),
  message: text(2000),
});
export const deliveryListSchema = z.strictObject({
  status: z.enum(['pending', 'sent', 'delivered', 'failed']).optional(),
  channel: channel.optional(),
  from: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  ...page(200),
});

// -- reports -----------------------------------------------------------------------------------

export const requestReportSchema = z.strictObject({
  type: z.enum(REPORT_TYPES),
  format: z.enum(['csv', 'json', 'xlsx', 'pdf']).optional(),
  environment: environment.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export const requestAdminReportSchema = z.strictObject({
  type: z.enum(REPORT_TYPES),
  format: z.enum(['csv', 'json', 'xlsx', 'pdf']).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export const reportListSchema = z.strictObject({
  type: z.enum(REPORT_TYPES).optional(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']).optional(),
  environment: environment.optional(),
  ...page(100),
});
export const adminReportListSchema = z.strictObject({
  type: z.enum(REPORT_TYPES).optional(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']).optional(),
  ...page(200),
});
export const reportEnvironmentSchema = z.strictObject({ environment: environment.optional() });
const period = z.enum(['previous_day', 'previous_week', 'previous_month']);
export const createScheduleSchema = z.strictObject({
  reportType: z.enum(REPORT_TYPES),
  params: z.record(z.string(), z.unknown()).optional(),
  period,
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().min(1).max(64).optional(),
  recipients: z.array(z.email().max(254)).min(1).max(10),
  format: z.enum(['csv', 'json']).optional(),
  environment: environment.optional(),
});
export const updateScheduleSchema = z.strictObject({
  params: z.record(z.string(), z.unknown()).optional(),
  period: period.optional(),
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  recipients: z.array(z.email().max(254)).min(1).max(10).optional(),
  format: z.enum(['csv', 'json']).optional(),
  active: z.boolean().optional(),
});
export const scheduleListSchema = z.strictObject({
  environment: environment.optional(),
  ...page(100),
});

// -- analytics ---------------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const analyticsQuerySchema = z.strictObject({
  from: day.optional(),
  to: day.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  environment: environment.optional(),
});

// -- operations ----------------------------------------------------------------------------------

export const queueParamSchema = z.strictObject({ name: z.string().min(1).max(60) });
export const retryFailedSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000).default(100),
});
export const cursorParamSchema = queueParamSchema;
export const rewindSchema = z.strictObject({ position: minorString, reason: text(1000) });
export const stuckListSchema = z.strictObject({
  olderThanMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
  ...page(200),
});
export const flagParamSchema = z.strictObject({ key: z.string().min(1).max(61) });
export const createFlagSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_.]{2,60}$/),
  description: text(500),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
});
export const changeFlagSchema = z.strictObject({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  merchantAllowlist: z.array(refSchema).max(500).optional(),
  reason: text(1000).optional(),
});
export const maintenanceBodySchema = z.strictObject({
  enabled: z.boolean(),
  message: text(500).optional(),
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
});
export const approvalListSchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  kind: z.string().min(1).max(40).optional(),
  ...page(200),
});
export const decideApprovalSchema = z.strictObject({ note: text(1000).optional() });
export const providerParamSchema = z.strictObject({ id: z.enum(['mtn', 'airtel', 'flutterwave']) });
export const patchProviderSchema = z.strictObject({
  enabled: z.boolean().optional(),
  health: z.enum(['healthy', 'degraded', 'down']).optional(),
  note: text(500).nullable().optional(),
  reason: text(1000).optional(),
});
export const providerBalanceQuerySchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountType: z.enum(['collection', 'disbursement']).default('collection'),
});
const ruleBody = {
  priority: z.number().int().min(0).max(10_000),
  country: z
    .string()
    .regex(/^([A-Z]{2}|\*)$/)
    .optional(),
  channel: z.enum(['mobile_money', 'card', 'bank', '*']).optional(),
  minAmountMinor: minorString.nullable().optional(),
  maxAmountMinor: minorString.nullable().optional(),
  msisdnPrefix: z
    .string()
    .regex(/^\+[0-9]{1,8}$/)
    .nullable()
    .optional(),
  provider: z.enum(['mtn', 'airtel', 'flutterwave']),
  weight: z.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
};
export const createRuleSchema = z
  .strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), ...ruleBody })
  .refine(
    (r) =>
      r.minAmountMinor == null || r.maxAmountMinor == null || r.minAmountMinor <= r.maxAmountMinor,
    { message: 'minAmountMinor must not exceed maxAmountMinor', path: ['minAmountMinor'] }
  );
export const patchRuleSchema = z
  .strictObject(ruleBody)
  .partial()
  .extend({ reason: text(1000).optional() })
  .refine(
    (r) =>
      r.minAmountMinor == null || r.maxAmountMinor == null || r.minAmountMinor <= r.maxAmountMinor,
    { message: 'minAmountMinor must not exceed maxAmountMinor', path: ['minAmountMinor'] }
  );
export const deleteRuleSchema = z.strictObject({ reason: text(1000) });
export const ruleListSchema = z.strictObject({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  provider: z.enum(['mtn', 'airtel', 'flutterwave']).optional(),
});
