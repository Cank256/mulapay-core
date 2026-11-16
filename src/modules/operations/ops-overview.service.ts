/**
 * What an operator looks at first (spec 6.14): the queues, the consumer cursor, stuck
 * transactions, the suspense balance, open incidents, pending approvals, breached complaints,
 * the notification backlog, provider status, maintenance mode and today's platform volume.
 * Volume comes from the daily rollups only (spec 9.2 rule 4), never from transactions.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { metricRefreshers, transactionsStuck } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { ConsumerCursorsService } from './consumer-cursors.service';
import { MaintenanceService } from './maintenance.service';
import { OpsConfigRepository } from './ops-config.repository';
import {
  OpsSignalsRepository,
  type StuckTransaction,
  type SuspenseBalance,
} from './ops-signals.repository';
import { QueueOpsService } from './queue-ops.service';

const AGE_BUCKETS: ReadonlyArray<{ label: string; maxMinutes: number }> = [
  { label: 'lt_1h', maxMinutes: 60 },
  { label: 'lt_6h', maxMinutes: 360 },
  { label: 'lt_24h', maxMinutes: 1440 },
  { label: 'gte_24h', maxMinutes: Infinity },
];

@Injectable()
export class OpsOverviewService {
  constructor(
    private readonly signals: OpsSignalsRepository,
    private readonly config: OpsConfigRepository,
    private readonly notificationsRepo: NotificationsRepository,
    private readonly queues: QueueOpsService,
    private readonly cursors: ConsumerCursorsService,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {
    metricRefreshers.set('transactions_stuck', () => this.refreshStuckGauge());
  }

  async stuckTransactions(query: {
    olderThanMinutes?: number;
    limit: number;
    cursor?: string;
  }): Promise<Page<StuckTransaction>> {
    const now = this.clock.now();
    const minutes = query.olderThanMinutes ?? this.appConfig.OPS_STUCK_TXN_MINUTES;
    const fingerprint = filterFingerprint({ minutes });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.signals.stuck(
      now,
      new Date(now.getTime() - minutes * 60_000),
      after,
      query.limit
    );
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.startedAt, id: r.ref }));
  }

  suspense(): Promise<SuspenseBalance[]> {
    return this.signals.suspense();
  }

  async overview() {
    const now = this.clock.now();
    const day = now.toISOString().slice(0, 10);
    const olderThan = new Date(now.getTime() - this.appConfig.OPS_STUCK_TXN_MINUTES * 60_000);
    const [
      queues,
      cursors,
      stuck,
      suspense,
      incidents,
      approvals,
      breached,
      providers,
      maintenance,
      totals,
      delivery,
    ] = await Promise.all([
      this.queues.list(now),
      this.cursors.list(),
      this.signals.stuckSummary(now, olderThan),
      this.signals.suspense(),
      this.signals.incidentCounts(),
      this.signals.pendingApprovals(),
      this.signals.breachedComplaints(),
      this.config.listProviders(),
      this.maintenance.status(),
      this.signals.rollupTotals(day, 'live'),
      this.notificationsRepo.deliveryCounts(new Date(now.getTime() - 24 * 3600_000)),
    ]);
    return {
      generatedAt: now,
      maintenance,
      queues,
      cursors,
      stuckTransactions: {
        thresholdMinutes: this.appConfig.OPS_STUCK_TXN_MINUTES,
        count: stuck.reduce((n, s) => n + s.n, 0),
        oldest: stuck.length ? new Date(Math.min(...stuck.map((s) => s.oldest.getTime()))) : null,
      },
      suspense,
      openIncidents: incidents,
      pendingApprovals: approvals,
      breachedComplaints: breached,
      notificationBacklog: delivery,
      providers,
      today: { day, totals },
    };
  }

  /** Counts stuck transactions into `core_transactions_stuck{type, age_bucket}`. */
  async refreshStuckGauge(): Promise<void> {
    const now = this.clock.now();
    const rows = await this.signals.stuckSummary(
      now,
      new Date(now.getTime() - this.appConfig.OPS_STUCK_TXN_MINUTES * 60_000)
    );
    transactionsStuck.reset();
    // Only the oldest start is known per type, so the gauge puts the type's count in the bucket
    // of its oldest transaction: an upper bound on age, which is what an alert needs.
    for (const r of rows) {
      const ageMinutes = (now.getTime() - r.oldest.getTime()) / 60_000;
      const bucket = AGE_BUCKETS.find((b) => ageMinutes < b.maxMinutes)?.label ?? 'gte_24h';
      transactionsStuck.set({ type: r.type, age_bucket: bucket }, r.n);
    }
  }
}
