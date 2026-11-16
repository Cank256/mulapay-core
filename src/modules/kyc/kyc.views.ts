/**
 * What KYC looks like on the API (spec 7.2, 7.3). Merchants see their own status, the
 * requirements and the documents they uploaded (never file keys or hashes); staff see the
 * same plus reviewer identities. Amounts are strings of minor units.
 */
import { z } from 'zod';
import type { RequirementStatus } from './domain/requirements';
import type { DocumentRow } from './kyc-documents.repository';
import type { ProfileRow } from './kyc-profiles.repository';

const iso = z.string();
const minor = z.string().regex(/^\d+$/);

export const requirementStatusSchema = z.object({
  code: z.string(),
  kind: z.enum(['document', 'profile_field', 'party', 'verification']),
  evidenceKey: z.string(),
  label: z.string(),
  description: z.string(),
  mandatory: z.boolean(),
  level: z.number().int(),
  state: z.enum(['missing', 'provided', 'verified']),
});

export const documentViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(['uploaded', 'verified', 'rejected']),
  mime: z.string(),
  sizeBytes: z.number().int(),
  uploadedAt: iso,
  reviewedAt: iso.nullable(),
  rejectionReason: z.string().nullable(),
  rejectionNote: z.string().nullable(),
  expiresAt: iso.nullable(),
  metadata: z.record(z.string(), z.string()),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

export const rejectionDetailSchema = z.object({
  code: z.string(),
  target: z.string().optional(),
  note: z.string().optional(),
});

export const limitViewSchema = z.object({
  currency: z.string(),
  perTransactionMaxMinor: minor,
  dailyVolumeMaxMinor: minor,
  monthlyVolumeMaxMinor: minor,
});

export const kycStatusSchema = z.object({
  /** The level the merchant is approved at. */
  level: z.number().int().min(0).max(3),
  status: z.enum(['not_started', 'pending', 'in_review', 'approved', 'rejected', 'expired']),
  /** The level being applied for, or the next one. */
  targetLevel: z.number().int().min(0).max(3),
  submittedAt: iso.nullable(),
  reviewedAt: iso.nullable(),
  rejection: z
    .object({ reasons: z.array(z.string()), details: z.array(rejectionDetailSchema) })
    .nullable(),
  infoRequest: z.object({ requestedAt: iso, note: z.string() }).nullable(),
  expiresAt: iso.nullable(),
  reverificationDueAt: iso.nullable(),
  /** Mandatory items the merchant still has to supply before it can submit. */
  missing: z.array(z.string()),
  canSubmit: z.boolean(),
  requirements: z.array(requirementStatusSchema),
  documents: z.array(documentViewSchema),
  limits: z.array(limitViewSchema),
});
export type KycStatusView = z.infer<typeof kycStatusSchema>;

export function toDocumentView(row: DocumentRow): DocumentView {
  return {
    id: row.ref,
    type: row.type,
    status: row.status as DocumentView['status'],
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    reviewedAt: row.verifiedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    rejectionNote: row.rejectionNote,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    metadata: row.metadata,
  };
}

export function toRequirementView(s: RequirementStatus): z.infer<typeof requirementStatusSchema> {
  return {
    code: s.code,
    kind: s.kind,
    evidenceKey: s.evidenceKey,
    label: s.label,
    description: s.description,
    mandatory: s.mandatory,
    level: s.level,
    state: s.state,
  };
}

export function rejectionOf(profile: ProfileRow): KycStatusView['rejection'] {
  if (profile.status !== 'rejected' || !profile.rejectionReasons) return null;
  return {
    reasons: profile.rejectionReasons,
    details: (profile.rejectionDetails ?? []) as Array<z.infer<typeof rejectionDetailSchema>>,
  };
}
