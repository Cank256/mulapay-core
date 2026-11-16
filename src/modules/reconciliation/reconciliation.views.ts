/** API shapes of reconciliation rows. No internal ids; amounts are minor-unit strings. */
import type {
  ExceptionRow,
  NoteRow,
  ResolutionRequestRow,
} from './reconciliation-exceptions.repository';
import type { RunRow } from './reconciliation-runs.repository';
import type { StatementLineRow, StatementRow } from './statements.repository';

export function toRunView(row: RunRow) {
  return {
    id: row.ref,
    kind: row.kind,
    scope: row.scope,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    attempts: row.attempts,
    checked: row.checkedCount,
    matched: row.matchedCount,
    exceptions: row.exceptionCount,
    summary: row.summary,
    error: row.error,
  };
}

export function toExceptionView(
  row: ExceptionRow,
  assignees: ReadonlyMap<string, string> = new Map()
) {
  return {
    id: row.ref,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    environment: row.environment,
    currency: row.currency,
    amountMinor: row.amountMinor?.toString() ?? null,
    expected: row.expected,
    actual: row.actual,
    occurrences: row.occurrences,
    assignedTo: row.assignedTo ? (assignees.get(row.assignedTo) ?? null) : null,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    resolutionEntry: row.resolutionEntryRef,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export function toNoteView(row: NoteRow) {
  return { kind: row.kind, body: row.body, at: row.createdAt.toISOString() };
}

export function toRequestView(row: ResolutionRequestRow, exceptionRef?: string) {
  return {
    id: row.ref,
    ...(exceptionRef ? { exception: exceptionRef } : {}),
    kind: row.kind,
    status: row.status,
    currency: row.currency,
    amountMinor: row.amountMinor?.toString() ?? null,
    payload: row.payload,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    entry: row.entryRef,
  };
}

export function toStatementView(row: StatementRow) {
  return {
    id: row.ref,
    provider: row.provider,
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    rowCount: row.rowCount,
    totalMinor: row.totalMinor.toString(),
    status: row.status,
    matched: row.matchedCount,
    unmatched: row.unmatchedCount,
    mismatch: row.mismatchCount,
    duplicate: row.duplicateCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStatementRowView(row: StatementLineRow) {
  return {
    row: row.rowNo,
    providerRef: row.providerRef,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    occurredAt: row.occurredAt.toISOString(),
    matchStatus: row.matchStatus,
    matchNote: row.matchNote,
  };
}
