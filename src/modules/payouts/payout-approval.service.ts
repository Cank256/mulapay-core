/**
 * Payout approval service (Phase 4): admin operation to release or reject a payout that
 * was placed in `pending_approval` because its amount exceeded the platform threshold.
 *
 * The approval model mirrors settlement batch approval (SettlementBatchService) rather than
 * the generic ops maker-checker table. That table requires a staff FK and is for ops
 * configuration changes; payout approval is a financial operation owned by admin finance.
 *
 * Rules:
 *  - Only a payout in `pending_approval` can be approved or rejected.
 *  - Approving transitions the payout to `created` through the lifecycle service and
 *    schedules gateway submission as a post-commit side effect (live only).
 *  - Rejecting transitions the payout to `cancelled`, which releases the hold.
 *  - Both operations audit the decision.
 *  - The payout was locked by the lifecycle service, so concurrent double-approvals are safe.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { PayoutGatewaySubmitter } from './payout-gateway-submitter.service';
import { PayoutLifecycleService } from './payout-lifecycle.service';
import { PayoutsRepository } from './payouts.repository';
import { toPayoutView, type PayoutView } from './payout.views';

export interface PayoutApprovalInput {
  readonly payoutRef: string;
  readonly note?: string;
  readonly staffId: string;
  readonly staffRef: string;
}

@Injectable()
export class PayoutApprovalService {
  constructor(
    private readonly payouts: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly submitter: PayoutGatewaySubmitter,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Approves a pending-approval payout and schedules gateway submission.
   * Returns the updated payout view.
   */
  async approve(input: PayoutApprovalInput): Promise<PayoutView> {
    const payoutDetail = await this.payouts.findDetailByRefAdmin(input.payoutRef);
    if (!payoutDetail) throw new AppError('NOT_FOUND');
    const { payout, transaction } = payoutDetail;

    if (payout.status !== 'pending_approval') {
      throw new AppError('PAYOUT_NOT_PENDING_APPROVAL', {
        details: { status: payout.status },
      });
    }

    const now = this.clock.now();
    const result = await this.unitOfWork.run(async (tx) => {
      const outcome = await this.lifecycle.apply(tx, payout.id, {
        eventKey: `admin:approved:${input.staffRef}`,
        source: 'api',
        occurredAt: now,
        signal: { kind: 'processing', outcomeUnknown: false },
      });

      if (outcome.result === 'skipped' || outcome.result === 'rejected') {
        throw new AppError('PAYOUT_INVALID_TRANSITION', {
          details: { status: payout.status, reason: outcome.result },
        });
      }

      await this.audit.record(tx, {
        action: 'payout.approved',
        resourceType: 'payout',
        resourceId: input.payoutRef,
        before: { status: 'pending_approval' },
        after: { status: 'processing', note: input.note ?? null },
      });

      const updated = await this.payouts.findDetailById(payout.id, tx);
      if (!updated) throw new AppError('NOT_FOUND');
      return updated;
    });

    // Submit to gateway after transaction commits — live only.
    // Fire and forget; chase job picks it up if the submit fails.
    if (payout.environment === 'live') {
      this.submitter
        .submit({
          payoutId: payout.id,
          payoutRef: payout.ref,
          gatewayExternalId: transaction.gatewayExternalId!,
          amountMinor: payout.amountMinor,
          currency: payout.currency,
          recipient: {
            partyIdType: 'MSISDN',
            partyId: (payout.destination as { value: string }).value,
          },
          merchantId: payout.merchantId,
          environment: 'live',
        })
        .catch((error) => {
          this.logger.error(
            { payoutRef: payout.ref, err: error },
            'approved payout gateway submission failed; chase job will resolve'
          );
        });
    }

    return toPayoutView(result);
  }

  /**
   * Rejects a pending-approval payout. Transitions to `cancelled`, releasing the hold.
   */
  async reject(input: PayoutApprovalInput): Promise<PayoutView> {
    const payoutDetail = await this.payouts.findDetailByRefAdmin(input.payoutRef);
    if (!payoutDetail) throw new AppError('NOT_FOUND');
    const { payout } = payoutDetail;

    if (payout.status !== 'pending_approval') {
      throw new AppError('PAYOUT_NOT_PENDING_APPROVAL', {
        details: { status: payout.status },
      });
    }

    const now = this.clock.now();
    const result = await this.unitOfWork.run(async (tx) => {
      const outcome = await this.lifecycle.apply(tx, payout.id, {
        eventKey: `admin:rejected:${input.staffRef}`,
        source: 'api',
        occurredAt: now,
        signal: { kind: 'cancelled', code: 'approval_rejected' },
      });

      if (outcome.result === 'rejected') {
        throw new AppError('PAYOUT_INVALID_TRANSITION', {
          details: { status: payout.status, reason: outcome.reason },
        });
      }

      await this.audit.record(tx, {
        action: 'payout.rejected',
        resourceType: 'payout',
        resourceId: input.payoutRef,
        before: { status: 'pending_approval' },
        after: { status: 'cancelled', note: input.note ?? null },
      });

      const updated = await this.payouts.findDetailById(payout.id, tx);
      if (!updated) throw new AppError('NOT_FOUND');
      return updated;
    });

    return toPayoutView(result);
  }
}
