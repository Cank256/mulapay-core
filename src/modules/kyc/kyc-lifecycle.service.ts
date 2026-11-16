/**
 * KYC expiry and re-verification (spec 6.13): "expiry schedules a re-verification notice 30
 * days ahead".
 *
 * A scheduled sweep (`aml-screen` queue, every hour) does two things, each per profile in its
 * own transaction under the profile's row lock, so a duplicate tick or two workers produce
 * one effect:
 *  - Notice. An approved profile whose `next_review_at` has passed, and that has not been
 *    notified, gets a `kyc.reverification_due` event (merchant webhook) and a review-log
 *    entry, and from then on the merchant may submit a renewal.
 *  - Expiry. An approved profile past `expires_at` becomes `expired`. The merchant's status
 *    is not changed: the spec defines no suspension for expiry. Limit consequences are data:
 *    if `kyc_level_limits` has an `expired` row for the merchant's level it is applied, and
 *    the renewal's approval restores the `approved` limits. Nothing is seeded.
 *
 * Every step is audited, with the job as the actor.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { kycDecisionsTotal } from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { MerchantLimitsService } from '../aml/limits/merchant-limits.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { KycProfilesRepository } from './kyc-profiles.repository';

const BATCH = 200;
const JOB_ACTOR = { type: 'job' as const, id: 'kyc-lifecycle', label: 'KYC expiry sweep' };

@Injectable()
export class KycLifecycleService {
  constructor(
    private readonly profiles: KycProfilesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly limits: MerchantLimitsService,
    private readonly events: MerchantEventsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async sweep(): Promise<{ notified: number; expired: number; failed: number }> {
    const now = this.clock.now();
    let notified = 0;
    let expired = 0;
    let failed = 0;
    for (const due of await this.profiles.dueForNotice(now, BATCH)) {
      try {
        if (await this.notify(due.id)) notified += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: toLoggableError(error), profileId: due.id }, 'kyc notice failed');
      }
    }
    for (const due of await this.profiles.dueForExpiry(now, BATCH)) {
      try {
        if (await this.expire(due.id)) expired += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: toLoggableError(error), profileId: due.id }, 'kyc expiry failed');
      }
    }
    return { notified, expired, failed };
  }

  private async notify(profileId: string): Promise<boolean> {
    return this.unitOfWork.run(async (tx) => {
      const profile = await this.profiles.lockById(tx, profileId);
      const now = this.clock.now();
      if (
        !profile ||
        profile.status !== 'approved' ||
        !profile.nextReviewAt ||
        profile.nextReviewAt > now ||
        profile.reverificationNotifiedAt !== null
      ) {
        return false;
      }
      const merchant = await this.merchants.findById(profile.merchantId, tx);
      if (!merchant) return false;
      await this.profiles.update(tx, profile.id, { reverificationNotifiedAt: now });
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo: profile.submissionNo,
        decision: 'reverification_due',
        level: profile.level,
      });
      await this.events.emit(tx, {
        merchantId: merchant.id,
        environment: 'live',
        type: 'kyc.reverification_due',
        resourceType: 'kyc',
        resourceId: merchant.ref,
        object: {
          id: merchant.ref,
          level: profile.level,
          expiresAt: profile.expiresAt?.toISOString() ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'kyc.reverification_due',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        after: { expiresAt: profile.expiresAt?.toISOString() ?? null },
        actor: JOB_ACTOR,
      });
      return true;
    });
  }

  private async expire(profileId: string): Promise<boolean> {
    const merchantId = await this.unitOfWork.run(async (tx) => {
      const found = await this.profiles.findById(profileId, tx);
      if (!found) return null;
      const merchant = await this.merchants.lockById(tx, found.merchantId);
      const profile = await this.profiles.lockById(tx, profileId);
      const now = this.clock.now();
      if (
        !merchant ||
        !profile ||
        profile.status !== 'approved' ||
        !profile.expiresAt ||
        profile.expiresAt > now
      ) {
        return null;
      }
      await this.profiles.update(tx, profile.id, { status: 'expired' });
      await this.profiles.insertReview(tx, {
        id: uuidv7(now),
        kycProfileId: profile.id,
        merchantId: merchant.id,
        submissionNo: profile.submissionNo,
        decision: 'expired',
        level: profile.level,
      });
      const limitsChanged = await this.limits.applyLevel(
        tx,
        merchant.id,
        merchant.kycLevel,
        'expired'
      );
      await this.events.emit(tx, {
        merchantId: merchant.id,
        environment: 'live',
        type: 'kyc.expired',
        resourceType: 'kyc',
        resourceId: merchant.ref,
        object: { id: merchant.ref, level: profile.level },
      });
      await this.audit.record(tx, {
        action: 'kyc.expired',
        resourceType: 'kyc_profile',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { status: 'approved' },
        after: { status: 'expired', level: merchant.kycLevel, limitsChanged },
        actor: JOB_ACTOR,
      });
      kycDecisionsTotal.inc({ decision: 'expired' });
      return merchant.id;
    });
    if (merchantId === null) return false;
    await this.limits.invalidate(merchantId).catch(() => undefined);
    return true;
  }
}
