/**
 * AML alerts (spec 6.13): raised by monitoring rules, worked by analysts, escalated when
 * their SLA passes.
 *
 * Invariants upheld:
 *  - One alert per rule and transaction (a unique index), so running the monitoring job twice
 *    for a transaction raises nothing new.
 *  - An alert carries `due_at` from the moment it exists, set from its severity
 *    (`AML_ALERT_SLA_HOURS_*`). The sweep escalates an unworked alert past that time, once,
 *    in its own transaction under the alert's row lock, so two workers cannot both do it.
 *  - Every change (assign, escalate, resolve, SLA escalation) writes an audit row in the same
 *    transaction. A resolved alert is final.
 *  - Resolving as a false positive releases the hold the alert placed, if any. Resolving as
 *    confirmed leaves it for the case to decide. Neither ever touches a ledger entry.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import type { Transaction } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import { toLoggableError } from '../../../common/logging/redaction';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import {
  amlAlertSlaBreaches,
  amlAlertsOpen,
  amlAlertsRaised,
} from '../../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../../common/tokens';
import { HoldsService } from '../../holds/holds.service';
import {
  isOverdue,
  nextAlertStatus,
  type AlertStatus,
  type ResolveOutcome,
} from '../domain/alert-state';
import type { Details, Severity } from '../domain/rule-evaluation';
import { AmlAlertsRepository, type AlertFilter, type AlertRow } from './aml-alerts.repository';

export interface RaiseAlertInput {
  readonly ruleCode: string;
  readonly ruleVersion: number;
  readonly ruleType: string;
  readonly severity: Severity;
  readonly action: 'flag' | 'hold' | 'block';
  readonly merchantId: string;
  readonly transactionId: string;
  readonly score: number;
  readonly details: Details;
  readonly dueAt: Date;
}

export interface ListAlertsQuery {
  readonly status?: AlertStatus;
  readonly severity?: string;
  readonly merchantId?: string;
  readonly assignedTo?: string;
  readonly ruleCode?: string;
  readonly overdue?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

export type AlertDetail = NonNullable<Awaited<ReturnType<AmlAlertsRepository['detail']>>>;
export type AlertListItem = Awaited<ReturnType<AmlAlertsRepository['list']>>[number];

const SWEEP_BATCH = 200;

function snapshot(alert: AlertRow): Record<string, unknown> {
  return {
    status: alert.status,
    assignedTo: alert.assignedTo,
    escalationReason: alert.escalationReason,
    resolutionNote: alert.resolutionNote,
  };
}

@Injectable()
export class AmlAlertsService {
  constructor(
    private readonly alerts: AmlAlertsRepository,
    private readonly holds: HoldsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Raises an alert inside the caller's transaction; `created` is false for a repeat. */
  async raise(
    tx: Transaction,
    input: RaiseAlertInput
  ): Promise<{ alert: AlertRow; created: boolean }> {
    const now = this.clock.now();
    const inserted = await this.alerts.insert(tx, {
      id: uuidv7(now),
      ref: publicId('amlAlert', now),
      ruleCode: input.ruleCode,
      ruleVersion: input.ruleVersion,
      severity: input.severity,
      merchantId: input.merchantId,
      transactionId: input.transactionId,
      score: input.score,
      details: input.details,
      action: input.action,
      dueAt: input.dueAt,
    });
    if (!inserted) {
      const existing = await this.alerts.findByRuleAndTransaction(
        input.ruleCode,
        input.transactionId,
        tx
      );
      if (!existing) throw new Error('alert conflict without an existing alert');
      return { alert: existing, created: false };
    }
    await this.audit.record(tx, {
      action: 'aml.alert.raised',
      resourceType: 'aml_alert',
      resourceId: inserted.ref,
      merchantId: inserted.merchantId,
      after: {
        rule: inserted.ruleCode,
        ruleVersion: inserted.ruleVersion,
        severity: inserted.severity,
        action: inserted.action,
        score: inserted.score,
        dueAt: inserted.dueAt.toISOString(),
      },
      actor: { type: 'job', id: 'aml-monitoring', label: 'AML transaction monitoring' },
    });
    amlAlertsRaised.inc({
      rule_type: input.ruleType,
      severity: input.severity,
      action: input.action,
    });
    return { alert: inserted, created: true };
  }

  async get(ref: string): Promise<AlertDetail> {
    const found = await this.alerts.detail(ref);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  async list(query: ListAlertsQuery): Promise<Page<AlertListItem>> {
    const now = this.clock.now();
    const fingerprint = filterFingerprint({
      status: query.status,
      severity: query.severity,
      merchant: query.merchantId,
      assignee: query.assignedTo,
      rule: query.ruleCode,
      overdue: query.overdue,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const filter: AlertFilter = {
      statuses: query.status ? [query.status] : undefined,
      severity: query.severity,
      merchantId: query.merchantId,
      assignedTo: query.assignedTo,
      ruleCode: query.ruleCode,
      overdueAt: query.overdue ? now : undefined,
      after,
      limit: query.limit,
    };
    const rows = await this.alerts.list(filter);
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.createdAt,
      id: r.row.ref,
    }));
  }

  async assign(ref: string, assigneeUserId: string, assigneeRef: string): Promise<AlertRow> {
    return this.unitOfWork.run(async (tx) => {
      const alert = await this.lock(tx, ref);
      const next = nextAlertStatus(alert.status as AlertStatus, 'assign');
      const updated = await this.alerts.update(tx, alert.id, {
        status: next,
        assignedTo: assigneeUserId,
      });
      await this.audit.record(tx, {
        action: 'aml.alert.assigned',
        resourceType: 'aml_alert',
        resourceId: updated.ref,
        merchantId: updated.merchantId,
        before: snapshot(alert),
        after: { ...snapshot(updated), assignee: assigneeRef },
      });
      return updated;
    });
  }

  async escalate(ref: string, note: string | undefined): Promise<AlertRow> {
    return this.unitOfWork.run(async (tx) => {
      const alert = await this.lock(tx, ref);
      const next = nextAlertStatus(alert.status as AlertStatus, 'escalate');
      return this.escalateLocked(tx, alert, next, 'manual', note);
    });
  }

  async resolve(
    ref: string,
    outcome: ResolveOutcome,
    note: string,
    resolverUserId: string,
    releaseHold?: boolean
  ): Promise<AlertRow> {
    return this.unitOfWork.run(async (tx) => {
      const alert = await this.lock(tx, ref);
      const next = nextAlertStatus(alert.status as AlertStatus, 'resolve', outcome);
      const updated = await this.alerts.update(tx, alert.id, {
        status: next,
        resolvedBy: resolverUserId,
        resolvedAt: this.clock.now(),
        resolutionNote: note,
      });
      const release = releaseHold ?? outcome === 'closed_false_positive';
      if (release && alert.holdId) {
        await this.holds.release(tx, alert.holdId, `aml-alert-release:${alert.ref}`);
      }
      await this.audit.record(tx, {
        action: 'aml.alert.resolved',
        resourceType: 'aml_alert',
        resourceId: updated.ref,
        merchantId: updated.merchantId,
        before: snapshot(alert),
        after: { ...snapshot(updated), holdReleased: release && alert.holdId !== null },
      });
      return updated;
    });
  }

  /**
   * Escalates every alert past `due_at` (spec 6.13: "escalate when breached"). Idempotent: an
   * escalated alert is no longer overdue. One alert failing does not stop the rest.
   */
  async sweepOverdue(): Promise<{ escalated: number; failed: number }> {
    const ids = await this.alerts.overdueIds(this.clock.now(), SWEEP_BATCH);
    let escalated = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const done = await this.unitOfWork.run(async (tx) => {
          const alert = await this.alerts.lockById(tx, id);
          if (
            !alert ||
            !isOverdue(
              { status: alert.status as AlertStatus, dueAt: alert.dueAt },
              this.clock.now()
            )
          ) {
            return false;
          }
          await this.escalateLocked(tx, alert, 'escalated', 'sla_breach', undefined);
          amlAlertSlaBreaches.inc({ severity: alert.severity });
          return true;
        });
        if (done) escalated += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: toLoggableError(error), alertId: id }, 'alert escalation failed');
      }
    }
    return { escalated, failed };
  }

  /** Brings `core_aml_alerts_open` up to date from the database. */
  async refreshGauge(): Promise<void> {
    const counts = await this.alerts.openCountsBySeverity();
    for (const severity of ['low', 'medium', 'high', 'critical']) {
      amlAlertsOpen.set({ severity }, counts.find((c) => c.severity === severity)?.n ?? 0);
    }
  }

  private async escalateLocked(
    tx: Transaction,
    alert: AlertRow,
    next: AlertStatus,
    reason: 'manual' | 'sla_breach',
    note: string | undefined
  ): Promise<AlertRow> {
    const updated = await this.alerts.update(tx, alert.id, {
      status: next,
      escalatedAt: this.clock.now(),
      escalationReason: reason,
    });
    await this.audit.record(tx, {
      action: reason === 'sla_breach' ? 'aml.alert.sla_breached' : 'aml.alert.escalated',
      resourceType: 'aml_alert',
      resourceId: updated.ref,
      merchantId: updated.merchantId,
      before: snapshot(alert),
      after: {
        ...snapshot(updated),
        escalationReason: reason,
        ...(note ? { noteLength: note.length } : {}),
      },
      ...(reason === 'sla_breach'
        ? { actor: { type: 'job' as const, id: 'aml-sla-sweep', label: 'AML SLA sweep' } }
        : {}),
    });
    return updated;
  }

  private async lock(tx: Transaction, ref: string): Promise<AlertRow> {
    const alert = await this.alerts.lockByRef(tx, ref);
    if (!alert) throw new AppError('NOT_FOUND');
    return alert;
  }
}
