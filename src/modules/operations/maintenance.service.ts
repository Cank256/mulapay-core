/**
 * Maintenance mode (spec 6.14): while it is on, the API refuses writes with `503` and
 * `Retry-After` and keeps serving reads. Postgres is the source of truth; each process keeps
 * the answer for two seconds, so a change reaches every API replica within that time and a
 * request never waits for a database read of its own. If the state cannot be read the API
 * serves the request (it fails open): maintenance is a courtesy to operators, and a database
 * that is down fails the request anyway.
 *
 * Turning it on or off is audited, step-up protected at the route, and tells the staff.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { toLoggableError } from '../../common/logging/redaction';
import { maintenanceModeGauge, metricRefreshers } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { NotificationsService } from '../notifications/notifications.service';
import { OpsConfigRepository } from './ops-config.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

export interface MaintenanceStatus {
  readonly enabled: boolean;
  readonly message: string | null;
  readonly retryAfterSeconds: number;
  readonly changedAt: Date | null;
}

export const MAINTENANCE_CACHE_MS = 2000;

@Injectable()
export class MaintenanceService {
  private cached: { at: number; value: MaintenanceStatus } | undefined;

  constructor(
    private readonly config: OpsConfigRepository,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    metricRefreshers.set('maintenance_mode', async () => {
      maintenanceModeGauge.set((await this.read()).enabled ? 1 : 0);
    });
  }

  /** The state, for the guard on every write: cached, and never throws. */
  async current(): Promise<MaintenanceStatus> {
    const now = this.clock.now().getTime();
    if (this.cached && now - this.cached.at < MAINTENANCE_CACHE_MS) return this.cached.value;
    try {
      const value = await this.read();
      this.cached = { at: now, value };
      return value;
    } catch (error) {
      this.logger.error(
        { err: toLoggableError(error) },
        'maintenance state unreadable; serving the request'
      );
      return { enabled: false, message: null, retryAfterSeconds: 0, changedAt: null };
    }
  }

  async status(): Promise<MaintenanceStatus> {
    return this.read();
  }

  async set(
    input: { enabled: boolean; message?: string | null; retryAfterSeconds?: number },
    staff: Staff
  ): Promise<MaintenanceStatus> {
    const result = await this.unitOfWork.run(async (tx) => {
      const before = await this.config.lockMaintenance(tx);
      if (!before) throw new Error('maintenance_state row is missing');
      const now = this.clock.now();
      const after = await this.config.setMaintenance(tx, {
        enabled: input.enabled,
        message: input.enabled ? (input.message ?? null) : null,
        retryAfterSeconds:
          input.retryAfterSeconds ??
          before.retryAfterSeconds ??
          this.appConfig.MAINTENANCE_RETRY_AFTER_SECONDS,
        changedBy: staff.userId,
        changedAt: now,
      });
      await this.notifications.notify(tx, {
        templateCode: 'maintenance.changed',
        audience: { kind: 'staff', permission: 'ops:read' },
        resourceKey: `maintenance:${now.toISOString()}`,
        variables: { state: input.enabled ? 'on' : 'off' },
      });
      await this.audit.record(tx, {
        action: input.enabled ? 'maintenance.enabled' : 'maintenance.disabled',
        resourceType: 'maintenance',
        resourceId: 'platform',
        before: { enabled: before.enabled, retryAfterSeconds: before.retryAfterSeconds },
        after: {
          enabled: after.enabled,
          retryAfterSeconds: after.retryAfterSeconds,
          hasMessage: after.message !== null,
        },
      });
      return after;
    });
    this.cached = undefined;
    maintenanceModeGauge.set(result.enabled ? 1 : 0);
    return toStatus(result);
  }

  private async read(): Promise<MaintenanceStatus> {
    const row = await this.config.maintenance();
    if (!row) return { enabled: false, message: null, retryAfterSeconds: 0, changedAt: null };
    return toStatus(row);
  }
}

function toStatus(row: {
  enabled: boolean;
  message: string | null;
  retryAfterSeconds: number;
  changedAt: Date | null;
}): MaintenanceStatus {
  return {
    enabled: row.enabled,
    message: row.message,
    retryAfterSeconds: row.retryAfterSeconds,
    changedAt: row.changedAt,
  };
}
