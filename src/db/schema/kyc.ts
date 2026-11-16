/**
 * KYC (spec 5.2 "Compliance and support", 6.13).
 *
 * `kyc_requirements` is the data that decides what a merchant must provide, by country,
 * business type and level; no requirement is written into application code. A merchant has
 * one `kyc_profiles` row: `level` is the level currently applied for, and the level it has
 * been approved at is `merchants.kyc_level`. Approval changes the profile, the merchant and
 * `merchant_limits` in one transaction.
 *
 * Personal data (directors, UBOs, TIN) is stored encrypted with a keyed hash beside it for
 * exact-match search (spec 11). Documents are never stored here, only the object key, hash,
 * type and size of the file in object storage.
 *
 * Database rules added by migration 0007 (the domain checks them first): a document's file
 * identity never changes, a verified or rejected document is final, `kyc_reviews` is
 * append-only, and a profile's status moves only along the allowed transitions.
 *
 * Deviations from spec 5.2, listed in docs/ARCHITECTURE.md ("Phase 7 decisions to confirm"):
 * `kyc_parties` holds directors and UBOs instead of `merchant_profiles.directors jsonb`,
 * `kyc_verifications.check_type` also allows `contact`, and the requirement table has
 * `kind`, `evidence_key`, `label`, `description`, `active` and `sort_order`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';
import { currencies } from './ledger';
import { merchants } from './merchants';

export const KYC_STATUSES = [
  'not_started',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'expired',
] as const;
export const KYC_REQUIREMENT_KINDS = [
  'document',
  'profile_field',
  'party',
  'verification',
] as const;
export const KYC_CHECK_TYPES = [
  'document',
  'business_registry',
  'sanctions',
  'address',
  'bank_account',
  'contact',
] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const merchantProfiles = core.table('merchant_profiles', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id),
  registrationNumber: text('registration_number'),
  /** AES-256-GCM, context `merchant_profiles.tin:{merchantId}`. */
  tinEnc: text('tin_enc'),
  tinHmac: text('tin_hmac'),
  incorporationDate: date('incorporation_date', { mode: 'string' }),
  businessType: text('business_type'),
  address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const kycRequirements = core.table(
  'kyc_requirements',
  {
    id: uuid('id').primaryKey(),
    /** The level at which the requirement starts to apply (it also applies to higher levels). */
    level: smallint('level').notNull(),
    /** ISO 3166-1 alpha-2, or `*` for every country. */
    country: text('country').notNull().default('*'),
    /** A business type code, or `*` for every type. */
    businessType: text('business_type').notNull().default('*'),
    requirementCode: text('requirement_code').notNull(),
    /** How the requirement is evidenced; `evidence_key` names the document type, profile field, party kind or check type. */
    kind: text('kind').notNull(),
    evidenceKey: text('evidence_key').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    mandatory: boolean('mandatory').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('kyc_requirements_scope_key').on(
      t.level,
      t.country,
      t.businessType,
      t.requirementCode
    ),
    index('kyc_requirements_lookup_idx')
      .on(t.country, t.businessType, t.level)
      .where(sql`${t.active}`),
    check('kyc_requirements_level_check', sql`${t.level} between 1 and 3`),
    check('kyc_requirements_country_check', sql`${t.country} = '*' or ${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'kyc_requirements_business_type_check',
      sql`${t.businessType} = '*' or ${t.businessType} ~ '^[a-z][a-z0-9_]{1,39}$'`
    ),
    check('kyc_requirements_code_check', sql`${t.requirementCode} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check('kyc_requirements_kind_check', sql`${t.kind} in (${list(KYC_REQUIREMENT_KINDS)})`),
    check('kyc_requirements_evidence_key_check', sql`${t.evidenceKey} ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ]
);

/**
 * What a level allows, per currency (spec 6.13 "low", "standard", "high" limits). `approved`
 * rows are applied when a merchant is approved at the level; an `expired` row, where one
 * exists, is applied when that level's KYC expires. The spec defines no consequence of
 * expiry, so none is seeded.
 */
export const kycLevelLimits = core.table(
  'kyc_level_limits',
  {
    level: smallint('level').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    appliesWhen: text('applies_when').notNull().default('approved'),
    perTxnMaxMinor: bigint('per_txn_max_minor', { mode: 'bigint' }).notNull(),
    dailyVolumeMaxMinor: bigint('daily_volume_max_minor', { mode: 'bigint' }).notNull(),
    monthlyVolumeMaxMinor: bigint('monthly_volume_max_minor', { mode: 'bigint' }).notNull(),
    payoutPerTxnMaxMinor: bigint('payout_per_txn_max_minor', { mode: 'bigint' }).notNull(),
    dailyPayoutMaxMinor: bigint('daily_payout_max_minor', { mode: 'bigint' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.level, t.currency, t.appliesWhen] }),
    check('kyc_level_limits_level_check', sql`${t.level} between 1 and 3`),
    check('kyc_level_limits_applies_check', sql`${t.appliesWhen} in ('approved', 'expired')`),
    check(
      'kyc_level_limits_amounts_check',
      sql`${t.perTxnMaxMinor} > 0 and ${t.dailyVolumeMaxMinor} >= ${t.perTxnMaxMinor}
        and ${t.monthlyVolumeMaxMinor} >= ${t.dailyVolumeMaxMinor}
        and ${t.payoutPerTxnMaxMinor} > 0 and ${t.dailyPayoutMaxMinor} >= ${t.payoutPerTxnMaxMinor}`
    ),
  ]
);

/** What a merchant may do in live mode, per currency (spec 5.2). Test mode has no limits. */
export const merchantLimits = core.table(
  'merchant_limits',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    perTxnMaxMinor: bigint('per_txn_max_minor', { mode: 'bigint' }).notNull(),
    dailyVolumeMaxMinor: bigint('daily_volume_max_minor', { mode: 'bigint' }).notNull(),
    monthlyVolumeMaxMinor: bigint('monthly_volume_max_minor', { mode: 'bigint' }).notNull(),
    payoutPerTxnMaxMinor: bigint('payout_per_txn_max_minor', { mode: 'bigint' }).notNull(),
    dailyPayoutMaxMinor: bigint('daily_payout_max_minor', { mode: 'bigint' }).notNull(),
    /** `kyc` when copied from `kyc_level_limits`, `manual` when set by staff. */
    source: text('source').notNull().default('kyc'),
    kycLevel: smallint('kyc_level'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.merchantId, t.currency] }),
    check('merchant_limits_source_check', sql`${t.source} in ('kyc', 'manual')`),
    check(
      'merchant_limits_amounts_check',
      sql`${t.perTxnMaxMinor} > 0 and ${t.dailyVolumeMaxMinor} >= ${t.perTxnMaxMinor}
        and ${t.monthlyVolumeMaxMinor} >= ${t.dailyVolumeMaxMinor}
        and ${t.payoutPerTxnMaxMinor} > 0 and ${t.dailyPayoutMaxMinor} >= ${t.payoutPerTxnMaxMinor}`
    ),
  ]
);

export const kycProfiles = core.table(
  'kyc_profiles',
  {
    id: uuid('id').primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** The level being applied for (or last approved at, once approved). */
    level: smallint('level').notNull(),
    status: text('status').notNull().default('not_started'),
    /** Counts submissions, so screenings and reviews can be tied to one of them. */
    submissionNo: integer('submission_no').notNull().default(0),
    /** True when the current submission renews an approved or expired level. */
    isReverification: boolean('is_reverification').notNull().default(false),
    submittedAt: timestamptz('submitted_at'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamptz('reviewed_at'),
    /** Reason codes from the catalogue; the merchant acts on these. */
    rejectionReasons: text('rejection_reasons').array(),
    rejectionDetails: jsonb('rejection_details').$type<unknown[]>(),
    infoRequestedAt: timestamptz('info_requested_at'),
    infoRequestNote: text('info_request_note'),
    expiresAt: timestamptz('expires_at'),
    nextReviewAt: timestamptz('next_review_at'),
    reverificationNotifiedAt: timestamptz('reverification_notified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('kyc_profiles_merchant_key').on(t.merchantId),
    index('kyc_profiles_queue_idx')
      .on(t.status, t.submittedAt)
      .where(sql`${t.status} in ('pending', 'in_review')`),
    index('kyc_profiles_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'approved'`),
    index('kyc_profiles_review_due_idx')
      .on(t.nextReviewAt)
      .where(sql`${t.status} = 'approved' and ${t.reverificationNotifiedAt} is null`),
    check('kyc_profiles_level_check', sql`${t.level} between 0 and 3`),
    check('kyc_profiles_status_check', sql`${t.status} in (${list(KYC_STATUSES)})`),
    check(
      'kyc_profiles_reasons_check',
      sql`(${t.status} = 'rejected') = (${t.rejectionReasons} is not null and cardinality(${t.rejectionReasons}) > 0)`
    ),
    check(
      'kyc_profiles_approved_check',
      sql`${t.status} <> 'approved' or (${t.expiresAt} is not null and ${t.reviewedBy} is not null and ${t.reviewedAt} is not null)`
    ),
  ]
);

export const kycDocuments = core.table(
  'kyc_documents',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    kycProfileId: uuid('kyc_profile_id')
      .notNull()
      .references(() => kycProfiles.id),
    /** A document type code, normally a `document` requirement's `evidence_key`, or `other`. */
    type: text('type').notNull(),
    fileKey: text('file_key').notNull(),
    /** Hex SHA-256 of the file, verified by the store at upload. */
    fileHash: char('file_hash', { length: 64 }).notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('uploaded'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamptz('uploaded_at').notNull(),
    verifiedBy: uuid('verified_by').references(() => users.id),
    verifiedAt: timestamptz('verified_at'),
    /** A reason code from the catalogue when `status = rejected`. */
    rejectionReason: text('rejection_reason'),
    rejectionNote: text('rejection_note'),
    /** When the document itself expires (an ID card, a licence). */
    expiresAt: timestamptz('expires_at'),
    /** Free-form, bounded: file name, issuing country, document number last 4. */
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    /** Which submission it was uploaded for. */
    submissionNo: integer('submission_no').notNull().default(0),
    removedAt: timestamptz('removed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('kyc_documents_ref_key').on(t.ref),
    uniqueIndex('kyc_documents_file_key_key').on(t.fileKey),
    index('kyc_documents_profile_idx').on(t.kycProfileId, t.createdAt),
    index('kyc_documents_merchant_idx').on(t.merchantId, t.status),
    check('kyc_documents_ref_check', sql`${t.ref} ~ '^kdoc_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('kyc_documents_status_check', sql`${t.status} in ('uploaded', 'verified', 'rejected')`),
    check('kyc_documents_type_check', sql`${t.type} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check(
      'kyc_documents_mime_check',
      sql`${t.mime} in ('application/pdf', 'image/jpeg', 'image/png')`
    ),
    check('kyc_documents_size_check', sql`${t.sizeBytes} between 1 and 10485760`),
    check('kyc_documents_hash_check', sql`${t.fileHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'kyc_documents_review_check',
      sql`(${t.status} = 'uploaded') = (${t.verifiedBy} is null)
        and (${t.status} = 'uploaded') = (${t.verifiedAt} is null)
        and (${t.status} = 'rejected') = (${t.rejectionReason} is not null)`
    ),
  ]
);

export const kycVerifications = core.table(
  'kyc_verifications',
  {
    id: uuid('id').primaryKey(),
    kycProfileId: uuid('kyc_profile_id')
      .notNull()
      .references(() => kycProfiles.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    checkType: text('check_type').notNull(),
    /** `manual` for a staff decision, otherwise the provider's name. */
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    submissionNo: integer('submission_no').notNull(),
    performedBy: uuid('performed_by').references(() => users.id),
    performedAt: timestamptz('performed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('kyc_verifications_profile_idx').on(t.kycProfileId, t.checkType, t.performedAt),
    check('kyc_verifications_check_type_check', sql`${t.checkType} in (${list(KYC_CHECK_TYPES)})`),
    check('kyc_verifications_status_check', sql`${t.status} in ('passed', 'failed', 'pending')`),
  ]
);

/** Directors and ultimate beneficial owners (spec 6.13, level 3). Personal data is encrypted. */
export const kycParties = core.table(
  'kyc_parties',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    kind: text('kind').notNull(),
    fullNameEnc: text('full_name_enc').notNull(),
    dateOfBirthEnc: text('date_of_birth_enc'),
    nationality: char('nationality', { length: 2 }),
    idNumberEnc: text('id_number_enc'),
    idNumberHmac: text('id_number_hmac'),
    /** Share of the business, in basis points, for a UBO. */
    ownershipBps: integer('ownership_bps'),
    status: text('status').notNull().default('active'),
    removedAt: timestamptz('removed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('kyc_parties_ref_key').on(t.ref),
    index('kyc_parties_merchant_idx').on(t.merchantId, t.status),
    check('kyc_parties_ref_check', sql`${t.ref} ~ '^kpty_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('kyc_parties_kind_check', sql`${t.kind} in ('director', 'ubo')`),
    check('kyc_parties_status_check', sql`${t.status} in ('active', 'removed')`),
    check(
      'kyc_parties_removed_check',
      sql`(${t.status} = 'removed') = (${t.removedAt} is not null)`
    ),
    check(
      'kyc_parties_ownership_check',
      sql`${t.ownershipBps} is null or (${t.kind} = 'ubo' and ${t.ownershipBps} between 1 and 10000)`
    ),
    check(
      'kyc_parties_nationality_check',
      sql`${t.nationality} is null or ${t.nationality} ~ '^[A-Z]{2}$'`
    ),
  ]
);

/** Append-only record of every KYC decision and milestone. */
export const kycReviews = core.table(
  'kyc_reviews',
  {
    id: uuid('id').primaryKey(),
    kycProfileId: uuid('kyc_profile_id')
      .notNull()
      .references(() => kycProfiles.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    submissionNo: integer('submission_no').notNull(),
    decision: text('decision').notNull(),
    level: smallint('level').notNull(),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    reasons: text('reasons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    details: jsonb('details').$type<unknown[]>().notNull().default([]),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('kyc_reviews_profile_idx').on(t.kycProfileId, t.createdAt),
    check(
      'kyc_reviews_decision_check',
      sql`${t.decision} in ('submitted', 'approved', 'rejected', 'info_requested', 'expired', 'reverification_due')`
    ),
  ]
);
