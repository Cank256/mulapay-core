/**
 * KYC documents (spec 6.13): direct upload to object storage, validation by magic bytes,
 * review by staff, and audited viewing.
 *
 * Flow. `presign` returns a presigned PUT for an object key core chooses
 * (`kyc/{merchantId}/{documentId}`). The merchant uploads straight to the store; core never
 * carries the file. The presigned request fixes the content type, the exact length and the
 * SHA-256, so the store itself refuses an upload that differs. `confirm` then checks the
 * object: it exists, has the declared size and the checksum the store verified, and starts
 * with the signature of a PDF, JPEG or PNG that agrees with the declared type. Core reads the
 * first 16 bytes for that and nothing else. Only then is a row written.
 *
 * Invariants upheld:
 *  - The file type is decided by the bytes, never by the extension or the label. A file that
 *    fails is deleted from the store and no row is written.
 *  - The row stores the key, hash, type and size; the bytes are never in the database.
 *  - A document belongs to one merchant; another merchant's id is "not found". The key
 *    includes the merchant id, so one merchant cannot confirm another's object.
 *  - Reading a document is audited before the link exists: if the audit row cannot be
 *    written, no link is issued. The link lasts at most five minutes.
 *  - A reviewed document is final. Reviewing needs a submission that is waiting for review.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { ulid, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import {
  OBJECT_STORAGE,
  StorageUnavailableError,
  type ObjectStorage,
  type PresignedGet,
  type PresignedPut,
} from '../../integrations/storage/object-storage.port';
import { MerchantsRepository } from '../merchants/merchants.repository';
import {
  checkSignature,
  isAllowedDocumentType,
  MAX_DOCUMENT_BYTES,
  SIGNATURE_BYTES,
} from './domain/file-signature';
import { isDocumentRejectionReason } from './domain/rejection-reasons';
import { isReviewable } from './domain/kyc-state';
import { KycDocumentsRepository, type DocumentRow } from './kyc-documents.repository';
import { KycProfilesRepository } from './kyc-profiles.repository';
import { KycRequirementsService } from './kyc-requirements.service';
import { KycStatusService } from './kyc-status.service';

const DOCUMENT_ID = /^kdoc_[0-9A-HJKMNP-TV-Z]{26}$/;
const VIEW_TTL_CAP_SECONDS = 300;
const GENERIC_TYPE = 'other';

export interface PresignInput {
  readonly type: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Hex SHA-256 of the file. */
  readonly sha256: string;
}

export interface ConfirmInput extends PresignInput {
  readonly documentId: string;
  readonly expiresAt?: Date;
  readonly metadata?: Record<string, string>;
}

export interface ReviewInput {
  readonly decision: 'verify' | 'reject';
  readonly reason?: string;
  readonly note?: string;
  readonly expiresAt?: Date | null;
}

function invalid(reason: string): AppError {
  return new AppError('KYC_DOCUMENT_INVALID', { messageParams: { reason }, details: { reason } });
}

function notAllowed(reason: string): AppError {
  return new AppError('KYC_NOT_ALLOWED', { messageParams: { reason }, details: { reason } });
}

export const documentKey = (merchantId: string, documentId: string) =>
  `kyc/${merchantId}/${documentId}`;

