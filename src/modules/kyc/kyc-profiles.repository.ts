/** SQL for `core.kyc_profiles`, the append-only `kyc_reviews` and `kyc_verifications`. */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { kycProfiles, kycReviews, kycVerifications, merchants } from '../../db/schema';

export type ProfileRow = typeof kycProfiles.$inferSelect;
export type NewProfile = typeof kycProfiles.$inferInsert;
export type ProfilePatch = Partial<
  Omit<NewProfile, 'id' | 'merchantId' | 'createdAt' | 'updatedAt'>
>;
export type ReviewRow = typeof kycReviews.$inferSelect;
export type NewReview = typeof kycReviews.$inferInsert;
export type VerificationRow = typeof kycVerifications.$inferSelect;
export type NewVerification = typeof kycVerifications.$inferInsert;

@Injectable()
export class KycProfilesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async findByMerchant(
    merchantId: string,
    tx: Executor = this.db
  ): Promise<ProfileRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycProfiles)
      .where(eq(kycProfiles.merchantId, merchantId))
      .limit(1);
    return row;
  }

  async lockByMerchant(tx: Executor, merchantId: string): Promise<ProfileRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycProfiles)
      .where(eq(kycProfiles.merchantId, merchantId))
      .for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<ProfileRow | undefined> {
    const [row] = await tx.select().from(kycProfiles).where(eq(kycProfiles.id, id)).for('update');
    return row;
  }

  async findById(id: string, tx: Executor = this.db): Promise<ProfileRow | undefined> {
    const [row] = await tx.select().from(kycProfiles).where(eq(kycProfiles.id, id)).limit(1);
    return row;
  }

  /** Creates the merchant's profile if it has none. The unique key makes this race-safe. */
  async ensure(tx: Executor, values: NewProfile): Promise<void> {
    await tx.insert(kycProfiles).values(values).onConflictDoNothing();
  }

  async update(tx: Executor, id: string, patch: ProfilePatch): Promise<ProfileRow> {
    const [row] = await tx.update(kycProfiles).set(patch).where(eq(kycProfiles.id, id)).returning();
    if (!row) throw new Error('kyc profile update returned no row');
    return row;
  }

  async insertReview(tx: Executor, values: NewReview): Promise<void> {
    await tx.insert(kycReviews).values(values);
  }

  reviews(profileId: string, tx: Executor = this.db): Promise<ReviewRow[]> {
    return tx
      .select()
      .from(kycReviews)
      .where(eq(kycReviews.kycProfileId, profileId))
      .orderBy(asc(kycReviews.createdAt));
  }

  /**
   * The number of the last submission a decision (approval, rejection or expiry) was made on, or
   * 0. Checks recorded for that submission or earlier are stale: they are not carried into a
   * renewal or a new submission. Counting submissions rather than comparing times means two
   * events in the same millisecond cannot be ordered the wrong way.
   */
  async lastDecidedSubmission(profileId: string, tx: Executor = this.db): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number | null>`max(${kycReviews.submissionNo})` })
      .from(kycReviews)
      .where(
        and(
          eq(kycReviews.kycProfileId, profileId),
          inArray(kycReviews.decision, ['approved', 'rejected', 'expired'])
        )
      );
    return row?.n ?? 0;
  }

  async insertVerification(tx: Executor, values: NewVerification): Promise<void> {
    await tx.insert(kycVerifications).values(values);
  }

  verifications(profileId: string, tx: Executor = this.db): Promise<VerificationRow[]> {
    return tx
      .select()
      .from(kycVerifications)
      .where(eq(kycVerifications.kycProfileId, profileId))
      .orderBy(asc(kycVerifications.performedAt));
  }

  /** The queue of submissions waiting for staff, newest first. */
  queue(filter: { status?: string; after?: CursorKey; limit: number }) {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(kycProfiles.status, filter.status));
    else {
      const waiting = inArray(kycProfiles.status, ['pending', 'in_review']);
      conditions.push(waiting);
    }
    if (filter.after) {
      const keyset = or(
        lt(kycProfiles.submittedAt, filter.after.createdAt),
        and(eq(kycProfiles.submittedAt, filter.after.createdAt), lt(merchants.ref, filter.after.id))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select({
        profile: kycProfiles,
        merchantRef: merchants.ref,
        merchantName: merchants.legalName,
      })
      .from(kycProfiles)
      .innerJoin(merchants, eq(merchants.id, kycProfiles.merchantId))
      .where(and(...conditions))
      .orderBy(desc(kycProfiles.submittedAt), desc(merchants.ref))
      .limit(filter.limit + 1);
  }

  /** Approved profiles whose re-verification notice is due and has not been sent. */
  dueForNotice(now: Date, limit: number, tx: Executor = this.db): Promise<ProfileRow[]> {
    return tx
      .select()
      .from(kycProfiles)
      .where(
        and(
          eq(kycProfiles.status, 'approved'),
          lte(kycProfiles.nextReviewAt, now),
          isNull(kycProfiles.reverificationNotifiedAt)
        )
      )
      .orderBy(asc(kycProfiles.nextReviewAt))
      .limit(limit);
  }

  /** Approved profiles whose validity has ended. */
  dueForExpiry(now: Date, limit: number, tx: Executor = this.db): Promise<ProfileRow[]> {
    return tx
      .select()
      .from(kycProfiles)
      .where(and(eq(kycProfiles.status, 'approved'), lte(kycProfiles.expiresAt, now)))
      .orderBy(asc(kycProfiles.expiresAt))
      .limit(limit);
  }

  /**
   * Who reviewed the current round: staff who verified a document or recorded a check in a
   * submission after the last decision. They cannot approve it (maker-checker, spec 11).
   */
  async reviewersAfter(
    profileId: string,
    decidedSubmission: number,
    tx: Executor = this.db
  ): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ userId: kycVerifications.performedBy })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.kycProfileId, profileId),
          gt(kycVerifications.submissionNo, decidedSubmission),
          isNotNull(kycVerifications.performedBy)
        )
      );
    return rows.flatMap((r) => (r.userId ? [r.userId] : []));
  }

  /** The latest verification of each check type recorded after `decidedSubmission`. */
  async latestChecksAfter(
    profileId: string,
    decidedSubmission: number,
    tx: Executor = this.db
  ): Promise<VerificationRow[]> {
    const rows = await tx
      .select()
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.kycProfileId, profileId),
          gt(kycVerifications.submissionNo, decidedSubmission)
        )
      )
      .orderBy(
        asc(kycVerifications.submissionNo),
        asc(kycVerifications.performedAt),
        asc(kycVerifications.createdAt)
      );
    const latest = new Map<string, VerificationRow>();
    for (const row of rows) latest.set(row.checkType, row);
    return [...latest.values()];
  }
}
