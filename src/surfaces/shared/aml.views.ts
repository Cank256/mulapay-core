/**
 * What AML records look like on the admin API. Maps rows to the response shapes of
 * `surfaces/shared/aml.schemas.ts`: public refs, string amounts, no internal ids, no hashes.
 */
import type { z } from 'zod';
import type {
  alertSchema,
  blockSchema,
  blocklistEntrySchema,
  caseSchema,
  ruleSchema,
  screeningSchema,
} from './aml.schemas';
import type { AlertListItem } from '../../modules/aml/alerts/aml-alerts.service';
import type { BlockRow } from '../../modules/aml/block/aml-blocks.repository';
import type { BlocklistRow } from '../../modules/aml/blocklist/aml-blocklist.repository';
import type { CaseRow } from '../../modules/aml/cases/aml-cases.repository';
import type { RuleRow } from '../../modules/aml/rules/aml-rules.repository';
import type { ScreeningRow } from '../../modules/aml/screening/aml-screenings.repository';

type Refs = ReadonlyMap<string, string>;

export function toAlertView(
  item: AlertListItem,
  staff: Refs,
  now: Date,
  holdRefs: Refs = new Map(),
  caseRefs: Refs = new Map()
): z.infer<typeof alertSchema> {
  const a = item.row;
  return {
    id: a.ref,
    rule: a.ruleCode,
    ruleVersion: a.ruleVersion,
    severity: a.severity as 'low',
    merchant: item.merchantRef,
    transaction: item.transactionRef,
    score: a.score,
    status: a.status as z.infer<typeof alertSchema>['status'],
    action: a.action as 'flag',
    details: a.details,
    assignedTo: a.assignedTo ? (staff.get(a.assignedTo) ?? null) : null,
    dueAt: a.dueAt.toISOString(),
    overdue: (a.status === 'open' || a.status === 'investigating') && a.dueAt <= now,
    escalatedAt: a.escalatedAt?.toISOString() ?? null,
    escalationReason: a.escalationReason as 'manual' | 'sla_breach' | null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    resolutionNote: a.resolutionNote,
    hold: a.holdId ? (holdRefs.get(a.holdId) ?? null) : null,
    case: a.caseId ? (caseRefs.get(a.caseId) ?? null) : null,
    createdAt: a.createdAt.toISOString(),
  };
}

export function toCaseView(
  row: CaseRow,
  merchantRef: string,
  staff: Refs
): z.infer<typeof caseSchema> {
  return {
    id: row.ref,
    merchant: merchantRef,
    status: row.status as 'open',
    severity: row.severity as 'low',
    title: row.title,
    summary: row.summary,
    source: row.source as 'manual',
    assignedTo: row.assignedTo ? (staff.get(row.assignedTo) ?? null) : null,
    outcome: row.outcome as z.infer<typeof caseSchema>['outcome'],
    closedAt: row.closedAt?.toISOString() ?? null,
    strReference: row.strReference,
    strFiledAt: row.strFiledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toScreeningView(
  row: ScreeningRow,
  merchantRef: string | null,
  caseRef: string | null
): z.infer<typeof screeningSchema> {
  return {
    id: row.ref,
    merchant: merchantRef,
    subjectType: row.subjectType as 'merchant',
    subject: row.subjectId,
    provider: row.provider,
    lists: row.lists,
    hitCount: row.hitCount,
    highestScore: row.highestScore,
    status: row.status as 'clear',
    hits: (row.result.hits ?? []) as z.infer<typeof screeningSchema>['hits'],
    screenedAt: row.screenedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    case: caseRef,
  };
}

export function toRuleView(row: RuleRow): z.infer<typeof ruleSchema> {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    ruleType: row.ruleType,
    params: row.params,
    severity: row.severity as 'low',
    action: row.action as 'flag',
    enabled: row.enabled,
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBlocklistView(row: BlocklistRow): z.infer<typeof blocklistEntrySchema> {
  return {
    id: row.ref,
    type: row.entryType as 'msisdn',
    hint: row.valueHint,
    reason: row.reason,
    source: row.source,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toBlockView(
  row: BlockRow,
  merchantRef: string,
  heldCurrencies: readonly string[],
  created?: boolean
): z.infer<typeof blockSchema> {
  return {
    id: row.ref,
    merchant: merchantRef,
    status: row.status as 'active',
    reason: row.reason,
    source: row.source as 'rule',
    heldCurrencies: [...heldCurrencies],
    createdAt: row.createdAt.toISOString(),
    liftedAt: row.liftedAt?.toISOString() ?? null,
    ...(created === undefined ? {} : { created }),
  };
}
