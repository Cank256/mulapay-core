/** What the operations back office looks like on the admin API (spec 7.3). Amounts are strings of minor units. */
import { z } from 'zod';
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '../../db/schema';
import type { ApprovalDetail } from './approvals/approvals.service';
import type { ApprovalRow, ApprovalWithRefs } from './approvals/approvals.repository';
import type { CursorView } from './consumer-cursors.service';
import type { MaintenanceStatus } from './maintenance.service';
import type { FlagRow, RuleRow } from './ops-config.repository';
import type { StuckTransaction, SuspenseBalance } from './ops-signals.repository';
import type { ProviderView } from './provider-ops.service';
import type { QueueView } from './queue-ops.service';

const iso = z.string();
const minor = z.string().regex(/^-?\d+$/);

export const approvalSchema = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  resourceType: z.string(),
  resourceId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: iso,
  status: z.enum(APPROVAL_STATUSES),
  expiresAt: iso,
  decidedAt: iso.nullable(),
  executedAt: iso.nullable(),
});
export const approvalDetailSchema = approvalSchema.extend({
  decisions: z.array(
    z.object({
      approver: z.string(),
      decision: z.enum(['approve', 'reject']),
      note: z.string().nullable(),
      decidedAt: iso,
    })
  ),
});
export const approvalPageSchema = z.object({
  items: z.array(approvalSchema),
  nextCursor: z.string().nullable(),
});
/** Returned (with 202) when a change needs a second person: nothing has changed yet. */
export const approvalRequiredSchema = z.object({
  approvalRequired: z.literal(true),
  approval: approvalSchema,
});

export const flagSchema = z.object({
  key: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  rolloutPercent: z.number().int(),
  merchantAllowlist: z.number().int(),
  updatedAt: iso,
});
export const flagsSchema = z.object({ items: z.array(flagSchema) });

export const providerSchema = z.object({
  provider: z.string(),
  enabled: z.boolean(),
  health: z.enum(['healthy', 'degraded', 'down']),
  note: z.string().nullable(),
  currencies: z.array(z.string()),
  enabledRules: z.number().int(),
  updatedAt: iso,
});
export const providersSchema = z.object({ items: z.array(providerSchema) });
export const providerBalanceSchema = z.object({
  provider: z.string(),
  accountType: z.enum(['collection', 'disbursement']),
  currency: z.string(),
  availableMinor: minor,
});

export const ruleSchema = z.object({
  id: z.string(),
  priority: z.number().int(),
  currency: z.string(),
  country: z.string(),
  channel: z.string(),
  minAmountMinor: minor.nullable(),
  maxAmountMinor: minor.nullable(),
  msisdnPrefix: z.string().nullable(),
  provider: z.string(),
  weight: z.number().int(),
  enabled: z.boolean(),
  updatedAt: iso,
});
export const rulesSchema = z.object({ items: z.array(ruleSchema) });

export const cursorSchema = z.object({
  name: z.string(),
  position: minor,
  holder: z.string().nullable(),
  heartbeatAt: iso.nullable(),
  status: z.enum(['running', 'stale', 'never_started']),
  eventsBehind: minor.nullable(),
  lagSeconds: z.number().nullable(),
  lagAlert: z.boolean(),
  streamHead: minor.nullable(),
});
export const cursorsSchema = z.object({ items: z.array(cursorSchema) });

export const queueSchema = z.object({
  name: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  paused: z.boolean(),
  oldestWaitingSeconds: z.number(),
});
export const queuesSchema = z.object({ items: z.array(queueSchema) });
export const retriedSchema = z.object({ retried: z.number().int() });

export const stuckSchema = z.object({
  id: z.string(),
  type: z.string(),
  merchant: z.string(),
  environment: z.string(),
  provider: z.string().nullable(),
  amountMinor: minor,
  currency: z.string(),
  outcomeUnknown: z.boolean(),
  gatewayExternalId: z.string().nullable(),
  processingSince: iso,
  ageMinutes: z.number().int(),
});
export const stuckPageSchema = z.object({
  items: z.array(stuckSchema),
  nextCursor: z.string().nullable(),
});

export const suspenseSchema = z.object({
  items: z.array(z.object({ environment: z.string(), currency: z.string(), balanceMinor: minor })),
});

export const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().nullable(),
  retryAfterSeconds: z.number().int(),
  changedAt: iso.nullable(),
});

