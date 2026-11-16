/**
 * Reports (spec 6.12): always asynchronous. A request validates its parameters, writes a
 * `queued` report and an outbox row in one transaction and returns at once (the controller
 * answers 202 with the report ref); a worker streams the file into object storage; the owner
 * downloads it through a presigned link that lasts 15 minutes; the file is deleted after seven
 * days.
 *
 * Invariants upheld:
 *  - A merchant can request only the types about its own money, only for its own data and the
 *    environment of its request; the merchant is taken from the session, never from a parameter.
 *    Another merchant's report is "not found". Staff need `reports:platform` plus the permission
 *    of the data a type exposes (the ledger, the audit trail, AML, KYC, reconciliation).
 *  - One merchant can have `REPORT_MAX_ACTIVE_PER_MERCHANT` reports queued or running at a time.
 *  - A report's parameters are fixed when it is requested (the window is stored as dates), so the
 *    same request always produces the same report.
 *  - A download link is only issued for a ready, unexpired report, is audited, and expires in
 *    exactly 15 minutes whatever `PRESIGN_DOWNLOAD_TTL_SECONDS` says.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { OutboxService } from '../../common/outbox/outbox.service';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { reportsFinished } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { OBJECT_STORAGE, type ObjectStorage } from '../../integrations/storage/object-storage.port';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { extensionOf } from './domain/report-format';
import {
  MERCHANT_SCOPED_TYPES,
  MERCHANT_TYPES,
  STAFF_PERMISSION_BY_TYPE,
  isProblem,
  resolveParams,
  type ReportFormat,
  type ReportType,
} from './domain/report-params';
import { ReportsRepository, type ReportRow, type ReportWithRefs } from './reports.repository';

export const REPORT_REQUESTED_OUTBOX_TYPE = 'report.requested';
/** Spec 6.12: a presigned download link is valid for 15 minutes. */
export const REPORT_LINK_TTL_SECONDS = 15 * 60;
/** Spec 6.12: files expire after 7 days. */
export const REPORT_FILE_TTL_MS = 7 * 24 * 3600_000;

export type ReportActor =
  | { readonly merchant: { readonly scope: MerchantScope; readonly userId: string } }
  | {
      readonly staff: {
        readonly userId: string;
        readonly userRef: string;
        readonly can: (permission: string) => boolean;
      };
    };

export interface ReportRequest {
  readonly type: ReportType;
  readonly format?: ReportFormat | 'xlsx' | 'pdf';
  readonly params?: Record<string, unknown>;
}

export interface DownloadLink {
  readonly url: string;
  readonly expiresAt: Date;
  readonly filename: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Queues a report. Returns it `queued`; the file arrives asynchronously. */
  async request(input: ReportRequest, actor: ReportActor): Promise<ReportWithRefs> {
    const format = input.format ?? 'csv';
    if (format !== 'csv' && format !== 'json') {
      throw invalid('format_not_supported', { format });
    }
    this.assertAllowed(input.type, actor);
    const now = this.clock.now();
    const resolved = resolveParams(input.type, input.params, now);
    if (isProblem(resolved)) {
      throw invalid(resolved.kind === 'window' ? 'window_too_long' : 'bad_params', {
        ...(resolved.kind === 'window'
          ? { maxDays: resolved.maxDays }
          : { fields: resolved.fields }),
      });
    }
    const { merchantId, environment, requestedBy, params } = await this.scopeOf(
      input.type,
      resolved.params,
      actor
    );
    const report = await this.unitOfWork.run(async (tx) => {
      if (input.type === 'settlement_statement' && merchantId) {
        await this.assertSettlementOf(tx, merchantId, params.settlement as string);
      }
      const active = await this.repository.activeCount(tx, merchantId, requestedBy);
      if (active >= this.config.REPORT_MAX_ACTIVE_PER_MERCHANT) {
        throw new AppError('REPORT_LIMIT_REACHED', {
          details: { limit: this.config.REPORT_MAX_ACTIVE_PER_MERCHANT },
          retryAfterSeconds: 30,
        });
      }
      return this.create(tx, {
        type: input.type,
        format,
        params,
        merchantId,
        environment,
        requestedBy,
      });
    });
    const found = await this.repository.findByRef(report.ref);
    if (!found) throw new Error('report vanished after creation');
    return found;
  }

  /**
   * Creates the queued report and its outbox row inside the caller's transaction. Used by
   * `request` and by the schedule tick.
   */
  async create(
    tx: Transaction,
    input: {
      type: ReportType;
      format: ReportFormat;
      params: Record<string, unknown>;
      merchantId: string | null;
      environment: 'test' | 'live' | null;
      requestedBy: string;
      scheduleId?: string;
    }
  ): Promise<ReportRow> {
    const now = this.clock.now();
    const row = await this.repository.insert(tx, {
      id: uuidv7(now),
      ref: publicId('report', now),
      merchantId: input.merchantId,
      environment: input.environment,
      type: input.type,
      format: input.format,
      params: input.params,
      requestedBy: input.requestedBy,
      scheduleId: input.scheduleId ?? null,
      createdAt: now,
    });
    await this.outbox.enqueue(tx, {
      eventType: REPORT_REQUESTED_OUTBOX_TYPE,
      aggregateType: 'report',
      aggregateId: row.id,
      payload: { reportId: row.id },
      dedupeKey: `report:${row.id}`,
    });
    await this.audit.record(tx, {
      action: 'report.requested',
      resourceType: 'report',
      resourceId: row.ref,
      merchantId: row.merchantId,
      after: { type: row.type, format: row.format, scheduled: input.scheduleId !== undefined },
    });
    return row;
  }

