/**
 * STR package export (spec 6.13): "cases ... can export an STR package as a report".
 *
 * The package is one JSON document: the case, its notes and history of alerts, the merchant
 * and its directors and UBOs, the transactions the alerts concern and the screening results.
 * It is stored in the reports bucket and handed out through a short-lived presigned URL, as
 * every generated report is (spec 6.12), and its SHA-256 is recorded so the file filed with
 * the authority can be proven to be the file core generated.
 *
 * Invariants upheld:
 *  - Reads only. Exporting changes no case, alert, transaction or ledger entry.
 *  - The file is written to storage before the database row that names it, so a package row
 *    never points at a file that does not exist; a crash in between leaves an unreferenced
 *    file, never a dangling row.
 *  - Personal data in the package (names of directors and UBOs) is decrypted only here, for
 *    this purpose; ID numbers and the TIN appear as their last four characters. The file is
 *    encrypted at rest by the bucket and every export is audited by who, which case, which
 *    file, and its hash.
 *  - Each export is a new, numbered package; earlier ones stay.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { canonicalJson } from '../../../common/idempotency/canonical-json';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import { APP_CONFIG, CLOCK } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import {
  OBJECT_STORAGE,
  StorageUnavailableError,
  type ObjectStorage,
  type PresignedGet,
} from '../../../integrations/storage/object-storage.port';
import { MerchantsRepository } from '../../merchants/merchants.repository';
import { AmlCasesRepository, type StrPackageRow } from './aml-cases.repository';
import { AmlCasesService } from './aml-cases.service';
import { AmlStrDataRepository } from './aml-str-data.repository';

const PACKAGE_SCHEMA = 'mulapay.str/1';

export interface StrExport {
  readonly package: StrPackageRow;
  readonly download: PresignedGet;
}

function last4(value: string | null): string | null {
  return value && value.length >= 4 ? `…${value.slice(-4)}` : value;
}

@Injectable()
export class AmlStrExportService {
  constructor(
    private readonly caseService: AmlCasesService,
    private readonly cases: AmlCasesRepository,
    private readonly data: AmlStrDataRepository,
    private readonly merchants: MerchantsRepository,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async generate(caseRef: string, actorUserId: string): Promise<StrExport> {
    if (!this.storage.configured) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('object storage is not configured; STR packages cannot be stored'),
      });
    }
    const detail = await this.caseService.get(caseRef);
    const merchant = await this.merchants.findById(detail.row.merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    const [profile, parties, screenings] = await Promise.all([
      this.data.profile(merchant.id),
      this.data.parties(merchant.id),
      this.data.screenings(merchant.id),
    ]);
    const transactionIds = [
      ...new Set(detail.alerts.flatMap((a) => (a.transactionId ? [a.transactionId] : []))),
    ];
    const transactions = await this.data.transactions(transactionIds);
    const refByTransaction = new Map(transactions.map((t) => [t.id, t.ref]));
    const now = this.clock.now();
    const content = {
      schema: PACKAGE_SCHEMA,
      generatedAt: now.toISOString(),
      case: {
        ref: detail.row.ref,
        title: detail.row.title,
        summary: detail.row.summary,
        severity: detail.row.severity,
        status: detail.row.status,
        outcome: detail.row.outcome,
        source: detail.row.source,
        openedAt: detail.row.createdAt.toISOString(),
        closedAt: detail.row.closedAt?.toISOString() ?? null,
        strReference: detail.row.strReference,
      },
      merchant: {
        ref: merchant.ref,
        legalName: merchant.legalName,
        tradingName: merchant.tradingName,
        country: merchant.country,
        status: merchant.status,
        kycLevel: merchant.kycLevel,
        registrationNumber: profile?.registrationNumber ?? null,
        tin: last4(
          profile?.tinEnc
            ? this.decrypt(profile.tinEnc, `merchant_profiles.tin:${merchant.id}`)
            : null
        ),
        businessType: profile?.businessType ?? null,
        createdAt: merchant.createdAt.toISOString(),
      },
      parties: parties
        .filter((p) => p.status === 'active')
        .map((p) => ({
          ref: p.ref,
          kind: p.kind,
          fullName: this.decrypt(p.fullNameEnc, `kyc_parties.full_name:${p.ref}`),
          nationality: p.nationality,
          ownershipBps: p.ownershipBps,
          idNumber: last4(
            p.idNumberEnc ? this.decrypt(p.idNumberEnc, `kyc_parties.id_number:${p.ref}`) : null
          ),
        })),
      alerts: detail.alerts.map((a) => ({
        ref: a.ref,
        rule: a.ruleCode,
        ruleVersion: a.ruleVersion,
        severity: a.severity,
        score: a.score,
        status: a.status,
        action: a.action,
        details: a.details,
        transaction: a.transactionId ? (refByTransaction.get(a.transactionId) ?? null) : null,
        raisedAt: a.createdAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        resolutionNote: a.resolutionNote,
      })),
      transactions: transactions.map(({ id: _id, ...visible }) => visible),
      screenings: screenings.map((s) => ({
        ref: s.ref,
        subjectType: s.subjectType,
        subject: s.subjectId,
        status: s.status,
        lists: s.lists,
        highestScore: s.highestScore,
        hits: s.result.hits ?? [],
        screenedAt: s.screenedAt.toISOString(),
        reviewNote: s.reviewNote,
      })),
      notes: detail.notes.map((n) => ({ at: n.createdAt.toISOString(), body: n.body })),
    };
    const bytes = Buffer.from(canonicalJson(content), 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const strRef = publicId('strPackage', now);
    const fileKey = `str/${detail.row.ref}/${strRef}.json`;
    try {
      await this.storage.put('reports', fileKey, bytes, 'application/json');
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
      }
      throw error;
    }
    const row = await this.unitOfWork.run(async (tx) => {
      const inserted = await this.cases.insertStrPackage(tx, {
        id: uuidv7(now),
        ref: strRef,
        caseId: detail.row.id,
        fileKey,
        fileHash: hash,
        sizeBytes: bytes.length,
        alertCount: detail.alerts.length,
        generatedBy: actorUserId,
      });
      await this.audit.record(tx, {
        action: 'aml.case.str_generated',
        resourceType: 'aml_case',
        resourceId: detail.row.ref,
        merchantId: detail.row.merchantId,
        after: {
          package: inserted.ref,
          sha256: hash,
          sizeBytes: bytes.length,
          alerts: detail.alerts.length,
        },
      });
      return inserted;
    });
    return {
      package: row,
      download: this.storage.presignGet({
        bucket: 'reports',
        key: fileKey,
        ttlSeconds: Math.min(this.config.PRESIGN_DOWNLOAD_TTL_SECONDS, 900),
        downloadFilename: `${strRef}.json`,
      }),
    };
  }

  private decrypt(value: string, context: string): string {
    return this.encryption.decrypt(value, context);
  }
}
