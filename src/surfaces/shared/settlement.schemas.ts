/** Request and response shapes of the settlement and reconciliation routes. Strict by default. */
import { z } from 'zod';
import { settlementSchema } from '../../modules/settlement/settlement.views';
import { currencySchema, refSchema } from './schemas';

const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(50);
const cursor = z.string().min(1).max(512).optional();
const minor = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})$/, 'must be a non-negative integer in minor units');
const dateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

// ---- settlement (staff) ----
export const cycleBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  schedule: z.string().trim().min(9).max(100),
  currency: currencySchema,
  delayDays: z.number().int().min(0).max(90),
  cutoffTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  timezone: z.string().min(1).max(64),
  minPayoutMinor: minor.transform((v) => BigInt(v)),
});
export const cyclePatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  schedule: z.string().trim().min(9).max(100).optional(),
  delayDays: z.number().int().min(0).max(90).optional(),
  cutoffTime: z
    .string()
    .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  minPayoutMinor: minor.transform((v) => BigInt(v)).optional(),
  active: z.boolean().optional(),
});
export const assignMerchantSchema = z.strictObject({
  merchant: refSchema,
  cycle: refSchema.nullable(),
});
export const runCycleSchema = z.strictObject({ cycle: refSchema });
export const payablesQuerySchema = z.strictObject({
  cycle: refSchema,
  after: z.uuid().optional(),
  limit: limit(100),
});
export const listBatchesSchema = z.strictObject({
  merchant: refSchema.optional(),
  cycle: refSchema.optional(),
  status: z
    .enum(['draft', 'pending_approval', 'approved', 'releasing', 'paid', 'failed', 'cancelled'])
    .optional(),
  limit: limit(200),
  cursor,
});
export const cancelBatchSchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export const destinationBodySchema = z.strictObject({
  merchant: refSchema,
  currency: currencySchema,
  provider: z.enum(['mtn', 'airtel', 'flutterwave']),
  msisdn: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'must be in international form, for example +256700000000'),
});
export const rollingReserveBodySchema = z.strictObject({
  merchant: refSchema,
  currency: currencySchema,
  percentBps: z.number().int().min(0).max(10_000),
  holdDays: z.number().int().min(0).max(365),
  active: z.boolean().default(true),
});

export const adminBatchSchema = settlementSchema.extend({
  merchant: z.string(),
  cycle: z.string(),
  provider: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  failureCode: z.string().nullable(),
});
export const adminBatchPageSchema = z.object({
  items: z.array(adminBatchSchema),
  nextCursor: z.string().nullable(),
});
export const payablesSchema = z.object({
  periodEnd: z.string(),
  items: z.array(
    z.object({
      merchant: z.string(),
      decision: z.enum(['settle', 'roll_over', 'nothing', 'up_to_date']),
      periodStart: z.string().nullable(),
      grossMinor: z.string().nullable(),
      refundMinor: z.string().nullable(),
      feeMinor: z.string().nullable(),
      reserveMinor: z.string().nullable(),
      reserveReleaseMinor: z.string().nullable(),
      holdMinor: z.string().nullable(),
      shortfallMinor: z.string().nullable(),
      netMinor: z.string().nullable(),
    })
  ),
  nextAfter: z.string().nullable(),
});
export const settlementRunSchema = z.object({
  id: z.string(),
  outcome: z.enum(['completed', 'duplicate', 'in_progress', 'failed', 'inactive', 'too_early']),
  periodEnd: z.string().nullable(),
  status: z.string().nullable(),
  merchantsConsidered: z.number().nullable(),
  batchesCreated: z.number().nullable(),
  rolledOver: z.number().nullable(),
  failedMerchants: z.number().nullable(),
});
export const destinationSchema = z.object({
  id: z.string(),
  currency: z.string(),
  provider: z.string(),
  display: z.string(),
  status: z.string(),
});
export const rollingReserveSchema = z.object({
  percentBps: z.number(),
  holdDays: z.number(),
  source: z.enum(['merchant', 'default']),
});

// ---- settlement (merchant) ----
export const listSettlementsSchema = z.strictObject({ limit: limit(100), cursor });
export const settlementItemsQuerySchema = z.strictObject({ limit: limit(200), cursor });
export const statementSchema = z.object({
  settlement: settlementSchema,
  merchant: z.string(),
  totals: z.record(z.string(), z.string()),
  items: z.array(
    z.object({
      kind: z.string(),
      transaction: z.string().nullable(),
      amountMinor: z.string(),
      feeMinor: z.string(),
      netMinor: z.string(),
      occurredAt: z.string().nullable(),
    })
  ),
  payout: z.object({
    transaction: z.string().nullable(),
    status: z.string().nullable(),
    provider: z.string().nullable(),
    destination: z.string().nullable(),
    providerTransactionId: z.string().nullable(),
  }),
  reconciliation: z.object({
    statementMatches: z.array(
      z.object({ statement: z.string(), row: z.number(), status: z.string() })
    ),
    openExceptions: z.array(z.object({ ref: z.string(), kind: z.string(), status: z.string() })),
    ledgerEntries: z.array(z.object({ name: z.string(), ref: z.string() })),
  }),
  statusHistory: z.array(z.object({ from: z.string().nullable(), to: z.string(), at: z.string() })),
});
export const csvDownloadSchema = z.object({
  filename: z.string(),
  contentType: z.literal('text/csv'),
  content: z.string(),
});

