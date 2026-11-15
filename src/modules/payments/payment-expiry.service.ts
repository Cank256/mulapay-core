/**
 * The payment expiry sweep (spec 6.1: "payments expire via a scheduled job after
 * `expires_at`").
 *
 * It expires only payments that were never submitted to a provider (`created`). A payment
 * in `requires_action` or `processing` has an operation at the provider, and "expired" for it
 * is the provider's word, not a clock's: ending it here on `expires_at` would infer an
 * outcome the gateway has not given, and a customer who approves a moment later would be a
 * late success on an expired payment (spec 17.5, 3.7). Those payments are ended by the
 * gateway's `expired` event or by the chase job (Phase 4).
 *
 * Each payment runs in its own short transaction with the event key `job:expiry`, so a
 * failure is isolated, the sweep can run twice or on two nodes without double effect, and the
 * next run retries what failed. Failures are logged and counted, not thrown.
 *
 * Not scheduled yet: schedules belong to the consumer process (Phase 3). The scheduler calls
 * `sweep`; a job needs no more than that to be idempotent, retried and bounded by `limit`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { toLoggableError } from '../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { CheckoutSessionsService } from './checkout-sessions.service';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { observePaymentEvent } from './payment-metrics';
import { PaymentsRepository } from './payments.repository';

export const EXPIRY_EVENT_KEY = 'job:expiry';

export interface PaymentSweepResult {
  readonly payments: {
    readonly expired: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly sessions: { readonly expired: number; readonly left: number; readonly failed: number };
}

@Injectable()
export class PaymentExpiryService {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly sessions: CheckoutSessionsService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Expires up to `limit` due payments, then up to `limit` due checkout sessions. */
  async sweep(limit = 100): Promise<PaymentSweepResult> {
    const due = await this.payments.findDueForExpiry(this.clock.now(), limit);
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    for (const paymentId of due) {
      try {
        const result = await this.unitOfWork.run((tx) =>
          this.lifecycle.apply(
            tx,
            paymentId,
            {
              eventKey: EXPIRY_EVENT_KEY,
              source: 'job',
              occurredAt: this.clock.now(),
              signal: { kind: 'expired', failureCode: 'payment_expired' },
            },
            { requireStatus: 'created' }
          )
        );
        observePaymentEvent(result, 'job');
        if (result.result === 'applied') expired += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: toLoggableError(error), paymentId }, 'payment expiry failed');
      }
    }
    return {
      payments: { expired, skipped, failed },
      sessions: await this.sessions.expireDue(limit),
    };
  }
}
