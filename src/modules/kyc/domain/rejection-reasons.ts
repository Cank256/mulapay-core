/**
 * Structured rejection reasons (spec 6.13): the merchant gets codes it can act on, each
 * optionally pointing at the document, party or requirement the problem is about. The
 * catalogue is closed, so a dashboard can map every code to guidance and a rejection never
 * carries free-text from a reviewer except in the note.
 */
export const DOCUMENT_REJECTION_REASONS = [
  'illegible',
  'expired',
  'wrong_document_type',
  'name_mismatch',
  'incomplete',
  'suspected_tampering',
  'low_quality',
] as const;
export type DocumentRejectionReason = (typeof DOCUMENT_REJECTION_REASONS)[number];

export const KYC_REJECTION_REASONS = [
  ...DOCUMENT_REJECTION_REASONS,
  'information_mismatch',
  'business_not_verified',
  'address_not_verified',
  'contact_not_verified',
  'bank_account_not_verified',
  'party_not_verified',
  'source_of_funds_unclear',
  'other',
] as const;
export type KycRejectionReason = (typeof KYC_REJECTION_REASONS)[number];

export interface RejectionDetail {
  readonly code: KycRejectionReason;
  /** What it is about: a document ref, a party ref or a requirement code. */
  readonly target?: string;
  readonly note?: string;
}

export function isKycRejectionReason(value: string): value is KycRejectionReason {
  return (KYC_REJECTION_REASONS as readonly string[]).includes(value);
}

export function isDocumentRejectionReason(value: string): value is DocumentRejectionReason {
  return (DOCUMENT_REJECTION_REASONS as readonly string[]).includes(value);
}

/** The distinct codes of `details`, in first-seen order: what is stored in `rejection_reasons`. */
export function reasonCodes(details: readonly RejectionDetail[]): KycRejectionReason[] {
  return [...new Set(details.map((d) => d.code))];
}
