/**
 * Sanctions and PEP screening (spec 6.13 step 1): the merchant, its directors and its UBOs.
 *
 * Invariants upheld:
 *  - The provider is called outside any database transaction, and its answer is recorded in
 *    one short transaction afterwards. A provider that does not answer records nothing and
 *    throws, so the job retries; "no answer" is never "clear".
 *  - A screening is recorded once per dedupe key, so a retried job, or the same job running
 *    on two workers, produces one result.
 *  - What the provider reported is stored as received (ids, captions, scores, datasets) and
 *    never changes. Only a `potential_match` can be decided afterwards, once, by an analyst:
 *    `clear` (a false positive) or `confirmed_match`.
 *  - A confirmed match, whether the score confirmed it or an analyst did, opens an AML case
 *    and writes an audit row in the same transaction as the screening or the decision. Both
 *    a potential and a confirmed match stop the merchant being activated (`KycReviewService`
 *    checks the latest screenings of the submission).
 *  - The name that was screened is not stored: the row names the subject by its ref.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import type { Executor } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import { amlScreeningsTotal } from '../../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import {
  SANCTIONS_SCREENING,
  type SanctionsScreening,
  type ScreeningQuery,
} from '../../../integrations/sanctions/sanctions-screening.port';
import { AmlCasesService } from '../cases/aml-cases.service';
import { classifyScreening } from '../domain/screening-classification';
import { AmlScreeningsRepository, type ScreeningRow } from './aml-screenings.repository';

export type SubjectType = 'merchant' | 'director' | 'ubo' | 'customer' | 'counterparty';

export interface ScreenSubjectInput {
  readonly subjectType: SubjectType;
  /** A merchant ref or a party ref: whatever names the subject without naming the person. */
  readonly subjectId: string;
  readonly merchantId: string | null;
  readonly merchantRef: string | null;
  readonly query: ScreeningQuery;
  /** One screening per key. */
  readonly dedupeKey: string;
  readonly kycProfileId?: string;
  readonly submissionNo?: number;
  /** The user who asked, for an ad-hoc screening. Absent for the system. */
  readonly requestedBy?: string;
}

function refuse(reason: string): AppError {
  return new AppError('AML_TRANSITION_INVALID', { messageParams: { reason }, details: { reason } });
}

@Injectable()
export class AmlScreeningService {
  constructor(
    private readonly screenings: AmlScreeningsRepository,
    private readonly cases: AmlCasesService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(SANCTIONS_SCREENING) private readonly provider: SanctionsScreening,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Screens one subject and records the result. Returns the existing result for a dedupe key
   * that was used before, without calling the provider again.
   */
  async screen(input: ScreenSubjectInput): Promise<ScreeningRow> {
    const existing = await this.screenings.findByDedupeKey(input.dedupeKey);
    if (existing) return existing;
    const outcome = await this.provider.screen(input.query);
    const result = classifyScreening(outcome.hits, {
      review: this.config.AML_SCREENING_REVIEW_SCORE,
      confirm: this.config.AML_SCREENING_CONFIRM_SCORE,
    });
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const inserted = await this.screenings.insert(tx, {
        id: uuidv7(now),
        ref: publicId('screening', now),
        merchantId: input.merchantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        dedupeKey: input.dedupeKey,
        kycProfileId: input.kycProfileId ?? null,
        submissionNo: input.submissionNo ?? null,
        provider: outcome.provider,
        lists: result.lists,
        hitCount: result.hitCount,
        highestScore: result.highestScore,
        result: {
          hits: result.hits.map((h) => ({
            entityId: h.entityId,
            caption: h.caption,
            score: h.score,
            categories: h.categories,
            datasets: h.datasets,
          })),
        },
        status: result.status,
        screenedAt: now,
      });
      if (!inserted) {
        const winner = await this.screenings.findByDedupeKey(input.dedupeKey, tx);
        if (!winner) throw new Error('screening conflict without a screening');
        return winner;
      }
      amlScreeningsTotal.inc({ subject_type: input.subjectType, status: result.status });
      await this.audit.record(tx, {
        action: 'aml.screening.completed',
        resourceType: 'aml_screening',
        resourceId: inserted.ref,
        merchantId: input.merchantId,
        after: {
          subjectType: input.subjectType,
          subject: input.subjectId,
          status: result.status,
          hits: result.hitCount,
          highestScore: result.highestScore,
          lists: result.lists,
          provider: outcome.provider,
        },
        ...(input.requestedBy
          ? {}
          : { actor: { type: 'job' as const, id: 'aml-screening', label: 'AML screening' } }),
      });
      if (result.status === 'confirmed_match') {
        await this.openCaseFor(tx, inserted, input.merchantId);
        return (await this.screenings.findByRef(inserted.ref, tx)) ?? inserted;
      }
      return inserted;
    });
  }

  /** An analyst decides a potential match: a false positive (`clear`) or a real match (`confirm`). */
  async decide(
    ref: string,
    decision: 'clear' | 'confirm',
    note: string,
    reviewerUserId: string
  ): Promise<ScreeningRow> {
    return this.unitOfWork.run(async (tx) => {
      const current = await this.screenings.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (current.status !== 'potential_match') throw refuse('screening_decided');
      const status = decision === 'clear' ? 'clear' : 'confirmed_match';
      const updated = await this.screenings.decide(tx, current.id, {
        status,
        reviewedBy: reviewerUserId,
        reviewedAt: this.clock.now(),
        reviewNote: note,
      });
      await this.audit.record(tx, {
        action: 'aml.screening.decided',
        resourceType: 'aml_screening',
        resourceId: updated.ref,
        merchantId: updated.merchantId,
        before: { status: current.status },
        after: { status: updated.status, noteLength: note.length },
      });
      if (status === 'confirmed_match') {
        await this.openCaseFor(tx, updated, updated.merchantId);
        return (await this.screenings.findByRef(updated.ref, tx)) ?? updated;
      }
      return updated;
    });
  }

  /** The screenings of one KYC submission. */
  forSubmission(
    kycProfileId: string,
    submissionNo: number,
    tx?: Executor
  ): Promise<ScreeningRow[]> {
    return this.screenings.forSubmission(kycProfileId, submissionNo, tx);
  }

  async get(ref: string): Promise<ScreeningRow> {
    const row = await this.screenings.findByRef(ref);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  async list(query: {
    status?: string;
    merchantId?: string;
    subjectType?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ScreeningRow>> {
    const fingerprint = filterFingerprint({
      status: query.status,
      merchant: query.merchantId,
      subject: query.subjectType,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.screenings.list({ ...query, after });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.screenedAt, id: r.ref }));
  }

  private async openCaseFor(
    tx: Parameters<AmlCasesService['openInTx']>[0],
    screening: ScreeningRow,
    merchantId: string | null
  ): Promise<void> {
    if (!merchantId) return;
    const opened = await this.cases.openInTx(tx, {
      merchantId,
      severity: 'critical',
      title: `Confirmed ${screening.lists.join(' and ') || 'screening'} match (${screening.subjectType})`,
      summary: `Screening ${screening.ref} of ${screening.subjectType} ${screening.subjectId} matched at score ${screening.highestScore ?? 'n/a'}. Activation is blocked until the case is resolved.`,
      source: 'screening',
    });
    await this.screenings.attachCase(tx, screening.id, opened.id);
  }
}
