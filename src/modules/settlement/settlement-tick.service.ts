/**
 * The settlement scheduler tick (spec 6.9, 8.9), run every minute by the `settlement-run`
 * queue. For each active cycle it finds the latest cron occurrence at or before now and runs
 * the cycle as of that occurrence: the period it settles is fixed by the cutoff, so every tick
 * after the first that day finds the run already done and does nothing. Then it sweeps
 * releasing batches: re-sends payouts that were never sent and checks the status of payouts
 * that have been processing too long.
 *
 * Safe to run on any number of workers and to repeat: runs are unique per cycle and period,
 * batches per merchant and period, and payout submission per `externalId`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { toLoggableError } from '../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { previousOccurrence } from './domain/cron';
import { SettlementCyclesRepository } from './settlement-cycles.repository';
import { SettlementReleaseService } from './settlement-release.service';
import { SettlementRunService } from './settlement-run.service';

export interface TickResult {
  readonly cyclesRun: number;
  readonly failed: number;
  readonly submitted: number;
  readonly verified: number;
}

@Injectable()
export class SettlementTickService {
  constructor(
    private readonly cycles: SettlementCyclesRepository,
    private readonly runs: SettlementRunService,
    private readonly release: SettlementReleaseService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async tick(): Promise<TickResult> {
    const now = this.clock.now();
    let cyclesRun = 0;
    let failed = 0;
    for (const cycle of await this.cycles.list(true)) {
      try {
        const asOf = previousOccurrence(
          cycle.schedule,
          cycle.timezone,
          new Date(now.getTime() + 1000)
        );
        const result = await this.runs.runCycle(cycle.ref, { asOf, triggeredBy: 'job:settlement' });
        if (result.outcome === 'completed') cyclesRun += 1;
        if (result.outcome === 'failed') failed += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          { err: toLoggableError(error), cycle: cycle.ref },
          'settlement cycle run failed'
        );
      }
    }
    const swept = await this.release.sweep();
    return { cyclesRun, failed, ...swept };
  }
}
