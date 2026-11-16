/**
 * Runs a reconciliation check exactly once per business window, one at a time per scope
 * (spec 6.8, 8.9). The orchestrator owns the run row; the checks own what is looked at.
 *
 *   claim   one short transaction: the run row is inserted under two unique indexes,
 *           (kind, run_key) so a repeated window is the same run, and (kind, scope_key)
 *           where running so two workers never run one scope together;
 *   work    the check, outside any transaction, raising exceptions as it finds them;
 *   finish  counts, summary and an audit row, in one transaction.
 *
 * Outcomes: a completed window answers `duplicate` with the first run and does nothing;
 * a window or scope that is running answers `in_progress`; a worker that died leaves a
 * running row whose lease expires, after which the next call takes the slot over; a failed
 * run is taken again under the same key (attempts + 1). A check that throws leaves its run
 * `failed` with the error name, never a half-counted `completed`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { reconciliationRunsTotal } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { scopeKeyOf, scopeRecord, type RunKind, type RunScope } from './domain/run-kinds';
import { ReconciliationExceptionRecorder, type RaiseInput } from './exception-recorder';
import type { ExceptionRow } from './reconciliation-exceptions.repository';
import { ReconciliationRunsRepository, type RunRow } from './reconciliation-runs.repository';

export const RECONCILIATION_CHECKS = Symbol('RECONCILIATION_CHECKS');

export interface RunCheckContext {
  readonly run: RunRow;
  readonly scope: RunScope;
  readonly now: Date;
  /** Raises (or re-observes) an exception in its own short transaction. */
  raise(input: RaiseInput): Promise<{ exception: ExceptionRow; created: boolean }>;
}

export interface RunCheckResult {
  readonly checked: number;
  readonly matched: number;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface ReconciliationCheck {
  readonly kind: RunKind;
  execute(context: RunCheckContext): Promise<RunCheckResult>;
}

export interface RunRequest {
  readonly kind: RunKind;
  readonly scope: RunScope;
  readonly runKey: string;
  /** `user:{id}` or `job:{name}`. */
  readonly triggeredBy: string;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
}

export type RunOutcome =
  | { readonly outcome: 'completed'; readonly run: RunRow }
  /** The window had already completed: nothing ran, nothing was raised. */
  | { readonly outcome: 'duplicate'; readonly run: RunRow }
  | { readonly outcome: 'in_progress'; readonly run: RunRow | undefined };

type Claim =
  | { readonly kind: 'started'; readonly run: RunRow }
  | { readonly kind: 'duplicate'; readonly run: RunRow }
  | { readonly kind: 'in_progress'; readonly run: RunRow | undefined };

@Injectable()
export class ReconciliationRunService {
  private readonly checks: ReadonlyMap<RunKind, ReconciliationCheck>;

  constructor(
    @Inject(RECONCILIATION_CHECKS) checks: readonly ReconciliationCheck[],
    private readonly runs: ReconciliationRunsRepository,
    private readonly recorder: ReconciliationExceptionRecorder,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    this.checks = new Map(checks.map((c) => [c.kind, c]));
  }

