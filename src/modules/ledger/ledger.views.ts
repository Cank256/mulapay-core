/** Response shapes for the admin ledger routes. Money is a decimal string of minor units. */
import { z } from 'zod';
import type { AccountRow } from '../accounts/accounts.repository';
import type { AccountBalanceView, MerchantBalanceView } from '../balances/balances.service';
import type { HoldRow } from '../holds/holds.repository';
import type { JournalEntry } from './journal-entry';
import type { LedgerIntegrityReport, TrialBalance } from './ledger-integrity.service';
import type { EntryListRow, StatementRow } from './ledger-query.repository';
const minor = z.string().regex(/^-?\d+$/);
const environment = z.enum(['test', 'live']);
export const accountSchema = z.object({
  ref: z.string(),
  code: z.string(),
  name: z.string(),
  environment,
  type: z.string(),
  normalBalance: z.enum(['debit', 'credit']),
  purpose: z.string(),
  provider: z.string().nullable(),
  currency: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});
export function toAccountView(row: AccountRow): z.infer<typeof accountSchema> {
  return {
    ref: row.ref,
    code: row.code,
    name: row.name,
    environment: row.environment as 'test' | 'live',
    type: row.type,
    normalBalance: row.normalBalance as 'debit' | 'credit',
    purpose: row.purpose,
    provider: row.provider,
    currency: row.currency,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}
export const accountBalanceSchema = z.object({
  currency: z.string(),
  debitsMinor: minor,
  creditsMinor: minor,
  postedMinor: minor,
});
export const accountDetailSchema = z.object({
  account: accountSchema,
  balances: z.array(accountBalanceSchema),
});
export function toAccountBalanceView(b: AccountBalanceView): z.infer<typeof accountBalanceSchema> {
  return {
    currency: b.currency,
    debitsMinor: b.postedDebitsMinor.toString(),
    creditsMinor: b.postedCreditsMinor.toString(),
    postedMinor: b.postedMinor.toString(),
  };
}
export const accountPageSchema = z.object({
  items: z.array(accountSchema),
  nextCursor: z.string().nullable(),
});
export const statementLineSchema = z.object({
  entryRef: z.string(),
  createdAt: z.string(),
  lineNo: z.number().int(),
  direction: z.enum(['debit', 'credit']),
  amountMinor: minor,
  kind: z.string(),
  description: z.string(),
  balanceAfterMinor: minor,
});
export const statementSchema = z.object({
  account: accountSchema,
  currency: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(statementLineSchema),
  nextCursor: z.string().nullable(),
});
export function toStatementLine(row: StatementRow): z.infer<typeof statementLineSchema> {
  return {
    entryRef: row.entry_ref,
    createdAt: row.created_at,
    lineNo: row.line_no,
    direction: row.direction as 'debit' | 'credit',
    amountMinor: row.amount_minor,
    kind: row.kind,
    description: row.description,
    balanceAfterMinor: row.balance_after,
  };
}
export const entrySummarySchema = z.object({
  ref: z.string(),
  createdAt: z.string(),
  environment,
  currency: z.string(),
  source: z.string(),
  sourceId: z.string(),
  kind: z.string(),
  description: z.string(),
  merchantRef: z.string().nullable(),
  transactionId: z.string().nullable(),
  reversesEntryRef: z.string().nullable(),
});
export const entryPageSchema = z.object({
  items: z.array(entrySummarySchema),
  nextCursor: z.string().nullable(),
});
export function toEntrySummary(row: EntryListRow): z.infer<typeof entrySummarySchema> {
  return {
    ref: row.ref,
    createdAt: row.created_at,
    environment: row.environment as 'test' | 'live',
    currency: row.currency,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    description: row.description,
    merchantRef: row.merchant_ref,
    transactionId: row.transaction_id,
    reversesEntryRef: row.reverses_entry_ref,
  };
}
export const entryDetailSchema = z.object({
  ref: z.string(),
  createdAt: z.string(),
  postedAt: z.string(),
  environment,
  currency: z.string(),
  source: z.string(),
  sourceId: z.string(),
  kind: z.string(),
  description: z.string(),
  transactionId: z.string().nullable(),
  createdBy: z.string(),
  lines: z.array(
    z.object({
      lineNo: z.number().int(),
      accountCode: z.string(),
      direction: z.enum(['debit', 'credit']),
      amountMinor: minor,
    })
  ),
});
export function toEntryDetail(entry: JournalEntry): z.infer<typeof entryDetailSchema> {
  return {
    ref: entry.ref,
    createdAt: entry.createdAt,
    postedAt: entry.postedAt.toISOString(),
    environment: entry.environment,
    currency: entry.currency,
    source: entry.source,
    sourceId: entry.sourceId,
    kind: entry.kind,
    description: entry.description,
    transactionId: entry.transactionId,
    createdBy: entry.createdBy,
    lines: entry.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      direction: l.direction,
      amountMinor: l.amountMinor.toString(),
    })),
  };
}
export const trialBalanceSchema = z.object({
  environment,
  currency: z.string(),
  accounts: z.array(
    z.object({
      accountCode: z.string(),
      name: z.string(),
      type: z.string(),
      debitsMinor: minor,
      creditsMinor: minor,
      balanceMinor: minor,
    })
  ),
  totalDebitsMinor: minor,
  totalCreditsMinor: minor,
  balanced: z.boolean(),
});
export function toTrialBalanceView(t: TrialBalance): z.infer<typeof trialBalanceSchema> {
  return {
    environment: t.environment,
    currency: t.currency,
    accounts: t.accounts.map((a) => ({
      accountCode: a.accountCode,
      name: a.name,
      type: a.type,
      debitsMinor: a.debitsMinor.toString(),
      creditsMinor: a.creditsMinor.toString(),
      balanceMinor: a.balanceMinor.toString(),
    })),
    totalDebitsMinor: t.totalDebitsMinor.toString(),
    totalCreditsMinor: t.totalCreditsMinor.toString(),
    balanced: t.balanced,
  };
}
const accountAmount = z.object({
  accountCode: z.string(),
  environment: z.string(),
  currency: z.string(),
  balanceMinor: minor,
});
export const integritySchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  windowFrom: z.string(),
  windowTo: z.string(),
  invalidEntries: z.array(
    z.object({
      entryRef: z.string(),
      createdAt: z.string(),
      reasons: z.array(z.string()),
      lineCount: z.number().int(),
      debitsMinor: minor,
      creditsMinor: minor,
    })
  ),
  balanceMismatches: z.array(
    z.object({
      accountCode: z.string(),
      environment: z.string(),
      currency: z.string(),
      recordedDebitsMinor: minor,
      recordedCreditsMinor: minor,
      journalDebitsMinor: minor,
      journalCreditsMinor: minor,
    })
  ),
  nonZeroSuspense: z.array(accountAmount),
  negativeMerchantBalances: z.array(accountAmount),
  unbalancedTotals: z.array(
    z.object({
      environment: z.string(),
      currency: z.string(),
      debitsMinor: minor,
      creditsMinor: minor,
    })
  ),
});
export function toIntegrityView(r: LedgerIntegrityReport): z.infer<typeof integritySchema> {
  const amount = (a: LedgerIntegrityReport['nonZeroSuspense'][number]) => ({
    ...a,
    balanceMinor: a.balanceMinor.toString(),
  });
  return {
    ok: r.ok,
    checkedAt: r.checkedAt.toISOString(),
    windowFrom: r.window.from.toISOString(),
    windowTo: r.window.to.toISOString(),
    invalidEntries: r.invalidEntries.map((e) => ({
      ...e,
      reasons: [...e.reasons],
      debitsMinor: e.debitsMinor.toString(),
      creditsMinor: e.creditsMinor.toString(),
    })),
    balanceMismatches: r.balanceMismatches.map((m) => ({
      ...m,
      recordedDebitsMinor: m.recordedDebitsMinor.toString(),
      recordedCreditsMinor: m.recordedCreditsMinor.toString(),
      journalDebitsMinor: m.journalDebitsMinor.toString(),
      journalCreditsMinor: m.journalCreditsMinor.toString(),
    })),
    nonZeroSuspense: r.nonZeroSuspense.map(amount),
    negativeMerchantBalances: r.negativeMerchantBalances.map(amount),
    unbalancedTotals: r.unbalancedTotals.map((u) => ({
      ...u,
      debitsMinor: u.debitsMinor.toString(),
      creditsMinor: u.creditsMinor.toString(),
    })),
  };
}
export const merchantBalanceSchema = z.object({
  currency: z.string(),
  postedMinor: minor,
  heldMinor: minor,
  pendingMinor: minor,
  reservedMinor: minor,
  availableMinor: minor,
});
export function toMerchantBalanceView(
  b: MerchantBalanceView
): z.infer<typeof merchantBalanceSchema> {
  return {
    currency: b.currency,
    postedMinor: b.postedMinor.toString(),
    heldMinor: b.heldMinor.toString(),
    pendingMinor: b.pendingMinor.toString(),
    reservedMinor: b.reservedMinor.toString(),
    availableMinor: b.availableMinor.toString(),
  };
}
export const holdSchema = z.object({
  ref: z.string(),
  state: z.enum(['active', 'captured', 'released', 'expired']),
  currency: z.string(),
  amountMinor: minor,
  reason: z.string(),
  expiresAt: z.string().nullable(),
  capturedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
  createdAt: z.string(),
});
export function toHoldView(h: HoldRow): z.infer<typeof holdSchema> {
  return {
    ref: h.ref,
    state: h.state as 'active' | 'captured' | 'released' | 'expired',
    currency: h.currency,
    amountMinor: h.amountMinor.toString(),
    reason: h.reason,
    expiresAt: h.expiresAt?.toISOString() ?? null,
    capturedAt: h.capturedAt?.toISOString() ?? null,
    releasedAt: h.releasedAt?.toISOString() ?? null,
    expiredAt: h.expiredAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
  };
}
