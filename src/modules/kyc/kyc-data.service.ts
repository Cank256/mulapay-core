/**
 * What a merchant tells us about itself for KYC: its registration details, and its directors
 * and ultimate beneficial owners (spec 6.13).
 *
 * Invariants upheld:
 *  - Personal data is encrypted before it is stored (AES-256-GCM, bound to the row it
 *    belongs to), with a keyed hash beside the ID number and the TIN for exact-match search
 *    (spec 11). Plaintext appears in a response to the merchant that entered it, in the STR
 *    export, and nowhere else: not in audit rows, logs or events.
 *  - Details can change only while the merchant may change them: not while a submission waits
 *    for review, except to answer a request for information.
 *  - A party is removed by marking it removed, never deleted; screening results keep
 *    pointing at it.
 *  - Every change is audited in the transaction that makes it, naming the fields, not values.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { PiiHasher } from '../../common/crypto/pii-hasher';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { KycDataRepository, type MerchantProfileRow, type PartyRow } from './kyc-data.repository';
import { KycStatusService } from './kyc-status.service';
import type { ProfileRow } from './kyc-profiles.repository';

export interface ProfileInput {
  readonly businessType?: string;
  readonly registrationNumber?: string;
  readonly tin?: string;
  readonly incorporationDate?: string;
  readonly address?: Record<string, string>;
}

export interface PartyInput {
  readonly kind: 'director' | 'ubo';
  readonly fullName: string;
  readonly dateOfBirth?: string;
  readonly nationality?: string;
  readonly idNumber?: string;
  readonly ownershipBps?: number;
}

export interface ProfileView {
  readonly businessType: string | null;
  readonly registrationNumber: string | null;
  readonly tinLast4: string | null;
  readonly incorporationDate: string | null;
  readonly address: Record<string, string>;
}

export interface PartyView {
  readonly ref: string;
  readonly kind: 'director' | 'ubo';
  readonly fullName: string;
  readonly dateOfBirth: string | null;
  readonly nationality: string | null;
  readonly idNumberLast4: string | null;
  readonly ownershipBps: number | null;
}

function editable(profile: ProfileRow): boolean {
  if (profile.status === 'pending') return false;
  if (profile.status === 'in_review') return profile.infoRequestedAt !== null;
  return true;
}

@Injectable()
export class KycDataService {
  constructor(
    private readonly data: KycDataRepository,
    private readonly status: KycStatusService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: PiiHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async updateProfile(scope: MerchantScope, input: ProfileInput): Promise<ProfileView> {
    return this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, scope.merchantId);
      if (!editable(profile)) {
        throw new AppError('KYC_NOT_ALLOWED', {
          messageParams: { reason: 'under_review' },
          details: { reason: 'under_review' },
        });
      }
      const fields: Parameters<KycDataRepository['upsertProfile']>[2] = {
        ...(input.businessType !== undefined ? { businessType: input.businessType } : {}),
        ...(input.registrationNumber !== undefined
          ? { registrationNumber: input.registrationNumber }
          : {}),
        ...(input.incorporationDate !== undefined
          ? { incorporationDate: input.incorporationDate }
          : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.tin !== undefined
          ? {
              tinEnc: this.encryption.encrypt(
                input.tin,
                `merchant_profiles.tin:${scope.merchantId}`
              ),
              tinHmac: this.hasher.digest('tin', input.tin.trim().toUpperCase()),
            }
          : {}),
      };
      const row = await this.data.upsertProfile(tx, scope.merchantId, fields);
      await this.audit.record(tx, {
        action: 'kyc.profile.updated',
        resourceType: 'merchant_profile',
        resourceId: scope.merchantRef,
        merchantId: scope.merchantId,
        after: { fields: Object.keys(input).sort() },
      });
      return this.profileOf(row);
    });
  }

  async profileView(merchantId: string): Promise<ProfileView> {
    return this.profileOf(await this.data.findProfile(merchantId));
  }

  /** The merchant's own details: the TIN as its last four characters only. */
  private profileOf(row: MerchantProfileRow | undefined): ProfileView {
    const tin =
      row?.tinEnc && row
        ? this.encryption.decrypt(row.tinEnc, `merchant_profiles.tin:${row.merchantId}`)
        : null;
    return {
      businessType: row?.businessType ?? null,
      registrationNumber: row?.registrationNumber ?? null,
      tinLast4: tin ? tin.slice(-4) : null,
      incorporationDate: row?.incorporationDate ?? null,
      address: row?.address ?? {},
    };
  }

  async addParty(scope: MerchantScope, input: PartyInput): Promise<PartyView> {
    if (input.kind === 'director' && input.ownershipBps !== undefined) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'ownershipBps', message: 'only applies to a ubo' }] },
      });
    }
    return this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, scope.merchantId);
      if (!editable(profile)) {
        throw new AppError('KYC_NOT_ALLOWED', {
          messageParams: { reason: 'under_review' },
          details: { reason: 'under_review' },
        });
      }
      const now = this.clock.now();
      const ref = publicId('kycParty', now);
      const row = await this.data.insertParty(tx, {
        id: uuidv7(now),
        ref,
        merchantId: scope.merchantId,
        kind: input.kind,
        fullNameEnc: this.encryption.encrypt(input.fullName, `kyc_parties.full_name:${ref}`),
        dateOfBirthEnc: input.dateOfBirth
          ? this.encryption.encrypt(input.dateOfBirth, `kyc_parties.date_of_birth:${ref}`)
          : null,
        nationality: input.nationality ?? null,
        idNumberEnc: input.idNumber
          ? this.encryption.encrypt(input.idNumber, `kyc_parties.id_number:${ref}`)
          : null,
        idNumberHmac: input.idNumber
          ? this.hasher.digest('party-id', input.idNumber.trim().toUpperCase())
          : null,
        ownershipBps: input.ownershipBps ?? null,
      });
      await this.audit.record(tx, {
        action: 'kyc.party.added',
        resourceType: 'kyc_party',
        resourceId: row.ref,
        merchantId: scope.merchantId,
        after: { kind: row.kind, ownershipBps: row.ownershipBps },
      });
      return this.view(row);
    });
  }

  async removeParty(scope: MerchantScope, ref: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, scope.merchantId);
      if (!editable(profile)) {
        throw new AppError('KYC_NOT_ALLOWED', {
          messageParams: { reason: 'under_review' },
          details: { reason: 'under_review' },
        });
      }
      const party = await this.data.lockParty(tx, scope.merchantId, ref);
      if (!party || party.status === 'removed') throw new AppError('NOT_FOUND');
      await this.data.removeParty(tx, party.id, this.clock.now());
      await this.audit.record(tx, {
        action: 'kyc.party.removed',
        resourceType: 'kyc_party',
        resourceId: party.ref,
        merchantId: scope.merchantId,
        before: { kind: party.kind },
      });
    });
  }

  async listParties(merchantId: string): Promise<PartyView[]> {
    return (await this.data.activeParties(merchantId)).map((p) => this.view(p));
  }

  /** The party as its merchant sees it: the name in full, the ID number as its last four. */
  view(row: PartyRow): PartyView {
    const idNumber = row.idNumberEnc
      ? this.encryption.decrypt(row.idNumberEnc, `kyc_parties.id_number:${row.ref}`)
      : null;
    return {
      ref: row.ref,
      kind: row.kind as 'director' | 'ubo',
      fullName: this.encryption.decrypt(row.fullNameEnc, `kyc_parties.full_name:${row.ref}`),
      dateOfBirth: row.dateOfBirthEnc
        ? this.encryption.decrypt(row.dateOfBirthEnc, `kyc_parties.date_of_birth:${row.ref}`)
        : null,
      nationality: row.nationality,
      idNumberLast4: idNumber ? idNumber.slice(-4) : null,
      ownershipBps: row.ownershipBps,
    };
  }
}
