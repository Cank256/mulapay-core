/** Request and response shapes of the KYC routes (dashboard and admin). Strict by default. */
import { z } from 'zod';
import { KYC_REJECTION_REASONS } from '../../modules/kyc/domain/rejection-reasons';
import { PARTY_KINDS, REQUIREMENT_KINDS } from '../../modules/kyc/domain/requirements';
import {
  documentViewSchema,
  kycStatusSchema,
  requirementStatusSchema,
} from '../../modules/kyc/kyc.views';
import { countrySchema, refSchema } from './schemas';

const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(25);
const cursor = z.string().min(1).max(512).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const dateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const code = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'lower-case letters, digits and underscores');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256');
const smallRecord = z
  .record(z.string().min(1).max(40), z.string().max(200))
  .refine((m) => Object.keys(m).length <= 8, 'at most 8 keys');

// ---- merchant (dashboard) ----
export const levelQuerySchema = z.strictObject({
  level: z.coerce.number().int().min(1).max(3).optional(),
});

export const requirementsResultSchema = z.object({
  targetLevel: z.number().int(),
  requirements: z.array(requirementStatusSchema),
});

export const profileBodySchema = z.strictObject({
  businessType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .optional(),
  registrationNumber: z.string().trim().min(1).max(64).optional(),
  tin: z.string().trim().min(3).max(32).optional(),
  incorporationDate: isoDate.optional(),
  address: smallRecord.optional(),
});

export const profileViewSchema = z.object({
  businessType: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  tinLast4: z.string().nullable(),
  incorporationDate: z.string().nullable(),
  address: z.record(z.string(), z.string()),
});

export const partyBodySchema = z.strictObject({
  kind: z.enum(PARTY_KINDS),
  fullName: z.string().trim().min(2).max(200),
  dateOfBirth: isoDate.optional(),
  nationality: countrySchema.optional(),
  idNumber: z.string().trim().min(3).max(64).optional(),
  ownershipBps: z.number().int().min(1).max(10000).optional(),
});

export const partyViewSchema = z.object({
  ref: z.string(),
  kind: z.enum(PARTY_KINDS),
  fullName: z.string(),
  dateOfBirth: z.string().nullable(),
  nationality: z.string().nullable(),
  idNumberLast4: z.string().nullable(),
  ownershipBps: z.number().int().nullable(),
});
export const partyListSchema = z.object({ items: z.array(partyViewSchema) });

export const submitBodySchema = z.strictObject({
  level: z.number().int().min(1).max(3).optional(),
});
export const submitResultSchema = z.object({
  kind: z.enum(['initial', 'resubmission', 'upgrade', 'reverification']),
  level: z.number().int(),
  submissionNo: z.number().int(),
  merchantStatus: z.enum(['draft', 'pending_kyc', 'active', 'suspended', 'closed']),
});

export const presignBodySchema = z.strictObject({
  type: code,
  contentType: z.string().min(1).max(100),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  sha256,
});
export const presignResultSchema = z.object({
  documentId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});

export const confirmBodySchema = presignBodySchema.extend({
  documentId: z.string().regex(/^kdoc_[0-9A-HJKMNP-TV-Z]{26}$/),
  expiresAt: dateTime.optional(),
  metadata: smallRecord.optional(),
});

export const documentIdParamSchema = z.strictObject({ id: refSchema });

export { documentViewSchema, kycStatusSchema };

// ---- staff (admin) ----
export const merchantRefParamSchema = z.strictObject({ merchantRef: refSchema });
export const documentParamSchema = z.strictObject({ merchantRef: refSchema, id: refSchema });
export const requirementIdParamSchema = z.strictObject({ id: z.uuid() });

export const queueQuerySchema = z.strictObject({
  status: z.enum(['pending', 'in_review']).optional(),
  limit: limit(200),
  cursor,
});

