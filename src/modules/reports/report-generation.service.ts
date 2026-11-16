/**
 * Generates one report (spec 6.12): rows stream from a server-side database cursor, through a
 * CSV or JSON encoder, into a multipart upload to object storage. At no point is more than one
 * fetch batch of rows, plus one upload part, in memory, however many rows the report has.
 *
 * Invariants upheld:
 *  - Claiming is under the report's row lock with a lease, so two workers holding the same job
 *    cannot both generate; a worker that died is replaced after the lease lapses. A report that
 *    is ready, failed or expired is left alone, which makes the job idempotent: a second run has
 *    no effect, and the object key is deterministic, so even a repeated upload overwrites the
 *    same bytes.
 *  - Success is recorded in one transaction with the file's key, size, row count and SHA-256 and
 *    the seven-day expiry; the requester is notified in the same transaction.
 *  - A failure before the last attempt puts the report back to `queued` for the retry (BullMQ
 *    spaces them); on the last attempt the report is `failed` with a short error code, the
 *    requester is told, and a schedule that keeps failing turns itself off after
 *    `REPORT_SCHEDULE_MAX_FAILURES` runs in a row.
 *  - A report past `REPORT_MAX_ROWS` fails with `report_too_large` rather than filling storage.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { toLoggableError } from '../../common/logging/redaction';
import { reportDuration, reportsFinished } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { OBJECT_STORAGE, type ObjectStorage } from '../../integrations/storage/object-storage.port';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { NotificationsService } from '../notifications/notifications.service';
import {
  JSON_CLOSE,
  JSON_OPEN,
  contentTypeOf,
  csvHeader,
  csvRow,
  extensionOf,
  jsonRow,
} from './domain/report-format';
import type { ReportFormat, ReportType } from './domain/report-params';
import { REPORT_DEFINITIONS, type ReportScope } from './report-queries';
import { ReportStreamRepository } from './report-stream.repository';
import { ReportsRepository, type ReportRow } from './reports.repository';
import { REPORT_FILE_TTL_MS } from './reports.service';

/** A worker's claim on a report. Generous: a large report can take minutes. */
const LEASE_MS = 15 * 60 * 1000;
export const REPORT_MAX_ATTEMPTS = 3;

export type GenerateOutcome = 'ready' | 'failed' | 'retry' | 'skipped';

class ReportTooLargeError extends Error {
  constructor() {
    super('report_too_large');
    this.name = 'ReportTooLargeError';
  }
}

