/**
 * What a report is (spec 6.12): its type, who may ask for it, and the parameters each type
 * accepts. Pure and unit-tested. Parameters are validated when a report is requested, stored
 * on the report as JSON (dates as ISO strings, so the same report can be reproduced), and parsed
 * again by the worker.
 *
 *  - Time windows are at most 366 days (the partitioned tables are only ever scanned inside a
 *    window, spec 9.2 rule 6); the audit trail at most 92.
 *  - A merchant can request only the types about its own money; the platform types need staff
 *    permissions, and a merchant-scoped type requested by staff names the merchant.
 *  - Formats: `csv` and `json`. `xlsx` and `pdf` (spec 5.2) are not supported and are refused.
 */
import { z } from 'zod';
import { REPORT_FORMATS, REPORT_TYPES } from '../../../db/schema';

export type ReportType = (typeof REPORT_TYPES)[number];
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export { REPORT_FORMATS, REPORT_TYPES };

const DAY_MS = 86_400_000;
export const MAX_WINDOW_DAYS = 366;
export const MAX_AUDIT_WINDOW_DAYS = 92;
export const DEFAULT_WINDOW_DAYS = 30;

const instant = z.iso.datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/);
const ref = z.string().min(1).max(64);

const window = {
  from: instant.optional(),
  to: instant.optional(),
};

const money = z.strictObject({ ...window, currency: currency.optional() });
const withStatus = z.strictObject({
  ...window,
  currency: currency.optional(),
  status: z
    .string()
    .regex(/^[a-z_]{3,30}$/)
    .optional(),
});

/** Parameter schemas by type. `merchant` is accepted only from staff (checked by the service). */
export const PARAM_SCHEMAS: Record<ReportType, z.ZodType<Record<string, unknown>>> = {
  transactions: withStatus.extend({
    type: z
      .enum(['payment', 'payout', 'refund', 'fee', 'adjustment', 'transfer', 'settlement'])
      .optional(),
    merchant: ref.optional(),
  }),
  payments: withStatus.extend({ merchant: ref.optional() }),
  payouts: withStatus.extend({ merchant: ref.optional() }),
  refunds: withStatus.extend({ merchant: ref.optional() }),
  fees: money.extend({ merchant: ref.optional() }),
  balance_statement: z.strictObject({ ...window, currency, merchant: ref.optional() }),
  settlement_statement: z.strictObject({ settlement: ref, merchant: ref.optional() }),
  merchant_performance: money.extend({ merchant: ref.optional() }),
  ledger_account_statement: z.strictObject({
    ...window,
    accountCode: z.string().min(3).max(120),
    currency,
    environment: z.enum(['test', 'live']).default('live'),
  }),
  reconciliation_exceptions: z.strictObject({
    ...window,
    status: z.enum(['open', 'investigating', 'resolved', 'written_off']).optional(),
    kind: z
      .string()
      .regex(/^[a-z_]{3,60}$/)
      .optional(),
  }),
  aml_alerts: z.strictObject({
    ...window,
    status: z
      .string()
      .regex(/^[a-z_]{3,30}$/)
      .optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  }),
  kyc_status: z.strictObject({
    status: z
      .string()
      .regex(/^[a-z_]{3,30}$/)
      .optional(),
  }),
  audit_trail: z.strictObject({
    ...window,
    action: z.string().min(1).max(120).optional(),
    resourceType: z.string().min(1).max(60).optional(),
  }),
};

/** Types a merchant may request about itself. */
export const MERCHANT_TYPES: readonly ReportType[] = [
  'transactions',
  'payments',
  'payouts',
  'refunds',
  'fees',
  'balance_statement',
  'settlement_statement',
  'merchant_performance',
];

/** Types about the platform: staff only. */
export const PLATFORM_TYPES: readonly ReportType[] = [
  'ledger_account_statement',
  'reconciliation_exceptions',
  'aml_alerts',
  'kyc_status',
  'audit_trail',
];

/** Types that are scoped to one merchant (staff name it, a merchant is itself). */
export const MERCHANT_SCOPED_TYPES: readonly ReportType[] = [
  'transactions',
  'payments',
  'payouts',
  'refunds',
  'fees',
  'balance_statement',
  'settlement_statement',
];

/** The extra permission staff need for a type, beyond `reports:platform`. */
export const STAFF_PERMISSION_BY_TYPE: Partial<Record<ReportType, string>> = {
  ledger_account_statement: 'ledger:read',
  reconciliation_exceptions: 'reconciliation:read',
  aml_alerts: 'aml:read',
  kyc_status: 'kyc:read',
  audit_trail: 'audit_logs:read',
};

export type ParamProblem =
  | { readonly kind: 'invalid'; readonly fields: string[] }
  | { readonly kind: 'window'; readonly maxDays: number };

export interface ResolvedParams {
  /** Stored on the report: dates as ISO strings, window always present for windowed types. */
  readonly params: Record<string, unknown>;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** Types whose parameters carry a time window. */
export function isWindowed(type: ReportType): boolean {
  return !['settlement_statement', 'kyc_status'].includes(type);
}

/**
 * Validates the parameters for a type and fills the window (the last 30 days ending now when
 * absent). Returns the parameters to store, or the problem.
 */
export function resolveParams(
  type: ReportType,
  input: unknown,
  now: Date
): ResolvedParams | ParamProblem {
  const parsed = PARAM_SCHEMAS[type].safeParse(input ?? {});
  if (!parsed.success) {
    return {
      kind: 'invalid',
      fields: parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
    };
  }
  const params: Record<string, unknown> = { ...parsed.data };
  if (!isWindowed(type)) return { params, from: null, to: null };
  const to = typeof params.to === 'string' ? new Date(params.to) : now;
  const from =
    typeof params.from === 'string'
      ? new Date(params.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  const maxDays = type === 'audit_trail' ? MAX_AUDIT_WINDOW_DAYS : MAX_WINDOW_DAYS;
  if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > maxDays * DAY_MS) {
    return { kind: 'window', maxDays };
  }
  params.from = from.toISOString();
  params.to = to.toISOString();
  return { params, from, to };
}

export function isProblem(value: ResolvedParams | ParamProblem): value is ParamProblem {
  return 'kind' in value;
}

/** The window of a scheduled run: the day, week or month before `due`, in UTC. */
export function periodWindow(
  period: 'previous_day' | 'previous_week' | 'previous_month',
  due: Date
): { from: Date; to: Date } {
  const startOfDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  if (period === 'previous_day') {
    return { from: new Date(startOfDay - DAY_MS), to: new Date(startOfDay) };
  }
  if (period === 'previous_week') {
    // Weeks run Monday to Sunday: the week before the one `due` falls in.
    const weekday = (due.getUTCDay() + 6) % 7;
    const monday = startOfDay - weekday * DAY_MS;
    return { from: new Date(monday - 7 * DAY_MS), to: new Date(monday) };
  }
  const firstOfMonth = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1);
  const firstOfPrevious = Date.UTC(due.getUTCFullYear(), due.getUTCMonth() - 1, 1);
  return { from: new Date(firstOfPrevious), to: new Date(firstOfMonth) };
}
