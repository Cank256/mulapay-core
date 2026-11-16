/**
 * The automatic incident monitors (spec 6.14, 10): stuck transactions, suspense-account drift
 * and queue depth. (A ledger integrity failure opens its sev1 incident in the hourly
 * reconciliation run, Phase 6.) The worker runs `evaluate` every `OPS_MONITOR_INTERVAL_SECONDS`.
 *
 * Each signal is read, compared with how long it has been seen (`ops_signals.active_since`), and
 * then:
 *  - waits while it has lasted less than its sustain time;
 *  - opens an incident, deduplicated by key while that incident is unresolved, so a standing
 *    condition is one incident whose detection count grows, and raises its severity as it gets
 *    worse or lasts longer, never lowering it;
 *  - on clearing, moves the incident to `monitoring` for a person to resolve, never resolving it.
 *
 * Each signal is handled in its own transaction under its row lock, so two workers evaluating at
 * once cannot open two incidents. A monitor that cannot read its source logs the failure and
 * skips that signal: it never opens an incident from missing data.
 *
 * Suspense: the hourly ledger integrity run already opens a sev1 for any non-zero suspense
 * balance (spec 6.8). The drift monitor does not open a second incident for the same
 * environment while that one is unresolved.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { toLoggableError } from '../../common/logging/redaction';
import { DEAD_LETTER_QUEUE } from '../../common/queue/queue.definitions';
import { QueueRegistry } from '../../common/queue/queue.registry';
import { metricRefreshers, opsSignalsActive } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import type { Severity } from '../incidents/domain/incident-rules';
import { IncidentsService } from '../incidents/incidents.service';
import {
  decide,
  queueDepthSeverity,
  stuckSeverity,
  suspenseSeverity,
  type SignalReading,
} from './domain/ops-signals';
import { OpsSignalsRepository } from './ops-signals.repository';

interface Signal {
  readonly key: string;
  readonly sustainSeconds: number;
  readonly title: string;
  readonly impact: string;
  readonly services: readonly string[];
  /** Another incident that already covers this one: while it is open, do not open this. */
  readonly coveredByPrefix?: string;
  /** Severity that depends on how long the condition has lasted; wins over the reading's. */
  readonly severityAt?: (activeSince: Date, now: Date) => Severity;
  readonly reading: SignalReading;
}

@Injectable()
export class OpsMonitorService {
  constructor(
    private readonly signals: OpsSignalsRepository,
    private readonly incidents: IncidentsService,
    private readonly queues: QueueRegistry,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    metricRefreshers.set('ops_signals_active', () => this.refreshGauge());
  }

  /** Reads every source and applies each signal. Returns the keys that opened or touched an incident. */
  async evaluate(): Promise<string[]> {
    const now = this.clock.now();
    const touched: string[] = [];
    const readings: Signal[] = [];
    for (const read of [() => this.stuck(now), () => this.suspense(), () => this.queueDepth(now)]) {
      try {
        readings.push(...(await read()));
      } catch (error) {
        this.logger.error(
          { err: toLoggableError(error) },
          'incident monitor could not read its source'
        );
      }
    }
    for (const signal of readings) {
      try {
        if (await this.apply(signal, now)) touched.push(signal.key);
      } catch (error) {
        this.logger.error(
          { signal: signal.key, err: toLoggableError(error) },
          'incident monitor failed for one signal'
        );
      }
    }
    return touched;
  }

  async refreshGauge(): Promise<void> {
    const active = await this.signals.activeSignals();
    opsSignalsActive.reset();
    for (const s of active) opsSignalsActive.set({ signal: s.key.split(':')[0] ?? s.key }, 1);
  }

  private async apply(signal: Signal, now: Date): Promise<boolean> {
    const dedupeKey = signal.key;
    return this.unitOfWork.run(async (tx) => {
      const state = await this.signals.lockSignal(tx, signal.key);
      const decision = decide(
        signal.reading,
        { activeSince: state?.activeSince ?? null },
        now,
        signal.sustainSeconds
      );
      if (decision.action === 'clear') {
        if (!state && !decision.wasActive) return false;
        await this.signals.saveSignal(tx, {
          key: signal.key,
          activeSince: null,
          observedAt: now,
          value: signal.reading.value,
        });
        if (decision.wasActive) {
          await this.incidents.noteRecovery(
            tx,
            dedupeKey,
            'The condition that opened this incident has cleared. Verify, then resolve.'
          );
        }
        return false;
      }
      await this.signals.saveSignal(tx, {
        key: signal.key,
        activeSince: decision.activeSince,
        observedAt: now,
        value: signal.reading.value,
      });
      if (decision.action === 'wait') return false;
      if (
        signal.coveredByPrefix &&
        (await this.incidents.hasOpenWithPrefix(signal.coveredByPrefix, tx))
      ) {
        return false;
      }
      const severity = signal.severityAt
        ? signal.severityAt(decision.activeSince, now)
        : decision.severity;
      const opened = await this.incidents.openAutomatic(tx, {
        dedupeKey,
        title: signal.title,
        severity,
        impact: signal.impact,
        affectedServices: signal.services,
        source: 'monitor',
      });
      if (!opened.created) {
        await this.incidents.raiseSeverity(tx, dedupeKey, severity, 'the condition continues');
      }
      return true;
    });
  }

