/**
 * What the reconciliation schedules and the admin routes call (spec 6.8, 8.9).
 *
 *   gateway_gap       every `RECON_GAP_INTERVAL_SECONDS` (default 5 minutes)
 *   ledger_integrity  hourly
 *   balance_proof     daily
 *   provider_statement  once per uploaded statement
 *
 * A scheduled run is keyed by its time bucket, so a duplicate tick, a second worker or a
 * BullMQ retry is the same run: it returns the first and raises nothing twice. A manual run
 * is keyed by the caller's idempotency key for the same reason.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { manualRunKey, scheduledRunKey, type RunKind, type RunScope } from './domain/run-kinds';
import { ReconciliationRunService, type RunOutcome } from './reconciliation-run.service';

export type ScheduledKind = Exclude<RunKind, 'provider_statement'>;

@Injectable()
export class ReconciliationScheduler {
  constructor(
    private readonly runs: ReconciliationRunService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** `scope` defaults to everything live; a narrower scope is for operators and tests. */
  runScheduled(
    kind: ScheduledKind,
    scope: RunScope = { environment: 'live' }
  ): Promise<RunOutcome> {
    return this.runs.execute({
      kind,
      scope,
      runKey: scheduledRunKey(
        kind,
        this.clock.now(),
        scope,
        this.config.RECON_GAP_INTERVAL_SECONDS
      ),
      triggeredBy: `job:reconciliation-${kind}`,
    });
  }

  runStatementMatch(statementRef: string): Promise<RunOutcome> {
    const scope: RunScope = { environment: 'live', statement: statementRef };
    return this.runs.execute({
      kind: 'provider_statement',
      scope,
      runKey: scheduledRunKey('provider_statement', this.clock.now(), scope, 0),
      triggeredBy: 'job:statement-match',
    });
  }

  runManual(input: {
    kind: RunKind;
    scope: RunScope;
    idempotencyKey: string;
    userId: string;
  }): Promise<RunOutcome> {
    return this.runs.execute({
      kind: input.kind,
      scope: input.scope,
      runKey: manualRunKey(input.kind, `${input.idempotencyKey}:${JSON.stringify(input.scope)}`),
      triggeredBy: `user:${input.userId}`,
    });
  }
}
