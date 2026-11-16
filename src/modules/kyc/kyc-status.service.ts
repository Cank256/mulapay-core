/**
 * A merchant's KYC profile and the status page built from it (spec 7.2 `GET /kyc`).
 *
 * `ensureLocked` is how every KYC write starts: it creates the profile on first use and takes
 * its row lock, so two requests about one merchant's KYC (an upload and a submit, a submit
 * and an approval) run one after the other.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { MerchantLimitsService } from '../aml/limits/merchant-limits.service';
import { MerchantsRepository, type MerchantRow } from '../merchants/merchants.repository';
import { MAX_KYC_LEVEL, type KycStatus } from './domain/kyc-state';
import { missingForSubmission } from './domain/requirements';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycProfilesRepository, type ProfileRow } from './kyc-profiles.repository';
import { rejectionOf, toDocumentView, toRequirementView, type KycStatusView } from './kyc.views';

@Injectable()
export class KycStatusService {
  constructor(
    private readonly profiles: KycProfilesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly evidence: KycEvidenceService,
    private readonly limits: MerchantLimitsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** The profile of a merchant, created if it has none, with its row locked. */
  async ensureLocked(tx: Transaction, merchantId: string): Promise<ProfileRow> {
    await this.profiles.ensure(tx, {
      id: uuidv7(this.clock.now()),
      merchantId,
      level: 0,
    });
    const profile = await this.profiles.lockByMerchant(tx, merchantId);
    if (!profile) throw new Error('kyc profile missing after ensure');
    return profile;
  }

  /** The level the merchant would apply for next. */
  targetLevelFor(merchant: MerchantRow, profile: ProfileRow | undefined): number {
    if (profile && (profile.status === 'pending' || profile.status === 'in_review')) {
      return profile.level;
    }
    if (profile && (profile.status === 'expired' || this.reverificationDue(profile))) {
      return Math.max(1, merchant.kycLevel);
    }
    return Math.min(MAX_KYC_LEVEL, merchant.kycLevel + 1);
  }

  reverificationDue(profile: ProfileRow): boolean {
    return (
      profile.status === 'approved' &&
      profile.nextReviewAt !== null &&
      profile.nextReviewAt <= this.clock.now()
    );
  }

  async view(merchantId: string, requestedLevel?: number): Promise<KycStatusView> {
    const merchant = await this.merchants.findById(merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    const profile = await this.profiles.findByMerchant(merchantId);
    const targetLevel = requestedLevel ?? this.targetLevelFor(merchant, profile);
    const snapshot = await this.evidence.build(merchant, profile, targetLevel);
    const missing = missingForSubmission(snapshot.requirements);
    const status = (profile?.status ?? 'not_started') as KycStatus;
    const limits = await this.limits.list(merchantId);
    return {
      level: merchant.kycLevel,
      status,
      targetLevel,
      submittedAt: profile?.submittedAt?.toISOString() ?? null,
      reviewedAt: profile?.reviewedAt?.toISOString() ?? null,
      rejection: profile ? rejectionOf(profile) : null,
      infoRequest:
        profile?.infoRequestedAt && status === 'in_review'
          ? {
              requestedAt: profile.infoRequestedAt.toISOString(),
              note: profile.infoRequestNote ?? '',
            }
          : null,
      expiresAt: profile?.expiresAt?.toISOString() ?? null,
      reverificationDueAt: profile?.nextReviewAt?.toISOString() ?? null,
      missing,
      canSubmit: missing.length === 0 && targetLevel >= 1 && targetLevel <= MAX_KYC_LEVEL,
      requirements: snapshot.requirements.map(toRequirementView),
      documents: snapshot.documents.map(toDocumentView),
      limits: limits.map((l) => ({
        currency: l.currency,
        perTransactionMaxMinor: l.perTxnMaxMinor.toString(),
        dailyVolumeMaxMinor: l.dailyVolumeMaxMinor.toString(),
        monthlyVolumeMaxMinor: l.monthlyVolumeMaxMinor.toString(),
      })),
    };
  }
}