export const queueItemSchema = z.object({
  merchant: z.string(),
  legalName: z.string(),
  status: z.enum(['not_started', 'pending', 'in_review', 'approved', 'rejected', 'expired']),
  level: z.number().int(),
  submissionNo: z.number().int(),
  submittedAt: z.string().nullable(),
  isReverification: z.boolean(),
});
export const queuePageSchema = z.object({
  items: z.array(queueItemSchema),
  nextCursor: z.string().nullable(),
});

export const adminDetailSchema = z.object({
  merchant: z.object({
    ref: z.string(),
    legalName: z.string(),
    country: z.string(),
    status: z.string(),
  }),
  status: kycStatusSchema,
  submissionNo: z.number().int(),
  reviews: z.array(
    z.object({
      decision: z.string(),
      level: z.number().int(),
      submissionNo: z.number().int(),
      reasons: z.array(z.string()),
      note: z.string().nullable(),
      at: z.string(),
    })
  ),
  checks: z.array(
    z.object({
      checkType: z.string(),
      status: z.string(),
      provider: z.string(),
      submissionNo: z.number().int(),
      at: z.string(),
    })
  ),
  screenings: z.array(
    z.object({
      ref: z.string(),
      subjectType: z.string(),
      subject: z.string(),
      status: z.enum(['clear', 'potential_match', 'confirmed_match']),
      lists: z.array(z.string()),
      highestScore: z.number().nullable(),
      hitCount: z.number().int(),
    })
  ),
  parties: z.array(partyViewSchema),
});

export const approveBodySchema = z.strictObject({
  note: z.string().trim().min(1).max(1000).optional(),
});
export const rejectBodySchema = z.strictObject({
  reasons: z
    .array(
      z.strictObject({
        code: z.enum(KYC_REJECTION_REASONS),
        target: z.string().min(1).max(64).optional(),
        note: z.string().trim().min(1).max(500).optional(),
      })
    )
    .min(1)
    .max(20),
  note: z.string().trim().min(1).max(1000).optional(),
});
export const requestInfoBodySchema = z.strictObject({ note: z.string().trim().min(1).max(1000) });
export const verifyDocumentBodySchema = z.strictObject({
  decision: z.enum(['verify', 'reject']),
  reason: z.string().min(1).max(64).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  expiresAt: dateTime.nullable().optional(),
});
export const checkBodySchema = z.strictObject({
  checkType: z.enum(['business_registry', 'address', 'bank_account', 'contact']),
  status: z.enum(['passed', 'failed']),
  note: z.string().trim().min(1).max(500).optional(),
});
export const okSchema = z.object({ ok: z.literal(true) });
export const decisionResultSchema = z.object({
  merchant: z.string(),
  status: z.string(),
  level: z.number().int(),
});

export const documentViewResultSchema = z.object({
  document: documentViewSchema,
  url: z.string(),
  expiresAt: z.string(),
});

export const requirementRowSchema = z.object({
  id: z.string(),
  level: z.number().int(),
  country: z.string(),
  businessType: z.string(),
  code: z.string(),
  kind: z.enum(REQUIREMENT_KINDS),
  evidenceKey: z.string(),
  label: z.string(),
  description: z.string(),
  mandatory: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int(),
});
export const requirementListSchema = z.object({ items: z.array(requirementRowSchema) });
export const requirementListQuerySchema = z.strictObject({
  country: z
    .string()
    .regex(/^(\*|[A-Z]{2})$/)
    .optional(),
  level: z.coerce.number().int().min(1).max(3).optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export const requirementCreateSchema = z.strictObject({
  level: z.number().int().min(1).max(3),
  country: z
    .string()
    .regex(/^(\*|[A-Z]{2})$/)
    .default('*'),
  businessType: z
    .string()
    .regex(/^(\*|[a-z][a-z0-9_]{1,39})$/)
    .default('*'),
  code,
  kind: z.enum(REQUIREMENT_KINDS),
  evidenceKey: code,
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  mandatory: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export const requirementPatchSchema = z.strictObject({
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  mandatory: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  kind: z.enum(REQUIREMENT_KINDS).optional(),
  evidenceKey: code.optional(),
});
