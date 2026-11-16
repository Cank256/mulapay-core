/**
 * Administration of `kyc_requirements` (spec 6.13, 7.3 `/admin/v1/kyc/requirements`): the
 * data that decides what a merchant must provide at each level, by country and business type.
 *
 * Invariants upheld:
 *  - A requirement's `kind` and `evidence_key` go together: a `profile_field` names a known
 *    profile field, a `party` a director or UBO, a `verification` a check staff can record, a
 *    `document` a document type code. A row that nothing could ever satisfy is refused.
 *  - A requirement is never deleted, only deactivated (`active = false`), so the history of
 *    what was asked stays. A change affects submissions from then on; approvals already given
 *    stand.
 *  - Each create and change is audited with the row before and after.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import {
  PARTY_KINDS,
  PROFILE_FIELDS,
  VERIFICATION_CHECKS,
  resolveRequirements,
  type MerchantFacts,
  type RequirementKind,
  type RequirementRow,
} from './domain/requirements';
import {
  KycRequirementsRepository,
  type RequirementDbRow,
  type RequirementPatch,
} from './kyc-requirements.repository';

export interface CreateRequirementInput {
  readonly level: number;
  readonly country: string;
  readonly businessType: string;
  readonly requirementCode: string;
  readonly kind: RequirementKind;
  readonly evidenceKey: string;
  readonly label: string;
  readonly description?: string;
  readonly mandatory?: boolean;
  readonly sortOrder?: number;
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
}

export function assertEvidenceKey(kind: RequirementKind, evidenceKey: string): void {
  const allowed: readonly string[] | null =
    kind === 'profile_field'
      ? PROFILE_FIELDS
      : kind === 'party'
        ? PARTY_KINDS
        : kind === 'verification'
          ? VERIFICATION_CHECKS
          : null;
  if (allowed && !allowed.includes(evidenceKey)) {
    throw invalid('evidenceKey', `must be one of ${allowed.join(', ')} for kind ${kind}`);
  }
}

export function toDomainRow(row: RequirementDbRow): RequirementRow {
  return {
    level: row.level,
    country: row.country,
    businessType: row.businessType,
    requirementCode: row.requirementCode,
    kind: row.kind as RequirementKind,
    evidenceKey: row.evidenceKey,
    label: row.label,
    description: row.description,
    mandatory: row.mandatory,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

function snapshot(row: RequirementDbRow): Record<string, unknown> {
  return {
    level: row.level,
    country: row.country,
    businessType: row.businessType,
    code: row.requirementCode,
    kind: row.kind,
    evidenceKey: row.evidenceKey,
    mandatory: row.mandatory,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

@Injectable()
export class KycRequirementsService {
  constructor(
    private readonly requirements: KycRequirementsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  list(filter: { country?: string; level?: number; activeOnly?: boolean } = {}) {
    return this.requirements.listAll(filter);
  }

  /** The requirements that apply to a merchant for a level: what the dashboard shows. */
  async resolveFor(facts: MerchantFacts): Promise<RequirementRow[]> {
    const rows = await this.requirements.listAll({ activeOnly: true });
    return resolveRequirements(rows.map(toDomainRow), facts);
  }

  /** Every active document type code the catalogue knows, for validating uploads. */
  async knownDocumentTypes(): Promise<Set<string>> {
    const rows = await this.requirements.listAll({ activeOnly: true });
    return new Set(rows.filter((r) => r.kind === 'document').map((r) => r.evidenceKey));
  }

  async create(input: CreateRequirementInput): Promise<RequirementDbRow> {
    assertEvidenceKey(input.kind, input.evidenceKey);
    try {
      return await this.unitOfWork.run(async (tx) => {
        const row = await this.requirements.insert(tx, {
          id: uuidv7(this.clock.now()),
          level: input.level,
          country: input.country,
          businessType: input.businessType,
          requirementCode: input.requirementCode,
          kind: input.kind,
          evidenceKey: input.evidenceKey,
          label: input.label,
          description: input.description ?? '',
          mandatory: input.mandatory ?? true,
          sortOrder: input.sortOrder ?? 100,
        });
        await this.audit.record(tx, {
          action: 'kyc.requirement.created',
          resourceType: 'kyc_requirement',
          resourceId: row.id,
          after: snapshot(row),
        });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'kyc_requirements_scope_key')) {
        throw invalid(
          'requirementCode',
          'a row for this level, country, business type and code exists'
        );
      }
      throw error;
    }
  }

  async update(id: string, patch: RequirementPatch): Promise<RequirementDbRow> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.requirements.lockById(tx, id);
      if (!current) throw new AppError('NOT_FOUND');
      const kind = (patch.kind ?? current.kind) as RequirementKind;
      assertEvidenceKey(kind, patch.evidenceKey ?? current.evidenceKey);
      const row = await this.requirements.update(tx, id, patch);
      await this.audit.record(tx, {
        action: 'kyc.requirement.updated',
        resourceType: 'kyc_requirement',
        resourceId: row.id,
        before: snapshot(current),
        after: snapshot(row),
      });
      return row;
    });
  }

  /** Deactivates a requirement. It is never deleted. */
  deactivate(id: string): Promise<RequirementDbRow> {
    return this.update(id, { active: false });
  }
}
