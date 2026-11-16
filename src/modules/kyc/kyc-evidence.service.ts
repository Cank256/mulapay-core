/**
 * Gathers what a merchant has provided and checks it against the requirements that apply to
 * it (spec 6.13). Read-only, and the single place the evidence is assembled, so the merchant's
 * status page, the submission check and the approval check cannot disagree.
 *
 * Staff verifications count only if they were recorded for a submission after the last one a
 * decision was made on (an approval, rejection or expiry): a renewal or a new submission after a
 * rejection asks for fresh checks, and an information request in the middle of a review does
 * not. When a merchant
 * applies for a higher level, the requirements of the levels it is already approved at count as
 * met: the earlier approval verified them.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { CLOCK } from '../../common/tokens';
import type { MerchantRow } from '../merchants/merchants.repository';
import {
  evaluateRequirements,
  type Evidence,
  type PartyKind,
  type RequirementStatus,
} from './domain/requirements';
import { KycDataRepository, type MerchantProfileRow, type PartyRow } from './kyc-data.repository';
import { KycDocumentsRepository, type DocumentRow } from './kyc-documents.repository';
import { KycProfilesRepository, type ProfileRow } from './kyc-profiles.repository';
import { KycRequirementsService } from './kyc-requirements.service';

export interface EvidenceSnapshot {
  readonly requirements: RequirementStatus[];
  readonly documents: DocumentRow[];
  readonly parties: PartyRow[];
  readonly profile: MerchantProfileRow | undefined;
  /** The last submission a decision was made on; checks recorded up to it are stale. */
  readonly decidedSubmission: number;
}

export function profileFieldsOf(profile: MerchantProfileRow | undefined): Set<string> {
  const fields = new Set<string>();
  if (!profile) return fields;
  if (profile.businessType) fields.add('business_type');
  if (profile.registrationNumber) fields.add('registration_number');
  if (profile.tinEnc) fields.add('tin');
  if (profile.incorporationDate) fields.add('incorporation_date');
  if (Object.keys(profile.address).length > 0) fields.add('address');
  return fields;
}

@Injectable()
export class KycEvidenceService {
  constructor(
    private readonly requirements: KycRequirementsService,
    private readonly profiles: KycProfilesRepository,
    private readonly documents: KycDocumentsRepository,
    private readonly data: KycDataRepository,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async build(
    merchant: MerchantRow,
    profile: ProfileRow | undefined,
    targetLevel: number,
    tx: Executor = this.db
  ): Promise<EvidenceSnapshot> {
    const [merchantProfile, documents, parties, decidedSubmission] = await Promise.all([
      this.data.findProfile(merchant.id, tx),
      this.documents.listActive(merchant.id, tx),
      this.data.activeParties(merchant.id, tx),
      profile ? this.profiles.lastDecidedSubmission(profile.id, tx) : Promise.resolve(0),
    ]);
    const checks = profile
      ? await this.profiles.latestChecksAfter(profile.id, decidedSubmission, tx)
      : [];
    const rows = await this.requirements.resolveFor({
      country: merchant.country,
      businessType: merchantProfile?.businessType ?? null,
      targetLevel,
    });
    const count = (kind: PartyKind) => parties.filter((p) => p.kind === kind).length;
    const evidence: Evidence = {
      profileFields: profileFieldsOf(merchantProfile),
      documents: documents.map((d) => ({
        type: d.type,
        status: d.status as 'uploaded' | 'verified' | 'rejected',
        expiresAt: d.expiresAt,
      })),
      parties: { director: count('director'), ubo: count('ubo') },
      passedChecks: new Set(checks.filter((c) => c.status === 'passed').map((c) => c.checkType)),
    };
    // An upgrade does not ask again for what an earlier approval already verified. A renewal
    // (same level) and anything after expiry start fresh.
    const carried =
      targetLevel > merchant.kycLevel && profile?.status !== 'expired' ? merchant.kycLevel : 0;
    const requirements = evaluateRequirements(rows, evidence, this.clock.now()).map((r) =>
      r.level <= carried && r.state !== 'verified' ? { ...r, state: 'verified' as const } : r
    );
    return {
      requirements,
      documents,
      parties,
      profile: merchantProfile,
      decidedSubmission,
    };
  }
}
