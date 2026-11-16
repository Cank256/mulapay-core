/**
 * KYC review by staff (spec 6.13, 7.3): approve, reject, ask for more information, record
 * verifications, and the queue.
 *
 * Approval is the point where a merchant becomes able to take live payments, so it is the most
 * constrained operation in this module. Invariants upheld:
 *  - Atomic. The profile's status, the merchant's level and status, the merchant's limits, the
 *    review-log entry, the merchant events and the audit row are written in one transaction,
 *    with the audit row last. If any step fails nothing changed: no approved profile without
 *    an active merchant, no active merchant without its limits.
 *  - Complete. Every mandatory requirement for the merchant's country, business type and
 *    level is verified (`unmetForApproval`), and the merchant and every director and UBO of
 *    the submission has a sanctions and PEP screening result that is clear. A potential or
 *    confirmed match, or a screening that has not finished (or whose provider failed),
 *    refuses the approval.
 *  - Separated. Whoever verified a document or recorded a check in this review cannot also
 *    approve it (spec 11: maker-checker on KYC approval).
 *  - Serialised. The merchant row and the profile row are locked, so a submission, an upload
 *    and an approval for one merchant run one after another.
 *  - Never lowers. Approval raises the merchant's level or keeps it (a renewal).
 *  - Limits come from `kyc_level_limits` (data); a limit set by hand by staff is not overwritten.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import { ApiKeyCache } from '../../common/auth/api-key-cache';
import type { MerchantStatus } from '../../common/auth/principal';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { kycDecisionsTotal } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { MerchantLimitsService } from '../aml/limits/merchant-limits.service';
import { AmlScreeningService } from '../aml/screening/aml-screening.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { nextMerchantStatus } from '../merchants/domain/merchant-lifecycle';
import { MerchantsRepository, type MerchantRow } from '../merchants/merchants.repository';
import { isReviewable, type KycStatus } from './domain/kyc-state';
import {
  isKycRejectionReason,
  reasonCodes,
  type RejectionDetail,
} from './domain/rejection-reasons';
import { unmetForApproval, VERIFICATION_CHECKS } from './domain/requirements';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycProfilesRepository, type ProfileRow } from './kyc-profiles.repository';
import { KycStatusService } from './kyc-status.service';

export type ManualCheck = (typeof VERIFICATION_CHECKS)[number];

function notAllowed(reason: string): AppError {
  return new AppError('KYC_NOT_ALLOWED', { messageParams: { reason }, details: { reason } });
}

const DAY_MS = 86_400_000;

@Injectable()
export class KycReviewService {
  constructor(
    private readonly profiles: KycProfilesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly evidence: KycEvidenceService,
    private readonly status: KycStatusService,
    private readonly screenings: AmlScreeningService,
    private readonly limits: MerchantLimitsService,
    private readonly events: MerchantEventsService,
    private readonly keyCache: ApiKeyCache,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async queue(query: {
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<Awaited<ReturnType<KycProfilesRepository['queue']>>[number]>> {
    const fingerprint = filterFingerprint({ status: query.status });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.profiles.queue({ status: query.status, after, limit: query.limit });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.profile.submittedAt ?? r.profile.createdAt,
      id: r.merchantRef,
    }));
  }

  /** Staff records a check they made themselves (contact, address, bank account, registry). */
  async recordCheck(
    merchantRef: string,
    input: { checkType: ManualCheck; status: 'passed' | 'failed'; note?: string },
    reviewerUserId: string
  ): Promise<void> {
    await this.inReview(merchantRef, async (tx, merchant, profile) => {
      const now = this.clock.now();
      await this.profiles.insertVerification(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        checkType: input.checkType,
        provider: 'manual',
        status: input.status,
        result: input.note ? { noteLength: input.note.length } : {},
        submissionNo: profile.submissionNo,
        performedBy: reviewerUserId,
        performedAt: now,
      });
      await this.touch(tx, profile, reviewerUserId);
      await this.audit.record(tx, {
        action: 'kyc.check.recorded',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        after: { checkType: input.checkType, status: input.status },
      });
    });
  }

  async requestInfo(merchantRef: string, note: string, reviewerUserId: string): Promise<void> {
    await this.inReview(merchantRef, async (tx, merchant, profile) => {
      const now = this.clock.now();
      await this.profiles.update(tx, profile.id, {
        status: 'in_review',
        reviewedBy: reviewerUserId,
        reviewedAt: now,
        infoRequestedAt: now,
        infoRequestNote: note,
      });
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo: profile.submissionNo,
        decision: 'info_requested',
        level: profile.level,
        reviewerId: reviewerUserId,
        note,
      });
      await this.events.emit(tx, {
        merchantId: merchant.id,
        environment: 'live',
        type: 'kyc.info_requested',
        resourceType: 'kyc',
        resourceId: merchant.ref,
        object: { id: merchant.ref, level: profile.level, note },
      });
      await this.audit.record(tx, {
        action: 'kyc.info_requested',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { status: profile.status },
        after: { status: 'in_review', noteLength: note.length },
      });
      kycDecisionsTotal.inc({ decision: 'info_requested' });
    });
  }

  async reject(
    merchantRef: string,
    details: readonly RejectionDetail[],
    note: string | undefined,
    reviewerUserId: string
  ): Promise<void> {
    if (details.length === 0 || details.some((d) => !isKycRejectionReason(d.code))) {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [{ path: 'reasons', message: 'at least one known reason is required' }],
        },
      });
    }
    await this.inReview(merchantRef, async (tx, merchant, profile) => {
      const now = this.clock.now();
      const reasons = reasonCodes(details);
      await this.profiles.update(tx, profile.id, {
        status: 'rejected',
        reviewedBy: reviewerUserId,
        reviewedAt: now,
        rejectionReasons: reasons,
        rejectionDetails: [...details],
        infoRequestedAt: null,
        infoRequestNote: null,
      });
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo: profile.submissionNo,
        decision: 'rejected',
        level: profile.level,
        reviewerId: reviewerUserId,
        reasons,
        details: [...details],
        note: note ?? null,
      });
      await this.events.emit(tx, {
        merchantId: merchant.id,
        environment: 'live',
        type: 'kyc.rejected',
        resourceType: 'kyc',
        resourceId: merchant.ref,
        object: { id: merchant.ref, level: profile.level, reasons, details: [...details] },
      });
      await this.audit.record(tx, {
        action: 'kyc.rejected',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { status: profile.status },
        after: { status: 'rejected', level: profile.level, reasons },
      });
      kycDecisionsTotal.inc({ decision: 'rejected' });
    });
  }

  /** Approves the submission and activates the merchant. See the class comment. */
  async approve(merchantRef: string, approverUserId: string, note?: string): Promise<MerchantRow> {
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    const outcome = await this.unitOfWork.run(async (tx) => {
      const locked = await this.merchants.lockById(tx, merchant.id);
      if (!locked) throw new AppError('NOT_FOUND');
      const profile = await this.status.ensureLocked(tx, merchant.id);
      if (!isReviewable(profile.status as KycStatus)) throw notAllowed('not_under_review');
      const now = this.clock.now();

      const snapshot = await this.evidence.build(locked, profile, profile.level, tx);
      const reviewers = await this.profiles.reviewersAfter(
        profile.id,
        snapshot.decidedSubmission,
        tx
      );
      if (reviewers.includes(approverUserId)) throw new AppError('KYC_SEPARATION_OF_DUTIES');
      const unmet = unmetForApproval(snapshot.requirements);
      if (unmet.length > 0) throw new AppError('KYC_REQUIREMENTS_NOT_MET', { details: { unmet } });
      await this.assertScreeningsClear(
        tx,
        locked,
        profile,
        snapshot.parties.map((p) => p.ref)
      );

      const level = Math.max(locked.kycLevel, profile.level);
      const activates = locked.status === 'pending_kyc';
      const status: MerchantStatus = activates
        ? nextMerchantStatus('pending_kyc', 'approve_kyc', 'system')
        : (locked.status as MerchantStatus);
      const expiresAt = this.expiryFor(now, snapshot.documents);
      const nextReviewAt = new Date(
        Math.max(now.getTime(), expiresAt.getTime() - this.config.KYC_REVERIFY_NOTICE_DAYS * DAY_MS)
      );

      await this.limits.applyLevel(tx, merchant.id, profile.level, 'approved');
      const updatedMerchant = await this.merchants.setKycLevel(
        tx,
        merchant.id,
        level,
        activates ? status : undefined
      );
      await this.profiles.update(tx, profile.id, {
        status: 'approved',
        level: profile.level,
        reviewedBy: approverUserId,
        reviewedAt: now,
        expiresAt,
        nextReviewAt,
        reverificationNotifiedAt: null,
        rejectionReasons: null,
        rejectionDetails: null,
        infoRequestedAt: null,
        infoRequestNote: null,
        isReverification: false,
      });
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo: profile.submissionNo,
        decision: 'approved',
        level: profile.level,
        reviewerId: approverUserId,
        note: note ?? null,
      });
      await this.events.emit(tx, {
        merchantId: merchant.id,
        environment: 'live',
        type: 'kyc.approved',
        resourceType: 'kyc',
        resourceId: merchant.ref,
        object: { id: merchant.ref, level, expiresAt: expiresAt.toISOString() },
      });
      if (activates) {
        await this.events.emit(tx, {
          merchantId: merchant.id,
          environment: 'live',
          type: 'merchant.activated',
          resourceType: 'merchant',
          resourceId: merchant.ref,
          object: { id: merchant.ref, status },
        });
      }
      // Last, so the audit row exists only if every change above did (spec 13).
      await this.audit.record(tx, {
        action: 'kyc.approved',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { status: profile.status, level: locked.kycLevel, merchantStatus: locked.status },
        after: {
          status: 'approved',
          level,
          merchantStatus: status,
          expiresAt: expiresAt.toISOString(),
          limitsApplied: true,
        },
      });
      kycDecisionsTotal.inc({ decision: 'approved' });
      return { merchant: updatedMerchant, activated: activates };
    });
    await this.afterCommit(merchant.id, outcome.activated);
    return outcome.merchant;
  }

  /** The submission's screenings: each subject must have a clear result. */
  private async assertScreeningsClear(
    tx: Transaction,
    merchant: MerchantRow,
    profile: ProfileRow,
    partyRefs: readonly string[]
  ): Promise<void> {
    const rows = await this.screenings.forSubmission(profile.id, profile.submissionNo, tx);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.subjectId)) latest.set(row.subjectId, row);
    const subjects = [merchant.ref, ...partyRefs];
    if ([...latest.values()].some((r) => r.status !== 'clear')) {
      throw new AppError('KYC_SCREENING_MATCH');
    }
    const pending = subjects.filter((s) => !latest.has(s));
    if (pending.length > 0) throw new AppError('KYC_SCREENING_REQUIRED', { details: { pending } });
  }

  /** Approval lasts `KYC_VALIDITY_DAYS`, or until the earliest verified document expires. */
  private expiryFor(
    now: Date,
    documents: readonly { status: string; expiresAt: Date | null }[]
  ): Date {
    let expiry = new Date(now.getTime() + this.config.KYC_VALIDITY_DAYS * DAY_MS);
    for (const doc of documents) {
      if (
        doc.status === 'verified' &&
        doc.expiresAt &&
        doc.expiresAt > now &&
        doc.expiresAt < expiry
      ) {
        expiry = doc.expiresAt;
      }
    }
    return expiry;
  }

  /** Runs `work` on a submission that is waiting for review, under the merchant and profile locks. */
  private async inReview(
    merchantRef: string,
    work: (tx: Transaction, merchant: MerchantRow, profile: ProfileRow) => Promise<void>
  ): Promise<void> {
    const found = await this.merchants.findByRef(merchantRef);
    if (!found) throw new AppError('NOT_FOUND');
    await this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockById(tx, found.id);
      if (!merchant) throw new AppError('NOT_FOUND');
      const profile = await this.status.ensureLocked(tx, merchant.id);
      if (!isReviewable(profile.status as KycStatus)) throw notAllowed('not_under_review');
      await work(tx, merchant, profile);
    });
  }

  /** The first review action on a pending submission moves it to `in_review`. */
  private async touch(tx: Transaction, profile: ProfileRow, reviewerUserId: string): Promise<void> {
    if (profile.status === 'pending') {
      await this.profiles.update(tx, profile.id, {
        status: 'in_review',
        reviewedBy: reviewerUserId,
      });
    }
  }

  private async afterCommit(merchantId: string, statusChanged: boolean): Promise<void> {
    // Limits and merchant status are cached (spec 8.3, 9.2); drop both. A failure here is
    // logged, not raised: the commit stands and the caches lapse within 60 seconds.
    await Promise.all([
      this.limits.invalidate(merchantId),
      statusChanged ? this.keyCache.evictMerchant(merchantId) : Promise.resolve(),
    ]).catch((error: unknown) => {
      this.logger.error(
        { err: toLoggableError(error), merchantId },
        'cache invalidation after KYC approval failed; entries expire within 60 seconds'
      );
    });
  }
}
