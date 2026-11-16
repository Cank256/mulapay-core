/**
 * Reconciliation reporting (spec 6.8, 10): run status, unresolved discrepancies, resolution
 * history and metrics. Read-only. Also keeps the `core_reconciliation_exceptions_open`
 * gauge current on every scrape, so the api process reports what the worker's runs found.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { AppError } from '../../common/errors/app-error';
import { metricRefreshers, reconciliationExceptionsOpen } from '../../common/telemetry/metrics';
import { Inject } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { CLOCK } from '../../common/tokens';
import { RUN_KINDS } from './domain/run-kinds';
import {
  ReconciliationExceptionsRepository,
  type ExceptionRow,
} from './reconciliation-exceptions.repository';
import { ReconciliationRunsRepository, type RunRow } from './reconciliation-runs.repository';

export interface ReconciliationStatus {
  readonly latestRuns: readonly { kind: string; run: RunRow | null }[];
  readonly openExceptions: readonly { kind: string; severity: string; count: number }[];
  readonly openTotal: number;
  readonly oldestOpenAgeSeconds: number | null;
  readonly pendingApprovals: number;
}

@Injectable()
export class ReconciliationReportsService implements OnModuleInit {
  constructor(
    private readonly runs: ReconciliationRunsRepository,
    private readonly exceptions: ReconciliationExceptionsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  onModuleInit(): void {
    metricRefreshers.set('reconciliation_exceptions_open', () => this.refreshGauge());
  }

  async listRuns(query: {
    kind?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<RunRow>> {
    const fingerprint = filterFingerprint({ kind: query.kind, status: query.status });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.runs.list({
      kind: query.kind,
      status: query.status,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  async getRun(ref: string): Promise<RunRow> {
    const run = await this.runs.findByRef(ref);
    if (!run) throw new AppError('NOT_FOUND');
    return run;
  }

  /** The newest run of each kind, open exceptions and what waits for approval. */
  async status(): Promise<ReconciliationStatus> {
    const [latest, counts, oldest, pending] = await Promise.all([
      this.runs.latestPerKind(),
      this.exceptions.openCounts(),
      this.exceptions.oldestOpen(),
      this.exceptions.listPendingRequests(1000),
    ]);
    return {
      latestRuns: RUN_KINDS.map((kind) => ({
        kind,
        run: latest.find((r) => r.kind === kind) ?? null,
      })),
      openExceptions: counts,
      openTotal: counts.reduce((sum, c) => sum + c.count, 0),
      oldestOpenAgeSeconds: oldest
        ? Math.max(0, Math.floor((this.clock.now().getTime() - oldest.getTime()) / 1000))
        : null,
      pendingApprovals: pending.length,
    };
  }

  /** Unresolved discrepancies, newest first. */
  unresolved(query: {
    kind?: string;
    severity?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ExceptionRow>> {
    return this.pageOfOpen(query);
  }

  /** Resolved and written-off exceptions, newest resolution first. */
  history(limit: number): Promise<ExceptionRow[]> {
    return this.exceptions.history(limit);
  }

  private async pageOfOpen(query: {
    kind?: string;
    severity?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ExceptionRow>> {
    const fingerprint = filterFingerprint({
      kind: query.kind,
      severity: query.severity,
      open: true,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.exceptions.list({
      openOnly: true,
      kind: query.kind,
      severity: query.severity,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  private async refreshGauge(): Promise<void> {
    const counts = await this.exceptions.openCounts();
    reconciliationExceptionsOpen.reset();
    for (const c of counts)
      reconciliationExceptionsOpen.set({ kind: c.kind, severity: c.severity }, c.count);
  }
}