// ---- reconciliation (staff) ----
const kind = z.enum(['gateway_gap', 'ledger_integrity', 'provider_statement', 'balance_proof']);
export const startRunSchema = z.strictObject({
  kind,
  environment: z.enum(['test', 'live']).default('live'),
  currency: currencySchema.optional(),
  merchant: refSchema.optional(),
  statement: refSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
});
export const listRunsSchema = z.strictObject({
  kind: kind.optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  limit: limit(200),
  cursor,
});
export const listExceptionsSchema = z.strictObject({
  status: z.enum(['open', 'investigating', 'resolved', 'written_off']).optional(),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,63}$/)
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assignedTo: refSchema.optional(),
  limit: limit(200),
  cursor,
});
/** The staff member's public ref (`usr_...`). */
export const assignSchema = z.strictObject({ assignee: refSchema });
export const noteSchema = z.strictObject({ body: z.string().trim().min(1).max(2000) });
/**
 * One strict object rather than a union (a DTO class cannot extend a union): the fields each
 * resolution needs are required by the refinements, and the others are refused.
 */
export const resolveSchema = z
  .strictObject({
    resolution: z.enum(['matched_manually', 'corrected_with_reversal', 'written_off']),
    note: z.string().trim().min(3).max(1000),
    entryRef: refSchema.optional(),
    accountCode: z.string().min(6).max(80).optional(),
    amountMinor: minor.optional(),
  })
  .superRefine((v, ctx) => {
    const need = (field: 'entryRef' | 'accountCode' | 'amountMinor', wanted: boolean) => {
      if (wanted && v[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'is required for this resolution' });
      }
      if (!wanted && v[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'is not allowed for this resolution',
        });
      }
    };
    need('entryRef', v.resolution === 'corrected_with_reversal');
    need('accountCode', v.resolution === 'written_off');
    need('amountMinor', v.resolution === 'written_off');
  });
export const decideSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(3).max(1000).optional(),
});
export const uploadStatementSchema = z.strictObject({
  provider: z.enum(['mtn', 'airtel', 'flutterwave']),
  currency: currencySchema,
  periodStart: dateTime,
  periodEnd: dateTime,
  rows: z
    .array(
      z.strictObject({
        providerRef: z.string().trim().min(1).max(128),
        amountMinor: z.string().regex(/^[1-9]\d{0,17}$/),
        occurredAt: dateTime,
        raw: z.record(z.string().max(60), z.string().max(300)).optional(),
      })
    )
    .min(1)
    .max(2000),
});
export const listStatementsSchema = z.strictObject({
  provider: z.enum(['mtn', 'airtel', 'flutterwave']).optional(),
  limit: limit(100),
  cursor,
});
export const statementRowsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
  limit: limit(500),
});
export const listHistorySchema = z.strictObject({ limit: limit(200) });

export const runSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.record(z.string(), z.string()),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  attempts: z.number(),
  checked: z.number(),
  matched: z.number(),
  exceptions: z.number(),
  summary: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
});
export const startRunResultSchema = z.object({
  outcome: z.enum(['completed', 'duplicate', 'in_progress']),
  run: runSchema.nullable(),
});
export const runPageSchema = z.object({
  items: z.array(runSchema),
  nextCursor: z.string().nullable(),
});
export const exceptionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.string(),
  status: z.string(),
  environment: z.string(),
  currency: z.string().nullable(),
  amountMinor: z.string().nullable(),
  expected: z.record(z.string(), z.unknown()),
  actual: z.record(z.string(), z.unknown()),
  occurrences: z.number(),
  assignedTo: z.string().nullable(),
  resolution: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  resolutionEntry: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export const exceptionPageSchema = z.object({
  items: z.array(exceptionSchema),
  nextCursor: z.string().nullable(),
});
export const resolutionRequestSchema = z.object({
  id: z.string(),
  exception: z.string().optional(),
  kind: z.string(),
  status: z.string(),
  currency: z.string().nullable(),
  amountMinor: z.string().nullable(),
  payload: z.record(z.string(), z.string()),
  reason: z.string(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  entry: z.string().nullable(),
});
export const exceptionDetailSchema = z.object({
  exception: exceptionSchema,
  notes: z.array(z.object({ kind: z.string(), body: z.string(), at: z.string() })),
  resolutionRequests: z.array(resolutionRequestSchema),
});
export const resolveResultSchema = z.object({
  exception: exceptionSchema,
  request: resolutionRequestSchema.nullable(),
});
export const statementUploadSchema = z.object({
  id: z.string(),
  provider: z.string(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  rowCount: z.number(),
  totalMinor: z.string(),
  status: z.string(),
  matched: z.number(),
  unmatched: z.number(),
  mismatch: z.number(),
  duplicate: z.number(),
  createdAt: z.string(),
});
export const statementPageSchema = z.object({
  items: z.array(statementUploadSchema),
  nextCursor: z.string().nullable(),
});
export const statementRowsSchema = z.object({
  items: z.array(
    z.object({
      row: z.number(),
      providerRef: z.string(),
      amountMinor: z.string(),
      currency: z.string(),
      occurredAt: z.string(),
      matchStatus: z.string(),
      matchNote: z.string().nullable(),
    })
  ),
  nextAfter: z.number().nullable(),
});
export const statusSchema = z.object({
  latestRuns: z.array(z.object({ kind: z.string(), run: runSchema.nullable() })),
  openExceptions: z.array(z.object({ kind: z.string(), severity: z.string(), count: z.number() })),
  openTotal: z.number(),
  oldestOpenAgeSeconds: z.number().nullable(),
  pendingApprovals: z.number(),
});
export const historySchema = z.object({ items: z.array(exceptionSchema) });
export const pendingRequestsSchema = z.object({ items: z.array(resolutionRequestSchema) });
