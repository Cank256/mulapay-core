/** SQL for `core.aml_screenings`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import type { CursorKey } from '../../../common/pagination/cursor';
import { amlScreenings } from '../../../db/schema';

export type ScreeningRow = typeof amlScreenings.$inferSelect;
export type NewScreening = typeof amlScreenings.$inferInsert;

@Injectable()
export class AmlScreeningsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Null when the dedupe key was used before. */
  async insert(tx: Executor, values: NewScreening): Promise<ScreeningRow | null> {
    const [row] = await tx.insert(amlScreenings).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async findByDedupeKey(key: string, tx: Executor = this.db): Promise<ScreeningRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlScreenings)
      .where(eq(amlScreenings.dedupeKey, key))
      .limit(1);
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<ScreeningRow | undefined> {
    const [row] = await tx.select().from(amlScreenings).where(eq(amlScreenings.ref, ref)).limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<ScreeningRow | undefined> {
    const [row] = await tx
      .select()
      .from(amlScreenings)
      .where(eq(amlScreenings.ref, ref))
      .for('update');
    return row;
  }

  async decide(
    tx: Executor,
    id: string,
    values: {
      status: 'clear' | 'confirmed_match';
      reviewedBy: string;
      reviewedAt: Date;
      reviewNote: string;
      caseId?: string;
    }
  ): Promise<ScreeningRow> {
    const [row] = await tx
      .update(amlScreenings)
      .set({
        status: values.status,
        reviewedBy: values.reviewedBy,
        reviewedAt: values.reviewedAt,
        reviewNote: values.reviewNote,
        ...(values.caseId ? { caseId: values.caseId } : {}),
      })
      .where(eq(amlScreenings.id, id))
      .returning();
    if (!row) throw new Error('screening update returned no row');
    return row;
  }

  async attachCase(tx: Executor, id: string, caseId: string): Promise<void> {
    await tx.update(amlScreenings).set({ caseId }).where(eq(amlScreenings.id, id));
  }

  /** The screenings made for one KYC submission, newest first. */
  forSubmission(
    kycProfileId: string,
    submissionNo: number,
    tx: Executor = this.db
  ): Promise<ScreeningRow[]> {
    return tx
      .select()
      .from(amlScreenings)
      .where(
        and(
          eq(amlScreenings.kycProfileId, kycProfileId),
          eq(amlScreenings.submissionNo, submissionNo)
        )
      )
      .orderBy(desc(amlScreenings.screenedAt));
  }

  list(filter: {
    status?: string;
    merchantId?: string;
    subjectType?: string;
    after?: CursorKey;
    limit: number;
  }): Promise<ScreeningRow[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(amlScreenings.status, filter.status));
    if (filter.merchantId) conditions.push(eq(amlScreenings.merchantId, filter.merchantId));
    if (filter.subjectType) conditions.push(eq(amlScreenings.subjectType, filter.subjectType));
    if (filter.after) {
      const keyset = or(
        lt(amlScreenings.screenedAt, filter.after.createdAt),
        and(
          eq(amlScreenings.screenedAt, filter.after.createdAt),
          lt(amlScreenings.ref, filter.after.id)
        )
      );
      if (keyset) conditions.push(keyset);
    }
    return this.db
      .select()
      .from(amlScreenings)
      .where(and(...conditions))
      .orderBy(desc(amlScreenings.screenedAt), desc(amlScreenings.ref))
      .limit(filter.limit + 1);
  }
}
