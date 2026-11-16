/**
 * A merchant submits its KYC for review (spec 6.10 `draft -> pending_kyc`, 6.13).
 *
 * Invariants upheld, in one transaction:
 *  - The submission is allowed by the state machine (`decideSubmission`): a first submission,
 *    one after a rejection, an answer to a request for information, an upgrade to a higher
 *    level, or a renewal once re-verification is due.
 *  - Everything mandatory that the merchant itself can supply is there, as the requirements
 *    for the merchant's country, business type and target level say. Staff-side checks are
 *    not asked of the merchant.
 *  - A draft merchant moves to `pending_kyc` through the merchant lifecycle's own rule; an
 *    active merchant stays active while it applies for a higher level or renews.
 *  - Screening is requested through the outbox, so it is queued exactly when the submission
 *    commits and never from the request handler (spec 8.8). The submission number makes each
 *    submission's screenings distinct.
 *  - The submission, its review-log entry and its audit row commit together.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import { ApiKeyCache } from '../../common/auth/api-key-cache';
import type { MerchantStatus } from '../../common/auth/principal';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { OutboxService } from '../../common/outbox/outbox.service';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { nextMerchantStatus } from '../merchants/domain/merchant-lifecycle';
import { decideSubmission, type KycStatus } from './domain/kyc-state';
import { missingForSubmission } from './domain/requirements';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycProfilesRepository } from './kyc-profiles.repository';
import { KycStatusService } from './kyc-status.service';

export const KYC_SCREENING_OUTBOX_TYPE = 'kyc.screening_requested';

export interface SubmitResult {
  readonly kind: 'initial' | 'resubmission' | 'upgrade' | 'reverification';
  readonly level: number;
  readonly submissionNo: number;
  readonly merchantStatus: MerchantStatus;
}

@Injectable()
export class KycSubmissionService {
  constructor(
    private readonly profiles: KycProfilesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly evidence: KycEvidenceService,
    private readonly status: KycStatusService,
    private readonly outbox: OutboxService,
    private readonly keyCache: ApiKeyCache,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async submit(scope: MerchantScope, requestedLevel?: number): Promise<SubmitResult> {
    const result = await this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockById(tx, scope.merchantId);
      if (!merchant) throw new AppError('NOT_FOUND');
      if (merchant.status === 'closed') {
        throw new AppError('KYC_NOT_ALLOWED', {
          messageParams: { reason: 'merchant_closed' },
          details: { reason: 'merchant_closed' },
        });
      }
      const profile = await this.status.ensureLocked(tx, merchant.id);
      const now = this.clock.now();
      const targetLevel = requestedLevel ?? this.status.targetLevelFor(merchant, profile);
      const kind = decideSubmission(
        {
          status: profile.status as KycStatus,
          approvedLevel: merchant.kycLevel,
          infoRequestedAt: profile.infoRequestedAt,
          nextReviewAt: profile.nextReviewAt,
        },
        targetLevel,
        profile.level,
        now
      );
      const snapshot = await this.evidence.build(merchant, profile, targetLevel, tx);
      const missing = missingForSubmission(snapshot.requirements);
      if (missing.length > 0) {
        throw new AppError('KYC_REQUIREMENTS_INCOMPLETE', { details: { missing } });
      }

      const submissionNo = profile.submissionNo + 1;
      await this.profiles.update(tx, profile.id, {
        status: 'pending',
        level: targetLevel,
        submissionNo,
        isReverification: kind === 'reverification',
        submittedAt: now,
        rejectionReasons: null,
        rejectionDetails: null,
        infoRequestedAt: null,
        infoRequestNote: null,
      });
      let merchantStatus = merchant.status as MerchantStatus;
      if (merchantStatus === 'draft') {
        merchantStatus = nextMerchantStatus('draft', 'submit_kyc', 'merchant');
        await this.merchants.setStatus(tx, merchant.id, merchantStatus);
      }
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo,
        decision: 'submitted',
        level: targetLevel,
      });
      await this.outbox.enqueue(tx, {
        eventType: KYC_SCREENING_OUTBOX_TYPE,
        aggregateType: 'kyc_profile',
        aggregateId: profile.id,
        payload: { kycProfileId: profile.id, submissionNo },
        dedupeKey: `kyc:screen:${profile.id}:${submissionNo}`,
      });
      await this.audit.record(tx, {
        action: 'kyc.submitted',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { status: profile.status, merchantStatus: merchant.status },
        after: { status: 'pending', level: targetLevel, kind, submissionNo, merchantStatus },
      });
      return {
        merchantId: merchant.id,
        value: { kind, level: targetLevel, submissionNo, merchantStatus } satisfies SubmitResult,
        statusChanged: merchantStatus !== merchant.status,
      };
    });
    if (result.statusChanged) {
      // Cached API keys carry the merchant's status (spec 8.3).
      await this.keyCache.evictMerchant(result.merchantId).catch((error: unknown) => {
        this.logger.error(
          { err: toLoggableError(error), merchantId: result.merchantId },
          'api key cache eviction failed; cached keys expire within 60 seconds'
        );
      });
    }
    return result.value;
  }
}