@Injectable()
export class KycDocumentsService {
  constructor(
    private readonly documents: KycDocumentsRepository,
    private readonly profiles: KycProfilesRepository,
    private readonly requirements: KycRequirementsService,
    private readonly status: KycStatusService,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** A presigned upload for one file. Writes nothing: the document exists once it is confirmed. */
  async presign(
    scope: MerchantScope,
    input: PresignInput
  ): Promise<{ documentId: string; upload: PresignedPut }> {
    await this.assertDeclaration(input);
    this.assertStorage();
    const documentId = `kdoc_${ulid(this.clock.now())}`;
    return {
      documentId,
      upload: this.storage.presignPut({
        bucket: 'documents',
        key: documentKey(scope.merchantId, documentId),
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        sha256Hex: input.sha256,
        ttlSeconds: this.config.PRESIGN_UPLOAD_TTL_SECONDS,
      }),
    };
  }

  /** Verifies the uploaded object and records the document. Repeating a confirmation returns the same document. */
  async confirm(scope: MerchantScope, userId: string, input: ConfirmInput): Promise<DocumentRow> {
    if (!DOCUMENT_ID.test(input.documentId)) throw invalid('document_id');
    await this.assertDeclaration(input);
    this.assertStorage();
    const key = documentKey(scope.merchantId, input.documentId);
    const known = await this.documents.findByFileKey(key);
    if (known) {
      if (known.fileHash !== input.sha256) throw invalid('document_id_in_use');
      return known;
    }
    const stored = await this.read(() => this.storage.head('documents', key));
    if (!stored) throw invalid('upload_not_found');
    const refusal = await this.inspect(key, input, stored);
    if (refusal) {
      await this.discard(key);
      throw invalid(refusal);
    }
    return this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, scope.merchantId);
      if (
        profile.status === 'pending' ||
        (profile.status === 'in_review' && !profile.infoRequestedAt)
      ) {
        throw notAllowed('under_review');
      }
      const now = this.clock.now();
      const row = await this.documents.insert(tx, {
        id: uuidv7(now),
        ref: input.documentId,
        merchantId: scope.merchantId,
        kycProfileId: profile.id,
        type: input.type,
        fileKey: key,
        fileHash: input.sha256,
        mime: input.contentType,
        sizeBytes: input.sizeBytes,
        uploadedBy: userId,
        uploadedAt: now,
        expiresAt: input.expiresAt ?? null,
        metadata: input.metadata ?? {},
        submissionNo: profile.submissionNo,
      });
      if (!row) {
        const winner = await this.documents.findByFileKey(key, tx);
        if (!winner) throw new Error('document conflict without a document');
        return winner;
      }
      await this.audit.record(tx, {
        action: 'kyc.document.uploaded',
        resourceType: 'kyc_document',
        resourceId: row.ref,
        merchantId: scope.merchantId,
        after: { type: row.type, mime: row.mime, sizeBytes: row.sizeBytes, sha256: row.fileHash },
      });
      return row;
    });
  }

  async remove(scope: MerchantScope, ref: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, scope.merchantId);
      const doc = await this.documents.lockForMerchant(tx, scope.merchantId, ref);
      if (!doc || doc.removedAt) throw new AppError('NOT_FOUND');
      if (doc.status === 'verified') throw notAllowed('document_verified');
      if (
        profile.status === 'pending' ||
        (profile.status === 'in_review' && !profile.infoRequestedAt)
      ) {
        throw notAllowed('under_review');
      }
      await this.documents.markRemoved(tx, doc.id, this.clock.now());
      await this.audit.record(tx, {
        action: 'kyc.document.removed',
        resourceType: 'kyc_document',
        resourceId: doc.ref,
        merchantId: scope.merchantId,
        before: { type: doc.type, status: doc.status },
      });
    });
  }

  /**
   * A short-lived link to read a document, for staff. The audit row is written first and in
   * its own transaction: no row, no link.
   */
  async view(
    merchantRef: string,
    ref: string
  ): Promise<{ url: PresignedGet; document: DocumentRow }> {
    this.assertStorage();
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    const doc = await this.documents.findForMerchant(merchant.id, ref);
    if (!doc || doc.removedAt) throw new AppError('NOT_FOUND');
    const ttlSeconds = Math.min(this.config.PRESIGN_DOWNLOAD_TTL_SECONDS, VIEW_TTL_CAP_SECONDS);
    await this.audit.recordStandalone({
      action: 'kyc.document.viewed',
      resourceType: 'kyc_document',
      resourceId: doc.ref,
      merchantId: merchant.id,
      after: { type: doc.type, status: doc.status, linkTtlSeconds: ttlSeconds },
    });
    return {
      document: doc,
      url: this.storage.presignGet({
        bucket: 'documents',
        key: doc.fileKey,
        ttlSeconds,
        downloadFilename: `${doc.ref}`,
      }),
    };
  }

  /** Staff verify or reject one document of a submission that is waiting for review. */
  async review(
    merchantRef: string,
    ref: string,
    input: ReviewInput,
    reviewerUserId: string
  ): Promise<DocumentRow> {
    if (input.decision === 'reject') {
      if (!input.reason || !isDocumentRejectionReason(input.reason)) {
        throw new AppError('VALIDATION_FAILED', {
          details: { fields: [{ path: 'reason', message: 'a rejection reason code is required' }] },
        });
      }
    }
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    return this.unitOfWork.run(async (tx) => {
      const profile = await this.status.ensureLocked(tx, merchant.id);
      if (!isReviewable(profile.status as Parameters<typeof isReviewable>[0])) {
        throw notAllowed('not_under_review');
      }
      const doc = await this.documents.lockForMerchant(tx, merchant.id, ref);
      if (!doc || doc.removedAt) throw new AppError('NOT_FOUND');
      if (doc.status !== 'uploaded') throw notAllowed('document_already_reviewed');
      const now = this.clock.now();
      const verified = input.decision === 'verify';
      const row = await this.documents.review(tx, doc.id, {
        status: verified ? 'verified' : 'rejected',
        verifiedBy: reviewerUserId,
        verifiedAt: now,
        rejectionReason: verified ? undefined : input.reason,
        rejectionNote: verified ? undefined : input.note,
        expiresAt: input.expiresAt,
      });
      await this.profiles.insertVerification(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        checkType: 'document',
        provider: 'manual',
        status: verified ? 'passed' : 'failed',
        result: {
          document: doc.ref,
          type: doc.type,
          ...(verified ? {} : { reason: input.reason }),
        },
        submissionNo: profile.submissionNo,
        performedBy: reviewerUserId,
        performedAt: now,
      });
      if (profile.status === 'pending') {
        await this.profiles.update(tx, profile.id, {
          status: 'in_review',
          reviewedBy: reviewerUserId,
        });
      }
      await this.audit.record(tx, {
        action: verified ? 'kyc.document.verified' : 'kyc.document.rejected',
        resourceType: 'kyc_document',
        resourceId: row.ref,
        merchantId: merchant.id,
        before: { status: doc.status },
        after: {
          status: row.status,
          type: row.type,
          ...(verified ? {} : { reason: row.rejectionReason }),
        },
      });
      return row;
    });
  }

  private async assertDeclaration(input: PresignInput): Promise<void> {
    if (!isAllowedDocumentType(input.contentType)) throw invalid('unsupported_file_type');
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) throw invalid('empty_file');
    if (input.sizeBytes > MAX_DOCUMENT_BYTES) throw invalid('file_too_large');
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw invalid('sha256');
    if (
      input.type !== GENERIC_TYPE &&
      !(await this.requirements.knownDocumentTypes()).has(input.type)
    ) {
      throw invalid('unknown_document_type');
    }
  }

  /** Null when the object is what was declared, otherwise the reason it is refused. */
  private async inspect(
    key: string,
    declared: PresignInput,
    stored: { sizeBytes: number; contentType: string | null; sha256Hex: string | null }
  ): Promise<string | null> {
    if (stored.sizeBytes !== declared.sizeBytes) return 'size_mismatch';
    if (stored.sizeBytes > MAX_DOCUMENT_BYTES) return 'file_too_large';
    if (stored.sha256Hex === null) return 'checksum_unverifiable';
    if (stored.sha256Hex !== declared.sha256) return 'checksum_mismatch';
    const head = await this.read(() =>
      this.storage.readRange('documents', key, 0, SIGNATURE_BYTES - 1)
    );
    if (!head) return 'upload_not_found';
    const verdict = checkSignature(
      head,
      declared.contentType as Parameters<typeof checkSignature>[1]
    );
    return verdict.ok ? null : verdict.reason;
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.remove('documents', key);
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error), key }, 'refused upload could not be deleted');
    }
  }

  private assertStorage(): void {
    if (!this.storage.configured) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('object storage is not configured'),
      });
    }
  }

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
      }
      throw error;
    }
  }
}
