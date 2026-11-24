/**
 * Approval executor for high-value payouts (spec Phase 4).
 *
 * When a payout's amount exceeds PAYOUT_APPROVAL_THRESHOLD_MINOR, the creator places it in
 * `pending_approval`. This executor is registered with the approvals system so that approving
 * the request (a) advances the payout to `created` via `PayoutLifecycleService` and (b)
 * fires gateway submission, in the same transaction as the approval decision.
 *
 * The `prepare` step verifies the payout is still pending approval (guards against stale
 * requests). The `execute` step locks the payout inside the approval transaction, applies the
 * lifecycle transition to `created`, and schedules gateway submission as a post-commit side
 * effect. If the payout has already moved (concurrent approval, rejection by another path),
 * the transition returns `skipped` and the approval becomes a no-op; the caller commits the
 * approval row but nothing about the payout changes.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { ROOT_LOGGER, CLOCK } from '../../common/tokens';
import type { Clock } from '../../common/clock/clock';
import type { ApprovalContext, ApprovalExecutor } from '../operations/approvals/approval-executor';
import type { ApprovalRow } from '../operations/approvals/approvals.repository';
import { PayoutGatewaySubmitter } from './payout-gateway-submitter.service';
import { PayoutLifecycleService } from './payout-lifecycle.service';
import { PayoutsRepository } from './payouts.repository';

const payoutApprovalPayload = z.strictObject({
  payoutId: z.string().uuid(),
  payoutRef: z.string().min(1),
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.string().length(3),
  gatewayExternalId: z.string().min(1),
  destinationValue: z.string().min(1),
  merchantId: z.string().uuid(),
});

function parse(payload: unknown) {
  const result = payoutApprovalPayload.safeParse(payload);
  if (!result.success) {
    throw new AppError('APPROVAL_INVALID', {
      messageParams: { reason: 'bad_payload' },
      details: { reason: 'bad_payload' },
    });
  }
  return result.data;
}

@Injectable()
export class PayoutApprovalExecutor implements ApprovalExecutor {
  readonly kind = 'payout.release';

  constructor(
    private readonly payoutsRepo: PayoutsRepository,
    private readonly lifecycle: PayoutLifecycleService,
    private readonly submitter: PayoutGatewaySubmitter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async prepare(tx: Transaction, payload: Readonly<Record<string, unknown>>) {
    const p = parse(payload);
    const payout = await this.payoutsRepo.findById(tx, p.payoutId);
    if (!payout) throw new AppError('NOT_FOUND');
    if (payout.status !== 'pending_approval') {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'payout_not_pending_approval' },
        details: { reason: 'payout_not_pending_approval', status: payout.status },
      });
    }
    return p;
  }

  async execute(
    tx: Transaction,
    approval: ApprovalRow,
    _ctx: ApprovalContext
  ): Promise<Record<string, unknown>> {
    const p = parse(approval.payload);

    // Transition payout from pending_approval → created (gateway not yet called).
    // requireStatus guards against a concurrent change between prepare and execute.
    const result = await this.lifecycle.apply(
      tx,
      p.payoutId,
      {
        eventKey: `approval:released:${approval.ref}`,
        source: 'api',
        occurredAt: this.clock.now(),
        signal: { kind: 'created' },
      },
      { requireStatus: 'pending_approval' }
    );

    if (result.result === 'skipped') {
      this.logger.warn(
        { payoutRef: p.payoutRef, approvalRef: approval.ref },
        'payout approval: payout no longer in pending_approval, skipping'
      );
      return { skipped: true, status: result.status };
    }

    // Fire gateway submission after the approval transaction commits.
    // We cannot call the gateway inside the transaction (rule: no HTTP inside UnitOfWork).
    // The submitter runs fire-and-forget; the chase job picks it up if it fails.
    setImmediate(() => {
      this.submitter
        .submit({
          payoutId: p.payoutId,
          payoutRef: p.payoutRef,
          gatewayExternalId: p.gatewayExternalId,
          amountMinor: BigInt(p.amountMinor),
          currency: p.currency,
          recipient: { partyIdType: 'MSISDN', partyId: p.destinationValue },
          merchantId: p.merchantId,
          environment: 'live',
        })
        .catch((error) => {
          this.logger.error(
            { payoutRef: p.payoutRef, approvalRef: approval.ref, err: error },
            'approved payout gateway submission failed; chase job will resolve'
          );
        });
    });

    this.logger.info(
      { payoutRef: p.payoutRef, approvalRef: approval.ref },
      'payout approval executed, gateway submission scheduled'
    );

    return { payoutRef: p.payoutRef, submitted: true };
  }
}
