/**
 * The staff view of one merchant's KYC (spec 7.3 `GET /admin/v1/kyc/:merchantRef`): the
 * status page the merchant sees, plus the review log, the checks that were recorded, the
 * screening results of the current submission and the directors and UBOs.
 *
 * Reads only. Personal data is limited to what a reviewer needs: names, and ID numbers as
 * their last four characters. Files are not reachable from here; opening one goes through
 * `KycDocumentsService.view`, which is audited.
 */
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { AmlScreeningService } from '../aml/screening/aml-screening.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { KycDataService, type PartyView } from './kyc-data.service';
import { KycProfilesRepository } from './kyc-profiles.repository';
import { KycStatusService } from './kyc-status.service';
import type { KycStatusView } from './kyc.views';

export interface KycAdminView {
  readonly merchant: { ref: string; legalName: string; country: string; status: string };
  readonly status: KycStatusView;
  readonly submissionNo: number;
  readonly reviews: Array<{
    decision: string;
    level: number;
    submissionNo: number;
    reasons: string[];
    note: string | null;
    at: string;
  }>;
  readonly checks: Array<{
    checkType: string;
    status: string;
    provider: string;
    submissionNo: number;
    at: string;
  }>;
  readonly screenings: Array<{
    ref: string;
    subjectType: string;
    subject: string;
    status: string;
    lists: string[];
    highestScore: number | null;
    hitCount: number;
  }>;
  readonly parties: PartyView[];
}

@Injectable()
export class KycAdminService {
  constructor(
    private readonly merchants: MerchantsRepository,
    private readonly profiles: KycProfilesRepository,
    private readonly status: KycStatusService,
    private readonly screenings: AmlScreeningService,
    private readonly data: KycDataService
  ) {}

  async detail(merchantRef: string): Promise<KycAdminView> {
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    const profile = await this.profiles.findByMerchant(merchant.id);
    const [status, reviews, checks, screenings, parties] = await Promise.all([
      this.status.view(merchant.id),
      profile ? this.profiles.reviews(profile.id) : Promise.resolve([]),
      profile ? this.profiles.verifications(profile.id) : Promise.resolve([]),
      profile && profile.submissionNo > 0
        ? this.screenings.forSubmission(profile.id, profile.submissionNo)
        : Promise.resolve([]),
      this.data.listParties(merchant.id),
    ]);
    return {
      merchant: {
        ref: merchant.ref,
        legalName: merchant.legalName,
        country: merchant.country,
        status: merchant.status,
      },
      status,
      submissionNo: profile?.submissionNo ?? 0,
      reviews: reviews.map((r) => ({
        decision: r.decision,
        level: r.level,
        submissionNo: r.submissionNo,
        reasons: r.reasons,
        note: r.note,
        at: r.createdAt.toISOString(),
      })),
      checks: checks.map((c) => ({
        checkType: c.checkType,
        status: c.status,
        provider: c.provider,
        submissionNo: c.submissionNo,
        at: c.performedAt.toISOString(),
      })),
      screenings: screenings.map((s) => ({
        ref: s.ref,
        subjectType: s.subjectType,
        subject: s.subjectId,
        status: s.status,
        lists: s.lists,
        highestScore: s.highestScore,
        hitCount: s.hitCount,
      })),
      parties,
    };
  }
}