  async get(ref: string, actor: ReportActor): Promise<ReportWithRefs> {
    const found = await this.repository.findByRef(ref, this.visibility(actor));
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  async list(
    query: { type?: ReportType; status?: string; limit: number; cursor?: string },
    actor: ReportActor
  ): Promise<Page<ReportWithRefs>> {
    const visibility = this.visibility(actor);
    const fingerprint = filterFingerprint({
      type: query.type,
      status: query.status,
      env: visibility.environment,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.list({
      merchantId: visibility.merchantId,
      environment: visibility.environment,
      staffOnly: visibility.staffOnly,
      type: query.type,
      status: query.status,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.createdAt,
      id: r.row.ref,
    }));
  }

  /** A presigned link to the file: 15 minutes, for a ready report only. */
  async downloadLink(ref: string, actor: ReportActor): Promise<DownloadLink> {
    const found = await this.get(ref, actor);
    const { row } = found;
    const now = this.clock.now();
    if (
      row.status === 'expired' ||
      (row.status === 'ready' && row.expiresAt && row.expiresAt <= now)
    ) {
      throw new AppError('REPORT_EXPIRED');
    }
    if (row.status !== 'ready' || !row.fileKey) {
      throw new AppError('REPORT_NOT_READY', { details: { status: row.status } });
    }
    const filename = `${row.type}-${row.ref}.${extensionOf(row.format as ReportFormat)}`;
    const link = this.storage.presignGet({
      bucket: 'reports',
      key: row.fileKey,
      ttlSeconds: REPORT_LINK_TTL_SECONDS,
      downloadFilename: filename,
    });
    await this.unitOfWork.run((tx) =>
      this.audit.record(tx, {
        action: 'report.download_link_issued',
        resourceType: 'report',
        resourceId: row.ref,
        merchantId: row.merchantId,
        after: { expiresAt: link.expiresAt.toISOString() },
      })
    );
    return { url: link.url, expiresAt: link.expiresAt, filename };
  }

  /** Deletes the files of reports past their seven days and marks them expired. */
  async expireOld(): Promise<number> {
    const now = this.clock.now();
    const old = await this.repository.expired(now, 200);
    let expired = 0;
    for (const report of old) {
      try {
        if (report.fileKey) await this.storage.remove('reports', report.fileKey);
      } catch (error) {
        // The row is not expired until the file is gone; the next sweep tries again.
        this.logger.warn(
          { report: report.ref, err: toLoggableError(error) },
          'report file could not be deleted'
        );
        continue;
      }
      await this.unitOfWork.run(async (tx) => {
        const current = await this.repository.lockById(tx, report.id);
        if (!current || current.status !== 'ready') return;
        await this.repository.update(tx, current.id, { status: 'expired' });
        await this.audit.record(tx, {
          action: 'report.expired',
          resourceType: 'report',
          resourceId: current.ref,
          merchantId: current.merchantId,
          actor: { type: 'job', id: 'report-expiry', label: 'report expiry sweep' },
        });
      });
      reportsFinished.inc({ type: report.type, outcome: 'expired' });
      expired += 1;
    }
    return expired;
  }

  // -- internals ---------------------------------------------------------------------------

  private assertAllowed(type: ReportType, actor: ReportActor): void {
    if ('merchant' in actor) {
      if (!MERCHANT_TYPES.includes(type)) throw invalid('type_not_available', { type });
      return;
    }
    const extra = STAFF_PERMISSION_BY_TYPE[type];
    if (extra && !actor.staff.can(extra)) throw new AppError('FORBIDDEN');
  }

  private async scopeOf(
    type: ReportType,
    params: Record<string, unknown>,
    actor: ReportActor
  ): Promise<{
    merchantId: string | null;
    environment: 'test' | 'live' | null;
    requestedBy: string;
    params: Record<string, unknown>;
  }> {
    if ('merchant' in actor) {
      const { merchant: _ignored, ...rest } = params;
      return {
        merchantId: actor.merchant.scope.merchantId,
        environment: actor.merchant.scope.environment,
        requestedBy: actor.merchant.userId,
        params: rest,
      };
    }
    const requestedBy = actor.staff.userId;
    const ref = typeof params.merchant === 'string' ? params.merchant : undefined;
    const { merchant: _dropped, ...rest } = params;
    if (!ref) {
      if (MERCHANT_SCOPED_TYPES.includes(type)) throw invalid('merchant_required', { type });
      const environment =
        typeof rest.environment === 'string' ? (rest.environment as 'test' | 'live') : 'live';
      return { merchantId: null, environment, requestedBy, params: { ...rest, environment } };
    }
    const merchant = await this.merchants.findByRef(ref);
    if (!merchant) throw new AppError('NOT_FOUND');
    return { merchantId: merchant.id, environment: 'live', requestedBy, params: rest };
  }

  private visibility(actor: ReportActor): {
    merchantId?: string;
    environment?: string;
    staffOnly?: boolean;
  } {
    if ('merchant' in actor) {
      return {
        merchantId: actor.merchant.scope.merchantId,
        environment: actor.merchant.scope.environment,
      };
    }
    return { staffOnly: true };
  }

  private async assertSettlementOf(
    tx: Transaction,
    merchantId: string,
    ref: string
  ): Promise<void> {
    if (!(await this.repository.settlementExists(tx, merchantId, ref))) {
      throw invalid('settlement_not_found', {});
    }
  }
}

function invalid(reason: string, details: Record<string, unknown>): AppError {
  return new AppError('REPORT_INVALID', {
    messageParams: { reason },
    details: { reason, ...details },
  });
}
