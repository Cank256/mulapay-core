/**
 * Scheduled reports (spec 5.2 `report_schedules`): a report type, its filters, a period, a cron
 * and recipients, switched on or off, with an execution history and failure handling.
 *
 * Invariants upheld:
 *  - Each due time produces at most one report: the run row is unique per (schedule, due time),
 *    so a repeated or concurrent tick creates nothing twice. The tick advances `next_run_at`
 *    in the same transaction that creates the run and the report, so a crash leaves both or
 *    neither.
 *  - A run covers the day, week (Monday to Sunday) or month before its due time, in UTC; the
 *    cron's timezone decides when it fires, not the window.
 *  - Recipients are people of the owning business (or staff, for a platform schedule), never an
 *    arbitrary address: a report is financial data, so it is announced to people who can sign in
 *    and download it, not emailed outside the platform.
 *  - A schedule fires at most once an hour. After `REPORT_SCHEDULE_MAX_FAILURES` failed runs in a
 *    row it turns itself off and tells its recipients (`report-generation.service.ts`).
 *  - A merchant's schedule is checked against the merchant's own types and scope, exactly as a
 *    one-off request is.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { CLOCK } from '../../common/tokens';
import { isValidCron, nextOccurrence } from '../settlement/domain/cron';
import { MerchantsRepository } from '../merchants/merchants.repository';
import {
  MERCHANT_SCOPED_TYPES,
  MERCHANT_TYPES,
  STAFF_PERMISSION_BY_TYPE,
  isProblem,
  periodWindow,
  resolveParams,
  type ReportFormat,
  type ReportType,
} from './domain/report-params';
import { ReportsRepository, type RunRow, type ScheduleRow } from './reports.repository';
import { ReportsService, type ReportActor } from './reports.service';

export type SchedulePeriod = 'previous_day' | 'previous_week' | 'previous_month';

export interface ScheduleInput {
  readonly reportType: ReportType;
  readonly params?: Record<string, unknown>;
  readonly period: SchedulePeriod;
  readonly cron: string;
  readonly timezone?: string;
  readonly recipients: readonly string[];
  readonly format?: ReportFormat;
}
export interface SchedulePatch {
  readonly params?: Record<string, unknown>;
  readonly period?: SchedulePeriod;
  readonly cron?: string;
  readonly timezone?: string;
  readonly recipients?: readonly string[];
  readonly format?: ReportFormat;
  readonly active?: boolean;
}

const MIN_INTERVAL_MS = 3600_000;
const TICK_BATCH = 100;

@Injectable()
export class ReportSchedulesService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly reports: ReportsService,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async create(input: ScheduleInput, actor: ReportActor): Promise<ScheduleRow> {
    const timezone = input.timezone ?? 'UTC';
    this.assertCron(input.cron, timezone);
    const { merchantId, environment, createdBy, params } = await this.scopeOf(input, actor);
    this.assertParams(input.reportType, params);
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const recipients = await this.assertRecipients(tx, merchantId, input.recipients);
      const row = await this.repository.insertSchedule(tx, {
        id: uuidv7(now),
        ref: publicId('reportSchedule', now),
        merchantId,
        environment,
        reportType: input.reportType,
        params,
        period: input.period,
        cron: input.cron.trim(),
        timezone,
        recipients,
        format: input.format ?? 'csv',
        nextRunAt: nextOccurrence(input.cron.trim(), timezone, now),
        createdBy,
        createdAt: now,
      });
      await this.audit.record(tx, {
        action: 'report_schedule.created',
        resourceType: 'report_schedule',
        resourceId: row.ref,
        merchantId,
        after: snapshot(row),
      });
      return row;
    });
  }

  async update(ref: string, patch: SchedulePatch, actor: ReportActor): Promise<ScheduleRow> {
    return this.unitOfWork.run(async (tx) => {
      const found = await this.repository.findSchedule(ref, this.visibility(actor), tx);
      if (!found) throw new AppError('NOT_FOUND');
      const schedule = await this.repository.lockSchedule(tx, ref);
      if (!schedule) throw new AppError('NOT_FOUND');
      const cron = patch.cron?.trim() ?? schedule.cron;
      const timezone = patch.timezone ?? schedule.timezone;
      if (patch.cron !== undefined || patch.timezone !== undefined) this.assertCron(cron, timezone);
      if (patch.params !== undefined)
        this.assertParams(schedule.reportType as ReportType, patch.params);
      const recipients = patch.recipients
        ? await this.assertRecipients(tx, schedule.merchantId, patch.recipients)
        : schedule.recipients;
      const now = this.clock.now();
      const reactivating = patch.active === true && !schedule.active;
      const updated = await this.repository.updateSchedule(tx, schedule.id, {
        ...(patch.params !== undefined ? { params: patch.params } : {}),
        ...(patch.period !== undefined ? { period: patch.period } : {}),
        ...(patch.format !== undefined ? { format: patch.format } : {}),
        cron,
        timezone,
        recipients,
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        // Turning a schedule back on starts it afresh: no catching up on what it missed.
        ...(reactivating || patch.cron !== undefined || patch.timezone !== undefined
          ? { nextRunAt: nextOccurrence(cron, timezone, now) }
          : {}),
        ...(reactivating ? { consecutiveFailures: 0, disabledReason: null } : {}),
        ...(patch.active === false ? { disabledReason: 'disabled_by_user' } : {}),
      });
      await this.audit.record(tx, {
        action: 'report_schedule.updated',
        resourceType: 'report_schedule',
        resourceId: schedule.ref,
        merchantId: schedule.merchantId,
        before: snapshot(schedule),
        after: snapshot(updated),
      });
      return updated;
    });
  }

  async remove(ref: string, actor: ReportActor): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const found = await this.repository.findSchedule(ref, this.visibility(actor), tx);
      if (!found) throw new AppError('NOT_FOUND');
      const schedule = await this.repository.lockSchedule(tx, ref);
      if (!schedule) throw new AppError('NOT_FOUND');
      await this.repository.updateSchedule(tx, schedule.id, {
        active: false,
        deletedAt: this.clock.now(),
      });
      await this.audit.record(tx, {
        action: 'report_schedule.deleted',
        resourceType: 'report_schedule',
        resourceId: schedule.ref,
        merchantId: schedule.merchantId,
        before: snapshot(schedule),
      });
    });
  }

  async get(
    ref: string,
    actor: ReportActor
  ): Promise<{ schedule: ScheduleRow; history: RunRow[] }> {
    const schedule = await this.repository.findSchedule(ref, this.visibility(actor));
    if (!schedule) throw new AppError('NOT_FOUND');
    return { schedule, history: await this.repository.history(schedule.id, 20) };
  }

  async list(
    query: { limit: number; cursor?: string },
    actor: ReportActor
  ): Promise<Page<ScheduleRow>> {
    const visibility = this.visibility(actor);
    const fingerprint = filterFingerprint({
      env: visibility.environment,
      platform: visibility.platformOnly,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.listSchedules({
      merchantId: visibility.merchantId,
      environment: visibility.environment,
      platform: visibility.platformOnly,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  /**
   * The worker's minute tick: creates the report of every schedule whose time has come. Each
   * schedule is handled in its own transaction under its row lock.
   */
  async tick(): Promise<number> {
    const now = this.clock.now();
    const due = await this.repository.dueSchedules(now, TICK_BATCH);
    let created = 0;
    for (const { ref } of due) {
      const done = await this.unitOfWork.run((tx) => this.runDue(tx, ref, now));
      if (done) created += 1;
    }
    return created;
  }

  private async runDue(tx: Transaction, ref: string, now: Date): Promise<boolean> {
    const schedule = await this.repository.lockSchedule(tx, ref);
    if (!schedule || !schedule.active || schedule.nextRunAt > now) return false;
    const dueAt = schedule.nextRunAt;
    const next = nextOccurrence(schedule.cron, schedule.timezone, now);
    const run = await this.repository.insertRun(tx, {
      id: uuidv7(now),
      scheduleId: schedule.id,
      dueAt,
      startedAt: now,
    });
    await this.repository.updateSchedule(tx, schedule.id, { lastRunAt: now, nextRunAt: next });
    if (!run) return false;
    const { from, to } = periodWindow(schedule.period as SchedulePeriod, dueAt);
    const resolved = resolveParams(
      schedule.reportType as ReportType,
      { ...schedule.params, from: from.toISOString(), to: to.toISOString() },
      now
    );
    if (isProblem(resolved)) {
      await this.repository.updateRun(tx, run.id, {
        status: 'skipped',
        error: 'bad_params',
        finishedAt: now,
      });
      return false;
    }
    const report = await this.reports.create(tx, {
      type: schedule.reportType as ReportType,
      format: schedule.format as ReportFormat,
      params: resolved.params,
      merchantId: schedule.merchantId,
      environment: (schedule.environment as 'test' | 'live' | null) ?? null,
      requestedBy: schedule.createdBy,
      scheduleId: schedule.id,
    });
    await this.repository.updateRun(tx, run.id, { reportId: report.id });
    return true;
  }

  // -- internals ---------------------------------------------------------------------------

  private assertCron(cron: string, timezone: string): void {
    if (!isValidCron(cron.trim(), timezone)) {
      throw schedule('invalid_cron');
    }
    const first = nextOccurrence(cron.trim(), timezone, this.clock.now());
    const second = nextOccurrence(cron.trim(), timezone, first);
    if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) throw schedule('too_frequent');
  }

  private assertParams(type: ReportType, params: Record<string, unknown>): void {
    // The window comes from the period at each run; check the filters with a sample window.
    const { from: _f, to: _t, ...filters } = params;
    const sample = resolveParams(type, filters, this.clock.now());
    if (isProblem(sample))
      throw schedule('bad_params', { fields: sample.kind === 'invalid' ? sample.fields : [] });
    if (type === 'settlement_statement') throw schedule('type_not_schedulable');
  }

  private async scopeOf(
    input: ScheduleInput,
    actor: ReportActor
  ): Promise<{
    merchantId: string | null;
    environment: 'test' | 'live' | null;
    createdBy: string;
    params: Record<string, unknown>;
  }> {
    const params = { ...(input.params ?? {}) };
    if ('merchant' in actor) {
      if (!MERCHANT_TYPES.includes(input.reportType)) throw schedule('type_not_available');
      delete params.merchant;
      return {
        merchantId: actor.merchant.scope.merchantId,
        environment: actor.merchant.scope.environment,
        createdBy: actor.merchant.userId,
        params,
      };
    }
    const extra = STAFF_PERMISSION_BY_TYPE[input.reportType];
    if (extra && !actor.staff.can(extra)) throw new AppError('FORBIDDEN');
    const ref = typeof params.merchant === 'string' ? params.merchant : undefined;
    delete params.merchant;
    if (!ref) {
      if (MERCHANT_SCOPED_TYPES.includes(input.reportType)) throw schedule('merchant_required');
      return { merchantId: null, environment: null, createdBy: actor.staff.userId, params };
    }
    const merchant = await this.merchants.findByRef(ref);
    if (!merchant) throw new AppError('NOT_FOUND');
    return { merchantId: merchant.id, environment: 'live', createdBy: actor.staff.userId, params };
  }

  private async assertRecipients(
    tx: Transaction,
    merchantId: string | null,
    recipients: readonly string[]
  ): Promise<string[]> {
    const wanted = [...new Set(recipients.map((r) => r.trim().toLowerCase()))];
    const known = merchantId
      ? await this.repository.memberEmails(tx, merchantId, wanted)
      : await this.repository.staffEmails(tx, wanted);
    const unknown = wanted.filter((r) => !known.includes(r));
    if (unknown.length > 0 || wanted.length === 0) throw schedule('unknown_recipient');
    return wanted;
  }

  private visibility(actor: ReportActor): {
    merchantId?: string;
    environment?: string;
    platformOnly?: boolean;
  } {
    return 'merchant' in actor
      ? {
          merchantId: actor.merchant.scope.merchantId,
          environment: actor.merchant.scope.environment,
        }
      : { platformOnly: true };
  }
}

function schedule(reason: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('REPORT_INVALID', {
    messageParams: { reason },
    details: { reason, ...details },
  });
}

function snapshot(row: ScheduleRow): Record<string, unknown> {
  return {
    type: row.reportType,
    period: row.period,
    cron: row.cron,
    timezone: row.timezone,
    recipients: row.recipients.length,
    format: row.format,
    active: row.active,
    nextRunAt: row.nextRunAt.toISOString(),
  };
}
