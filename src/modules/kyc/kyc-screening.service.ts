/**
 * Onboarding screening of a KYC submission (spec 6.13 step 1): the merchant, each director
 * and each UBO, against sanctions and PEP lists. Runs in the `aml-screen` queue, never in a
 * request.
 *
 * The outbox row written at submission becomes one job per subject (`subjectJobs`); each job
 * calls `screenSubject`, which asks the AML module to screen and record. Everything is keyed
 * by (profile, submission, subject), so a retried or duplicated job is the same screening.
 * A provider that does not answer makes the job fail and retry; approval stays blocked
 * until every subject has a result (`KycReviewService`).
 *
 * The directors' and UBOs' names are decrypted here, for the screening call only. They go to
 * the screening provider and nowhere else.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { AmlScreeningService, type SubjectType } from '../aml/screening/aml-screening.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { KycDataRepository } from './kyc-data.repository';
import { KycProfilesRepository } from './kyc-profiles.repository';

export interface ScreeningSubjectJob {
  readonly kycProfileId: string;
  readonly submissionNo: number;
  readonly subjectType: SubjectType;
  /** The merchant ref or the party ref. */
  readonly subjectRef: string;
}

export function screeningJobId(job: ScreeningSubjectJob): string {
  return `kyc_screen_${job.kycProfileId}_${job.submissionNo}_${job.subjectRef}`;
}

@Injectable()
export class KycScreeningService {
  constructor(
    private readonly profiles: KycProfilesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly data: KycDataRepository,
    private readonly screening: AmlScreeningService,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Who must be screened for a submission: the merchant and every active party. */
  async subjectJobs(
    tx: Executor,
    kycProfileId: string,
    submissionNo: number
  ): Promise<ScreeningSubjectJob[]> {
    const profile = await this.profiles.findById(kycProfileId, tx);
    if (!profile) return [];
    const merchant = await this.merchants.findById(profile.merchantId, tx);
    if (!merchant) return [];
    const parties = await this.data.activeParties(merchant.id, tx);
    return [
      { kycProfileId, submissionNo, subjectType: 'merchant', subjectRef: merchant.ref },
      ...parties.map((p) => ({
        kycProfileId,
        submissionNo,
        subjectType: p.kind as SubjectType,
        subjectRef: p.ref,
      })),
    ];
  }

  /** Screens one subject. Throws when the provider does not answer, so the job retries. */
  async screenSubject(job: ScreeningSubjectJob): Promise<{ status: string; ref: string }> {
    const profile = await this.profiles.findById(job.kycProfileId);
    if (!profile) return { status: 'skipped', ref: '' };
    const merchant = await this.merchants.findById(profile.merchantId);
    if (!merchant) return { status: 'skipped', ref: '' };

    let query: Parameters<AmlScreeningService['screen']>[0]['query'];
    if (job.subjectType === 'merchant') {
      query = {
        entityType: 'organization',
        name: merchant.legalName,
        country: merchant.country,
      };
    } else {
      const party = (await this.data.activeParties(merchant.id)).find(
        (p) => p.ref === job.subjectRef
      );
      // A party removed since the submission needs no screening.
      if (!party) return { status: 'skipped', ref: '' };
      query = {
        entityType: 'person',
        name: this.encryption.decrypt(party.fullNameEnc, `kyc_parties.full_name:${party.ref}`),
        ...(party.dateOfBirthEnc
          ? {
              birthDate: this.encryption.decrypt(
                party.dateOfBirthEnc,
                `kyc_parties.date_of_birth:${party.ref}`
              ),
            }
          : {}),
        ...(party.nationality ? { country: party.nationality } : {}),
      };
    }

    const row = await this.screening.screen({
      subjectType: job.subjectType,
      subjectId: job.subjectRef,
      merchantId: merchant.id,
      merchantRef: merchant.ref,
      query,
      dedupeKey: `kyc:${job.kycProfileId}:${job.submissionNo}:${job.subjectRef}`,
      kycProfileId: job.kycProfileId,
      submissionNo: job.submissionNo,
    });
    await this.recordVerification(job, merchant.id, row.ref, row.status, row.provider);
    return { status: row.status, ref: row.ref };
  }

  /** Writes the `sanctions` check once per screening, for the KYC record of the submission. */
  private async recordVerification(
    job: ScreeningSubjectJob,
    merchantId: string,
    screeningRef: string,
    status: string,
    provider: string
  ): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const existing = (await this.profiles.verifications(job.kycProfileId, tx)).some(
        (v) => v.checkType === 'sanctions' && v.result.screening === screeningRef
      );
      if (existing) return;
      await this.profiles.insertVerification(tx, {
        id: uuidv7(this.clock.now()),
        kycProfileId: job.kycProfileId,
        merchantId,
        checkType: 'sanctions',
        provider,
        status: status === 'clear' ? 'passed' : status === 'potential_match' ? 'pending' : 'failed',
        result: { screening: screeningRef, subject: job.subjectRef, subjectType: job.subjectType },
        submissionNo: job.submissionNo,
        performedAt: this.clock.now(),
      });
    });
  }
}
