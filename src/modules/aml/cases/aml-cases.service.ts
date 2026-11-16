/**
 * AML cases (spec 6.13): a case gathers the alerts about one merchant, carries the analysts'
 * notes, ends with an outcome, and is the unit an STR package is exported from.
 *
 * Invariants upheld:
 *  - An alert belongs to at most one case, and only to a case of its own merchant (a foreign
 *    key on `aml_alerts.case_id`, checked here first).
 *  - Closing a case needs an outcome; a closed case keeps its title, summary, assignee and
 *    outcome (the database refuses changes). Notes are append-only and may still be added.
 *  - The STR filing (reference and time) is recorded once.
 *  - Every change writes an audit row in the same transaction. Note text is not copied into
 *    the audit row: it can hold personal data. The row carries the note's id and length.
 *  - A case never changes a ledger entry or a transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import type { Transaction } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import { CLOCK } from '../../../common/tokens';
import { AuditLogsService, type AuditLogView } from '../../audit/audit-logs.service';
import { MerchantsRepository } from '../../merchants/merchants.repository';
import { AmlAlertsRepository } from '../alerts/aml-alerts.repository';
import {
  AmlCasesRepository,
  type CasePatch,
  type CaseRow,
  type NoteRow,
  type StrPackageRow,
} from './aml-cases.repository';

export const CASE_OUTCOMES = [
  'no_action',
  'false_positive',
  'suspicious_activity_reported',
  'merchant_blocked',
  'merchant_offboarded',
] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];
export type CaseSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface OpenCaseInput {
  readonly merchantId: string;
  readonly severity: CaseSeverity;
  readonly title: string;
  readonly summary?: string;
  readonly source: 'screening' | 'alert' | 'manual';
  readonly openedBy?: string;
  readonly alertIds?: readonly string[];
}

export interface UpdateCaseInput {
  readonly assigneeUserId?: string | null;
  readonly status?: 'investigating' | 'closed';
  readonly outcome?: CaseOutcome;
  readonly title?: string;
  readonly summary?: string;
  readonly severity?: CaseSeverity;
  readonly note?: string;
  readonly addAlertRefs?: readonly string[];
  /** Records that the STR was filed with the authority. Once. */
  readonly strReference?: string;
}

export interface CaseDetail {
  readonly row: CaseRow;
  readonly merchantRef: string;
  readonly alerts: Awaited<ReturnType<AmlCasesRepository['alertsOf']>>;
  readonly notes: NoteRow[];
  readonly strPackages: StrPackageRow[];
  readonly history: AuditLogView[];
}

function refuse(reason: string): AppError {
  return new AppError('AML_TRANSITION_INVALID', { messageParams: { reason }, details: { reason } });
}

function snapshot(row: CaseRow): Record<string, unknown> {
  return {
    status: row.status,
    severity: row.severity,
    title: row.title,
    assignedTo: row.assignedTo,
    outcome: row.outcome,
    strReference: row.strReference,
  };
}

