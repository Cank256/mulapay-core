/**
 * The gateway event consumer's cursor and lag (spec 8.7, 6.14). The consumer (Phase 3) writes
 * the cursor and its heartbeat; this reads them, measures how far behind the gateway's event
 * stream the cursor is (through the read-only role), and asks for a rewind.
 *
 * A rewind makes the consumer re-read events it already applied. That is safe only because the
 * consumer's handlers are idempotent on the event id (spec 8.7), and it is the most dangerous
 * thing an operator can do to the stream, so it is always an approval request and can only
 * move the cursor back.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { ApprovalsService } from './approvals/approvals.service';
import type { ApprovalRow } from './approvals/approvals.repository';
import { OpsConfigRepository } from './ops-config.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

/** A consumer that has not written a heartbeat for this long is down (spec 8.7). */
export const HEARTBEAT_STALE_SECONDS = 30;

export interface CursorView {
  readonly name: string;
  readonly position: bigint;
  readonly holder: string | null;
  readonly heartbeatAt: Date | null;
  readonly status: 'running' | 'stale' | 'never_started';
  /** Events in the gateway stream after the cursor; null when the stream cannot be read. */
  readonly eventsBehind: bigint | null;
  readonly lagSeconds: number | null;
  readonly lagAlert: boolean;
  readonly streamHead: bigint | null;
}

@Injectable()
export class ConsumerCursorsService {
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly approvals: ApprovalsService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(): Promise<CursorView[]> {
    const cursors = await this.config.listCursors();
    const now = this.clock.now();
    return Promise.all(
      cursors.map(async (c) => {
        const lag = await this.config.gatewayLag(this.appConfig.GATEWAY_TENANT_ID, c.position);
        const lagSeconds = lag
          ? lag.oldestUnprocessedAt
            ? Math.max(0, (now.getTime() - lag.oldestUnprocessedAt.getTime()) / 1000)
            : 0
          : null;
        const heartbeatAge = c.heartbeatAt
          ? (now.getTime() - c.heartbeatAt.getTime()) / 1000
          : null;
        return {
          name: c.name,
          position: c.position,
          holder: c.holder,
          heartbeatAt: c.heartbeatAt,
          status:
            heartbeatAge === null
              ? 'never_started'
              : heartbeatAge > HEARTBEAT_STALE_SECONDS
                ? 'stale'
                : 'running',
          eventsBehind: lag?.behind ?? null,
          lagSeconds,
          lagAlert: lagSeconds !== null && lagSeconds > this.appConfig.CONSUMER_LAG_ALERT_SECONDS,
          streamHead: lag?.head ?? null,
        } satisfies CursorView;
      })
    );
  }

  /** Asks for the cursor to be moved back to `position`. Always needs a second person. */
  async requestRewind(
    name: string,
    position: bigint,
    reason: string,
    staff: Staff
  ): Promise<{ approval: ApprovalRow; created: boolean }> {
    return this.unitOfWork.run(async (tx) => {
      if (!(await this.config.lockCursor(tx, name))) throw new AppError('NOT_FOUND');
      return this.approvals.request(
        tx,
        {
          kind: 'consumer_cursor.rewind',
          resourceType: 'consumer_cursor',
          resourceId: name,
          payload: { name, position: position.toString() },
          reason,
        },
        staff
      );
    });
  }
}