  private async stuck(now: Date): Promise<Signal[]> {
    const olderThan = new Date(now.getTime() - this.config.OPS_STUCK_TXN_MINUTES * 60_000);
    const rows = await this.signals.stuckSummary(now, olderThan);
    const count = rows.reduce((n, r) => n + r.n, 0);
    const oldest = rows.length ? Math.min(...rows.map((r) => r.oldest.getTime())) : now.getTime();
    const ageMinutes = Math.floor((now.getTime() - oldest) / 60_000);
    return [
      {
        key: 'ops:stuck_transactions',
        // A transaction is "stuck" once it has been processing for the threshold, which is the
        // spec's 15 minutes (spec 10), so the incident opens as soon as one is.
        sustainSeconds: 0,
        title: 'Transactions are stuck in processing',
        impact: `${count} transaction(s) have been processing for more than ${this.config.OPS_STUCK_TXN_MINUTES} minutes; the oldest for ${ageMinutes} minutes. See /admin/v1/ops/stuck-transactions.`,
        services: ['payments', 'gateway', 'consumer'],
        reading: {
          active: count > 0,
          severity: stuckSeverity(ageMinutes, this.config.OPS_STUCK_TXN_SEV2_MINUTES),
          value: { count, oldestAgeMinutes: ageMinutes },
        },
      },
    ];
  }

  private async suspense(): Promise<Signal[]> {
    const balances = await this.signals.suspense();
    const out: Signal[] = [];
    const seen = new Set<string>();
    for (const b of balances) {
      const key = `ops:suspense_drift:${b.environment}:${b.currency}`;
      seen.add(key);
      out.push({
        key,
        sustainSeconds: this.config.SUSPENSE_ALERT_HOURS * 3600,
        title: `Suspense account is not zero (${b.environment}, ${b.currency})`,
        impact: `The suspense account holds ${b.balanceMinor} minor units of ${b.currency} (${b.environment}) and has not been cleared. Unidentified money must be traced and cleared.`,
        services: ['ledger', 'reconciliation'],
        coveredByPrefix: `ledger_integrity:${b.environment}:`,
        severityAt: (since, at) =>
          suspenseSeverity(
            (at.getTime() - since.getTime()) / 1000,
            this.config.OPS_SUSPENSE_SEV1_HOURS
          ),
        reading: {
          active: true,
          severity: 'sev2',
          value: {
            environment: b.environment,
            currency: b.currency,
            balanceMinor: b.balanceMinor.toString(),
          },
        },
      });
    }
    // A suspense account that was non-zero and is zero now has cleared.
    for (const s of await this.signals.activeSignals()) {
      if (s.key.startsWith('ops:suspense_drift:') && !seen.has(s.key)) {
        out.push({
          key: s.key,
          sustainSeconds: 0,
          title: '',
          impact: '',
          services: [],
          reading: { active: false, severity: 'sev2', value: { balanceMinor: '0' } },
        });
      }
    }
    return out;
  }

  private async queueDepth(now: Date): Promise<Signal[]> {
    const snapshot = await this.queues.snapshot(now);
    const threshold = this.config.OPS_QUEUE_DEPTH_THRESHOLD;
    const out: Signal[] = [];
    for (const q of snapshot) {
      if (q.queue === DEAD_LETTER_QUEUE) continue;
      out.push({
        key: `ops:queue_depth:${q.queue}`,
        sustainSeconds: this.config.OPS_QUEUE_DEPTH_SUSTAIN_SECONDS,
        title: `Queue ${q.queue} is backing up`,
        impact: `Queue ${q.queue} has ${q.depth} jobs waiting (threshold ${threshold}); the oldest has waited ${Math.round(q.oldestJobAgeSeconds)} seconds. Work that depends on it is delayed.`,
        services: ['queues'],
        reading: {
          active: q.depth > threshold,
          severity: queueDepthSeverity(q.depth, threshold),
          value: { depth: q.depth, oldestJobAgeSeconds: Math.round(q.oldestJobAgeSeconds) },
        },
      });
    }
    return out;
  }
}