export const overviewSchema = z.object({
  generatedAt: iso,
  maintenance: maintenanceSchema,
  queues: z.array(queueSchema),
  cursors: z.array(cursorSchema),
  stuckTransactions: z.object({
    thresholdMinutes: z.number().int(),
    count: z.number().int(),
    oldest: iso.nullable(),
  }),
  suspense: z.array(
    z.object({ environment: z.string(), currency: z.string(), balanceMinor: minor })
  ),
  openIncidents: z.array(z.object({ severity: z.string(), n: z.number().int() })),
  pendingApprovals: z.number().int(),
  breachedComplaints: z.number().int(),
  notificationBacklog: z.array(
    z.object({ channel: z.string(), status: z.string(), n: z.number().int() })
  ),
  providers: z.array(z.object({ provider: z.string(), enabled: z.boolean(), health: z.string() })),
  today: z.object({
    day: z.string(),
    totals: z.array(
      z.object({
        currency: z.string(),
        paymentCount: z.number().int(),
        paymentMinor: minor,
        successCount: z.number().int(),
        failureCount: z.number().int(),
        refundMinor: minor,
        payoutMinor: minor,
      })
    ),
  }),
});

export function toApproval(found: ApprovalWithRefs | { row: ApprovalRow; requestedByRef: string }) {
  const { row } = found;
  return {
    id: row.ref,
    kind: row.kind as z.infer<typeof approvalSchema>['kind'],
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    payload: row.payload,
    reason: row.reason,
    requestedBy: found.requestedByRef,
    requestedAt: row.requestedAt.toISOString(),
    status: row.status as z.infer<typeof approvalSchema>['status'],
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

export const toApprovalDetail = (d: ApprovalDetail) => ({
  ...toApproval(d.approval),
  decisions: d.decisions.map((x) => ({
    approver: x.approverRef,
    decision: x.row.decision as 'approve' | 'reject',
    note: x.row.note,
    decidedAt: x.row.decidedAt.toISOString(),
  })),
});

export const toFlag = (f: FlagRow): z.infer<typeof flagSchema> => ({
  key: f.key,
  description: f.description,
  enabled: f.enabled,
  rolloutPercent: f.rolloutPercent,
  merchantAllowlist: f.merchantAllowlist.length,
  updatedAt: f.updatedAt.toISOString(),
});

export const toProvider = (p: ProviderView): z.infer<typeof providerSchema> => ({
  provider: p.row.provider,
  enabled: p.row.enabled,
  health: p.row.health as 'healthy' | 'degraded' | 'down',
  note: p.row.note,
  currencies: [...p.currencies],
  enabledRules: p.enabledRules,
  updatedAt: p.row.updatedAt.toISOString(),
});

export const toRule = (r: RuleRow): z.infer<typeof ruleSchema> => ({
  id: r.ref,
  priority: r.priority,
  currency: r.currency,
  country: r.country,
  channel: r.channel,
  minAmountMinor: r.minAmountMinor?.toString() ?? null,
  maxAmountMinor: r.maxAmountMinor?.toString() ?? null,
  msisdnPrefix: r.msisdnPrefix,
  provider: r.provider,
  weight: r.weight,
  enabled: r.enabled,
  updatedAt: r.updatedAt.toISOString(),
});

export const toCursor = (c: CursorView): z.infer<typeof cursorSchema> => ({
  name: c.name,
  position: c.position.toString(),
  holder: c.holder,
  heartbeatAt: c.heartbeatAt?.toISOString() ?? null,
  status: c.status,
  eventsBehind: c.eventsBehind?.toString() ?? null,
  lagSeconds: c.lagSeconds,
  lagAlert: c.lagAlert,
  streamHead: c.streamHead?.toString() ?? null,
});

export const toQueue = (q: QueueView): z.infer<typeof queueSchema> => ({ ...q });

export const toStuck = (s: StuckTransaction, now: Date): z.infer<typeof stuckSchema> => ({
  id: s.ref,
  type: s.type,
  merchant: s.merchantRef,
  environment: s.environment,
  provider: s.provider,
  amountMinor: s.amountMinor.toString(),
  currency: s.currency,
  outcomeUnknown: s.outcomeUnknown,
  gatewayExternalId: s.gatewayExternalId,
  processingSince: s.startedAt.toISOString(),
  ageMinutes: Math.floor((now.getTime() - s.startedAt.getTime()) / 60_000),
});

export const toSuspense = (rows: readonly SuspenseBalance[]) =>
  rows.map((r) => ({
    environment: r.environment,
    currency: r.currency,
    balanceMinor: r.balanceMinor.toString(),
  }));

export const toMaintenance = (m: MaintenanceStatus): z.infer<typeof maintenanceSchema> => ({
  enabled: m.enabled,
  message: m.message,
  retryAfterSeconds: m.retryAfterSeconds,
  changedAt: m.changedAt?.toISOString() ?? null,
});
