/**
 * KYC requirements as data (spec 6.13). Which items a merchant must provide is decided by the
 * rows of `kyc_requirements`, not by code: this module only resolves which rows apply to a
 * merchant and checks them against what the merchant has. No country, business type or
 * level is mentioned here. Pure.
 *
 * Resolution. A row applies when it is active, its level is at or below the level applied
 * for, and its country and business type are `*` or equal to the merchant's. Where several
 * rows share a `requirement_code`, the most specific wins (an exact country beats `*`, then
 * an exact business type beats `*`; on a tie the lower level wins). This is how a country or
 * business type relaxes a requirement (a row with `mandatory = false`) or adds its own.
 *
 * Evidence. Each requirement is `missing`, `provided` (the merchant has done its part) or
 * `verified` (staff have confirmed it). A merchant can submit once every mandatory item the
 * merchant can supply is provided; approval needs every mandatory item verified.
 */
export const REQUIREMENT_KINDS = ['document', 'profile_field', 'party', 'verification'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Profile attributes a `profile_field` requirement may name. */
export const PROFILE_FIELDS = [
  'business_type',
  'registration_number',
  'tin',
  'incorporation_date',
  'address',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const PARTY_KINDS = ['director', 'ubo'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const VERIFICATION_CHECKS = [
  'business_registry',
  'address',
  'bank_account',
  'contact',
] as const;

export interface RequirementRow {
  readonly level: number;
  readonly country: string;
  readonly businessType: string;
  readonly requirementCode: string;
  readonly kind: RequirementKind;
  readonly evidenceKey: string;
  readonly label: string;
  readonly description: string;
  readonly mandatory: boolean;
  readonly active: boolean;
  readonly sortOrder: number;
}

export interface MerchantFacts {
  readonly country: string;
  /** Null until the merchant has said what kind of business it is. */
  readonly businessType: string | null;
  readonly targetLevel: number;
}

function specificity(row: RequirementRow, facts: MerchantFacts): number {
  return (
    (row.country === facts.country ? 2 : 0) + (row.businessType === facts.businessType ? 1 : 0)
  );
}

/** The requirements that apply to `facts`, one per code, in display order. */
export function resolveRequirements(
  rows: readonly RequirementRow[],
  facts: MerchantFacts
): RequirementRow[] {
  const best = new Map<string, RequirementRow>();
  for (const row of rows) {
    if (!row.active || row.level > facts.targetLevel) continue;
    if (row.country !== '*' && row.country !== facts.country) continue;
    if (row.businessType !== '*' && row.businessType !== facts.businessType) continue;
    const current = best.get(row.requirementCode);
    if (
      !current ||
      specificity(row, facts) > specificity(current, facts) ||
      (specificity(row, facts) === specificity(current, facts) && row.level < current.level)
    ) {
      best.set(row.requirementCode, row);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.requirementCode.localeCompare(b.requirementCode)
  );
}

export interface DocumentEvidence {
  readonly type: string;
  readonly status: 'uploaded' | 'verified' | 'rejected';
  readonly expiresAt: Date | null;
}

export interface Evidence {
  /** Profile fields that hold a value. */
  readonly profileFields: ReadonlySet<string>;
  /** Documents not removed. */
  readonly documents: readonly DocumentEvidence[];
  /** Active parties by kind. */
  readonly parties: Readonly<Record<PartyKind, number>>;
  /** Check types whose latest result for this submission passed. */
  readonly passedChecks: ReadonlySet<string>;
}

export type EvidenceState = 'missing' | 'provided' | 'verified';

export interface RequirementStatus {
  readonly code: string;
  readonly kind: RequirementKind;
  readonly evidenceKey: string;
  readonly label: string;
  readonly description: string;
  readonly mandatory: boolean;
  readonly level: number;
  readonly state: EvidenceState;
}

function usable(doc: DocumentEvidence, now: Date): boolean {
  return doc.status !== 'rejected' && (doc.expiresAt === null || doc.expiresAt > now);
}

function stateOf(row: RequirementRow, evidence: Evidence, now: Date): EvidenceState {
  switch (row.kind) {
    case 'profile_field':
      return evidence.profileFields.has(row.evidenceKey) ? 'verified' : 'missing';
    case 'party':
      return (evidence.parties[row.evidenceKey as PartyKind] ?? 0) > 0 ? 'verified' : 'missing';
    case 'verification':
      return evidence.passedChecks.has(row.evidenceKey) ? 'verified' : 'missing';
    case 'document': {
      const docs = evidence.documents.filter((d) => d.type === row.evidenceKey && usable(d, now));
      if (docs.some((d) => d.status === 'verified')) return 'verified';
      return docs.length > 0 ? 'provided' : 'missing';
    }
  }
}

export function evaluateRequirements(
  rows: readonly RequirementRow[],
  evidence: Evidence,
  now: Date
): RequirementStatus[] {
  return rows.map((row) => ({
    code: row.requirementCode,
    kind: row.kind,
    evidenceKey: row.evidenceKey,
    label: row.label,
    description: row.description,
    mandatory: row.mandatory,
    level: row.level,
    state: stateOf(row, evidence, now),
  }));
}

/** Mandatory items the merchant still has to supply. Staff-side verifications are not asked of it. */
export function missingForSubmission(statuses: readonly RequirementStatus[]): string[] {
  return statuses
    .filter((s) => s.mandatory && s.kind !== 'verification' && s.state === 'missing')
    .map((s) => s.code);
}

/** Mandatory items that are not verified yet: what stands between a submission and approval. */
export function unmetForApproval(statuses: readonly RequirementStatus[]): string[] {
  return statuses.filter((s) => s.mandatory && s.state !== 'verified').map((s) => s.code);
}