@Injectable()
export class ReportGenerationService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly stream: ReportStreamRepository,
    private readonly merchants: MerchantsRepository,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async generate(reportId: string): Promise<GenerateOutcome> {
    const claimed = await this.claim(reportId);
    if (!claimed) return 'skipped';
    const started = process.hrtime.bigint();
    try {
      const done = await this.write(claimed);
      await this.succeed(claimed, done);
      reportDuration.observe(
        { type: claimed.type },
        Number(process.hrtime.bigint() - started) / 1e9
      );
      reportsFinished.inc({ type: claimed.type, outcome: 'ready' });
      return 'ready';
    } catch (error) {
      return this.fail(claimed, error);
    }
  }

  private async claim(reportId: string): Promise<ReportRow | undefined> {
    return this.unitOfWork.run(async (tx) => {
      const report = await this.repository.lockById(tx, reportId);
      if (!report) return undefined;
      const now = this.clock.now();
      if (report.status === 'ready' || report.status === 'failed' || report.status === 'expired') {
        return undefined;
      }
      if (report.status === 'running' && report.leaseExpiresAt && report.leaseExpiresAt > now) {
        return undefined;
      }
      return this.repository.update(tx, report.id, {
        status: 'running',
        attempts: report.attempts + 1,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        startedAt: report.startedAt ?? now,
        error: null,
      });
    });
  }

  private async write(
    report: ReportRow
  ): Promise<{ key: string; rows: number; size: number; sha256: string }> {
    const definition = REPORT_DEFINITIONS[report.type as ReportType];
    const format = report.format as ReportFormat;
    const scope = await this.scopeOf(report);
    const params = report.params;
    const from = typeof params.from === 'string' ? new Date(params.from) : null;
    const to = typeof params.to === 'string' ? new Date(params.to) : null;
    const query = definition.build(scope, params, from, to);
    const key = `reports/${scope.merchantRef ?? 'platform'}/${report.environment ?? 'platform'}/${report.ref}.${extensionOf(format)}`;
    const batchSize = this.config.REPORT_CURSOR_BATCH_SIZE;
    const maxRows = this.config.REPORT_MAX_ROWS;
    const stream = this.stream;
    let rows = 0;

    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from(format === 'csv' ? csvHeader(definition.columns) : JSON_OPEN);
      for await (const batch of stream.batches(query, batchSize)) {
        const parts: string[] = [];
        for (const row of batch) {
          if (rows >= maxRows) throw new ReportTooLargeError();
          parts.push(
            format === 'csv'
              ? csvRow(definition.columns, row)
              : jsonRow(definition.columns, row, rows === 0)
          );
          rows += 1;
        }
        yield Buffer.from(parts.join(''));
      }
      if (format === 'json') yield Buffer.from(JSON_CLOSE);
    }

    const stored = await this.storage.putStream('reports', key, chunks(), contentTypeOf(format), {
      partBytes: this.config.REPORT_MULTIPART_PART_BYTES,
    });
    return { key, rows, size: stored.sizeBytes, sha256: stored.sha256Hex };
  }

  private async succeed(
    report: ReportRow,
    done: { key: string; rows: number; size: number; sha256: string }
  ): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      await this.repository.update(tx, report.id, {
        status: 'ready',
        rowCount: done.rows,
        fileKey: done.key,
        fileSize: done.size,
        sha256: done.sha256,
        finishedAt: now,
        expiresAt: new Date(now.getTime() + REPORT_FILE_TTL_MS),
        leaseExpiresAt: null,
        error: null,
      });
      await this.finishRun(tx, report, 'succeeded', null);
      await this.notifyRequester(tx, report, 'report.ready');
      await this.audit.record(tx, {
        action: 'report.generated',
        resourceType: 'report',
        resourceId: report.ref,
        merchantId: report.merchantId,
        after: { rows: done.rows, bytes: done.size, sha256: done.sha256 },
        actor: { type: 'job', id: 'report-generate', label: 'report generation' },
      });
    });
  }

  private async fail(report: ReportRow, error: unknown): Promise<GenerateOutcome> {
    const code = error instanceof ReportTooLargeError ? 'report_too_large' : 'generation_failed';
    this.logger.error(
      {
        report: report.ref,
        type: report.type,
        attempt: report.attempts,
        code,
        err: toLoggableError(error),
      },
      'report generation failed'
    );
    const final = error instanceof ReportTooLargeError || report.attempts >= REPORT_MAX_ATTEMPTS;
    await this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      if (!final) {
        await this.repository.update(tx, report.id, {
          status: 'queued',
          leaseExpiresAt: null,
          error: code,
        });
        return;
      }
      await this.repository.update(tx, report.id, {
        status: 'failed',
        finishedAt: now,
        leaseExpiresAt: null,
        error: code,
      });
      await this.finishRun(tx, report, 'failed', code);
      await this.notifyRequester(tx, report, 'report.failed');
      await this.audit.record(tx, {
        action: 'report.failed',
        resourceType: 'report',
        resourceId: report.ref,
        merchantId: report.merchantId,
        after: { code, attempts: report.attempts },
        actor: { type: 'job', id: 'report-generate', label: 'report generation' },
      });
    });
    if (!final) return 'retry';
    reportsFinished.inc({ type: report.type, outcome: 'failed' });
    return 'failed';
  }

  /** Records the outcome on the schedule's run, and turns a schedule off after repeated failures. */
  private async finishRun(
    tx: Transaction,
    report: ReportRow,
    status: 'succeeded' | 'failed',
    error: string | null
  ): Promise<void> {
    if (!report.scheduleId) return;
    const now = this.clock.now();
    const run = await this.repository.runForReport(tx, report.id);
    if (run && run.status === 'queued') {
      await this.repository.updateRun(tx, run.id, { status, error, finishedAt: now });
    }
    const schedule = await this.repository.lockScheduleById(tx, report.scheduleId);
    if (!schedule) return;
    const failures = status === 'failed' ? schedule.consecutiveFailures + 1 : 0;
    const stop = status === 'failed' && failures >= this.config.REPORT_SCHEDULE_MAX_FAILURES;
    await this.repository.updateSchedule(tx, schedule.id, {
      lastStatus: status,
      consecutiveFailures: failures,
      ...(stop ? { active: false, disabledReason: 'repeated_failures' } : {}),
    });
    if (stop) {
      await this.notifyUsers(
        tx,
        schedule.createdBy,
        schedule.recipients,
        'report_schedule.disabled',
        {
          schedule_ref: schedule.ref,
        },
        schedule.ref
      );
      await this.audit.record(tx, {
        action: 'report_schedule.disabled',
        resourceType: 'report_schedule',
        resourceId: schedule.ref,
        merchantId: schedule.merchantId,
        after: { reason: 'repeated_failures', failures },
        actor: { type: 'job', id: 'report-generate', label: 'report generation' },
      });
    }
  }

  private async notifyRequester(
    tx: Transaction,
    report: ReportRow,
    template: string
  ): Promise<void> {
    const variables = { report_ref: report.ref, report_type: report.type };
    if (report.scheduleId) {
      const schedule = await this.repository.lockScheduleById(tx, report.scheduleId);
      if (schedule) {
        await this.notifyUsers(
          tx,
          schedule.createdBy,
          schedule.recipients,
          template,
          variables,
          report.ref
        );
        return;
      }
    }
    if (!report.requestedBy) return;
    await this.notifications.notify(tx, {
      templateCode: template,
      audience: { kind: 'user', userId: report.requestedBy },
      resourceKey: report.ref,
      sourceKey: `${template}:${report.ref}`,
      variables,
    });
  }

  private async notifyUsers(
    tx: Transaction,
    creator: string,
    emails: readonly string[],
    template: string,
    variables: Record<string, string>,
    resource: string
  ): Promise<void> {
    const ids = await this.repository.userIdsByEmail(tx, emails);
    await this.notifications.notify(tx, {
      templateCode: template,
      audience: { kind: 'users', userIds: ids.length > 0 ? ids : [creator] },
      resourceKey: resource,
      sourceKey: `${template}:${resource}`,
      variables,
    });
  }

  private async scopeOf(report: ReportRow): Promise<ReportScope> {
    const environment = (report.environment ?? 'live') as 'test' | 'live';
    if (!report.merchantId) return { environment };
    const merchant = await this.merchants.findById(report.merchantId);
    if (!merchant) throw new Error('report merchant is gone');
    return { environment, merchantId: merchant.id, merchantRef: merchant.ref };
  }
}