@Injectable()
export class AmlCasesService {
  constructor(
    private readonly cases: AmlCasesRepository,
    private readonly alerts: AmlAlertsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly auditLogs: AuditLogsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Opens a case inside the caller's transaction (screening, monitoring, analyst). */
  async openInTx(tx: Transaction, input: OpenCaseInput): Promise<CaseRow> {
    const now = this.clock.now();
    const row = await this.cases.insert(tx, {
      id: uuidv7(now),
      ref: publicId('amlCase', now),
      merchantId: input.merchantId,
      severity: input.severity,
      title: input.title,
      summary: input.summary ?? '',
      source: input.source,
      openedBy: input.openedBy ?? null,
    });
    const attached = await this.cases.attachAlerts(
      tx,
      row.id,
      input.merchantId,
      input.alertIds ?? []
    );
    await this.audit.record(tx, {
      action: 'aml.case.opened',
      resourceType: 'aml_case',
      resourceId: row.ref,
      merchantId: row.merchantId,
      after: { ...snapshot(row), source: row.source, alerts: attached.length },
      ...(input.openedBy ? {} : { actor: { type: 'system' as const, id: 'aml', label: 'AML' } }),
    });
    return row;
  }

  /** An analyst opens a case for a merchant, optionally attaching its open alerts. */
  async create(
    input: {
      merchantRef: string;
      title: string;
      summary?: string;
      severity: CaseSeverity;
      alertRefs?: readonly string[];
    },
    actorUserId: string
  ): Promise<CaseRow> {
    const merchant = await this.merchants.findByRef(input.merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    return this.unitOfWork.run(async (tx) => {
      const found = await this.alerts.findByRefs(merchant.id, input.alertRefs ?? [], tx);
      if (found.length !== new Set(input.alertRefs ?? []).size) throw new AppError('NOT_FOUND');
      if (found.some((a) => a.caseId !== null)) throw refuse('alert_in_a_case');
      return this.openInTx(tx, {
        merchantId: merchant.id,
        severity: input.severity,
        title: input.title,
        summary: input.summary,
        source: 'manual',
        openedBy: actorUserId,
        alertIds: found.map((a) => a.id),
      });
    });
  }

  async update(ref: string, input: UpdateCaseInput, actorUserId: string): Promise<CaseRow> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.cases.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      const closed = current.status === 'closed';
      const patch: CasePatch = {};
      let closing = false;

      if (input.status === 'closed') {
        if (closed) throw refuse('case_closed');
        if (!input.outcome) throw refuse('outcome_required');
        patch.status = 'closed';
        patch.outcome = input.outcome;
        patch.closedBy = actorUserId;
        patch.closedAt = this.clock.now();
        closing = true;
      } else if (input.status === 'investigating') {
        if (current.status !== 'open')
          throw refuse(closed ? 'case_closed' : 'already_investigating');
        patch.status = 'investigating';
      } else if (input.outcome !== undefined) {
        throw refuse('outcome_needs_close');
      }

      const editsCase =
        input.assigneeUserId !== undefined ||
        input.title !== undefined ||
        input.summary !== undefined ||
        input.severity !== undefined ||
        (input.addAlertRefs?.length ?? 0) > 0;
      if (closed && editsCase) throw refuse('case_closed');
      if (input.assigneeUserId !== undefined) patch.assignedTo = input.assigneeUserId;
      if (input.title !== undefined) patch.title = input.title;
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.severity !== undefined) patch.severity = input.severity;
      if (input.strReference !== undefined) {
        if (current.strFiledAt !== null) throw refuse('str_already_recorded');
        patch.strFiledAt = this.clock.now();
        patch.strReference = input.strReference;
      }
      // An analyst working an open case moves it to investigating.
      if (patch.status === undefined && current.status === 'open' && editsCase) {
        patch.status = 'investigating';
      }

      let attached: string[] = [];
      if (input.addAlertRefs?.length) {
        const found = await this.alerts.findByRefs(current.merchantId, input.addAlertRefs, tx);
        if (found.length !== new Set(input.addAlertRefs).size) throw new AppError('NOT_FOUND');
        if (found.some((a) => a.caseId !== null && a.caseId !== current.id)) {
          throw refuse('alert_in_another_case');
        }
        attached = await this.cases.attachAlerts(
          tx,
          current.id,
          current.merchantId,
          found.map((a) => a.id)
        );
      }

      const updated =
        Object.keys(patch).length > 0 ? await this.cases.update(tx, current.id, patch) : current;

      if (input.note !== undefined) {
        const note = await this.cases.insertNote(tx, {
          id: uuidv7(this.clock.now()),
          caseId: current.id,
          authorId: actorUserId,
          body: input.note,
        });
        await this.audit.record(tx, {
          action: 'aml.case.note_added',
          resourceType: 'aml_case',
          resourceId: current.ref,
          merchantId: current.merchantId,
          after: { noteId: note.id, length: input.note.length },
        });
      }
      if (attached.length > 0) {
        await this.audit.record(tx, {
          action: 'aml.case.alerts_attached',
          resourceType: 'aml_case',
          resourceId: current.ref,
          merchantId: current.merchantId,
          after: { alerts: attached.length },
        });
      }
      if (Object.keys(patch).length > 0) {
        await this.audit.record(tx, {
          action: closing
            ? 'aml.case.closed'
            : patch.strReference
              ? 'aml.case.str_recorded'
              : 'aml.case.updated',
          resourceType: 'aml_case',
          resourceId: current.ref,
          merchantId: current.merchantId,
          before: snapshot(current),
          after: snapshot(updated),
        });
      }
      return updated;
    });
  }

  async get(ref: string): Promise<CaseDetail> {
    const row = await this.cases.findByRef(ref);
    if (!row) throw new AppError('NOT_FOUND');
    const merchant = await this.merchants.findById(row.merchantId);
    const [alerts, notes, strPackages, history] = await Promise.all([
      this.cases.alertsOf(row.id),
      this.cases.notes(row.id),
      this.cases.strPackages(row.id),
      this.auditLogs.list({ resourceType: 'aml_case', resourceId: row.ref, limit: 200 }),
    ]);
    return {
      row,
      merchantRef: merchant?.ref ?? '',
      alerts,
      notes,
      strPackages,
      history: history.items.reverse(),
    };
  }

  async list(query: {
    status?: string;
    merchantId?: string;
    assignedTo?: string;
    open?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<Awaited<ReturnType<AmlCasesRepository['list']>>[number]>> {
    const fingerprint = filterFingerprint({
      status: query.status,
      merchant: query.merchantId,
      assignee: query.assignedTo,
      open: query.open,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.cases.list({ ...query, after });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.createdAt,
      id: r.row.ref,
    }));
  }
}