  /** Runs one window of one check. Safe to call twice, concurrently, or after a crash. */
  async execute(request: RunRequest): Promise<RunOutcome> {
    const check = this.checks.get(request.kind);
    if (!check) throw new Error(`no reconciliation check registered for ${request.kind}`);
    const claim = await this.unitOfWork.run((tx) => this.claim(tx, request));
    if (claim.kind !== 'started') {
      return claim.kind === 'duplicate'
        ? { outcome: 'duplicate', run: claim.run }
        : { outcome: 'in_progress', run: claim.run };
    }
    const run = claim.run;
    let exceptionCount = 0;
    const touched = new Set<string>();
    const context: RunCheckContext = {
      run,
      scope: request.scope,
      now: this.clock.now(),
      raise: async (input) => {
        const raised = await this.unitOfWork.run((tx) => this.recorder.raise(tx, run.id, input));
        if (!touched.has(raised.exception.id)) {
          touched.add(raised.exception.id);
          exceptionCount += 1;
        }
        return raised;
      },
    };
    try {
      const result = await check.execute(context);
      const finished = await this.unitOfWork.run(async (tx) => {
        const row = await this.runs.finish(tx, run.id, {
          status: 'completed',
          now: this.clock.now(),
          checkedCount: result.checked,
          matchedCount: result.matched,
          exceptionCount,
          summary: { ...result.summary },
        });
        await this.audit.record(tx, {
          action: 'reconciliation.run.completed',
          resourceType: 'reconciliation_run',
          resourceId: row.ref,
          after: {
            kind: row.kind,
            checked: row.checkedCount,
            matched: row.matchedCount,
            exceptions: row.exceptionCount,
          },
          actor: auditActor(request.triggeredBy),
        });
        return row;
      });
      reconciliationRunsTotal.inc({ kind: request.kind, status: 'completed' });
      return { outcome: 'completed', run: finished };
    } catch (error) {
      this.logger.error(
        { err: toLoggableError(error), runRef: run.ref, kind: request.kind },
        'reconciliation run failed'
      );
      await this.unitOfWork.run(async (tx) => {
        await this.runs.finish(tx, run.id, {
          status: 'failed',
          now: this.clock.now(),
          checkedCount: 0,
          matchedCount: 0,
          exceptionCount,
          summary: {},
          error: error instanceof Error ? error.name : 'Error',
        });
        await this.audit.record(tx, {
          action: 'reconciliation.run.failed',
          resourceType: 'reconciliation_run',
          resourceId: run.ref,
          after: { kind: request.kind },
          outcome: 'error',
          actor: auditActor(request.triggeredBy),
        });
      });
      reconciliationRunsTotal.inc({ kind: request.kind, status: 'failed' });
      throw error;
    }
  }

  private async claim(
    tx: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    request: RunRequest
  ): Promise<Claim> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + this.config.RECON_RUN_LEASE_SECONDS * 1000);
    const scopeKey = scopeKeyOf(request.scope);

    const existing = await this.runs.findByKey(tx, request.kind, request.runKey);
    if (existing) return this.resolveExisting(tx, existing, request, now, leaseExpiresAt);

    const insert = () =>
      this.runs.insertIfFree(tx, {
        id: uuidv7(now),
        ref: publicId('reconRun', now),
        kind: request.kind,
        scope: scopeRecord(request.scope),
        scopeKey,
        runKey: request.runKey,
        periodStart: request.periodStart ?? null,
        periodEnd: request.periodEnd ?? null,
        triggeredBy: request.triggeredBy,
        startedAt: now,
        leaseExpiresAt,
        createdAt: now,
      });
    const inserted = await insert();
    if (inserted) return { kind: 'started', run: inserted };

    // Another run of this kind and scope holds the slot.
    const holder = await this.runs.findRunning(tx, request.kind, scopeKey);
    if (!holder) return { kind: 'in_progress', run: undefined };
    if (holder.leaseExpiresAt > now) return { kind: 'in_progress', run: holder };
    await this.runs.abandon(tx, holder.id, now);
    const retry = await insert();
    return retry ? { kind: 'started', run: retry } : { kind: 'in_progress', run: holder };
  }

  private async resolveExisting(
    tx: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    existing: RunRow,
    request: RunRequest,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<Claim> {
    if (existing.status === 'completed') return { kind: 'duplicate', run: existing };
    if (existing.status === 'running') {
      if (existing.leaseExpiresAt > now) return { kind: 'in_progress', run: existing };
      await this.runs.abandon(tx, existing.id, now);
    }
    // Failed (or just abandoned): take the same run again, if its scope slot is free.
    const holder = await this.runs.findRunning(tx, request.kind, existing.scopeKey);
    if (holder && holder.id !== existing.id) return { kind: 'in_progress', run: holder };
    const retaken = await this.runs.retake(tx, existing.id, {
      now,
      leaseExpiresAt,
      triggeredBy: request.triggeredBy,
    });
    return retaken ? { kind: 'started', run: retaken } : { kind: 'in_progress', run: existing };
  }
}

function auditActor(triggeredBy: string) {
  const [type, ...rest] = triggeredBy.split(':');
  const id = rest.join(':');
  return {
    type: type === 'user' ? ('user' as const) : ('job' as const),
    id: id || null,
    label: triggeredBy,
  };
}
