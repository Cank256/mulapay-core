/** SQL for `core.kyc_requirements`, the rows that say what a merchant must provide. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { kycRequirements } from '../../db/schema';

export type RequirementDbRow = typeof kycRequirements.$inferSelect;
export type NewRequirement = typeof kycRequirements.$inferInsert;
export type RequirementPatch = Partial<
  Pick<
    NewRequirement,
    'label' | 'description' | 'mandatory' | 'active' | 'sortOrder' | 'evidenceKey' | 'kind'
  >
>;

@Injectable()
export class KycRequirementsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Every row, active or not; the domain filters. Small table, read as a whole. */
  listAll(
    filter: { country?: string; level?: number; activeOnly?: boolean } = {},
    tx: Executor = this.db
  ): Promise<RequirementDbRow[]> {
    return tx
      .select()
      .from(kycRequirements)
      .where(
        and(
          filter.country ? eq(kycRequirements.country, filter.country) : undefined,
          filter.level ? eq(kycRequirements.level, filter.level) : undefined,
          filter.activeOnly ? eq(kycRequirements.active, true) : undefined
        )
      )
      .orderBy(
        asc(kycRequirements.level),
        asc(kycRequirements.sortOrder),
        asc(kycRequirements.requirementCode),
        asc(kycRequirements.country),
        asc(kycRequirements.businessType)
      );
  }

  async findById(id: string, tx: Executor = this.db): Promise<RequirementDbRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycRequirements)
      .where(eq(kycRequirements.id, id))
      .limit(1);
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<RequirementDbRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycRequirements)
      .where(eq(kycRequirements.id, id))
      .for('update');
    return row;
  }

  async insert(tx: Executor, values: NewRequirement): Promise<RequirementDbRow> {
    const [row] = await tx.insert(kycRequirements).values(values).returning();
    if (!row) throw new Error('requirement insert returned no row');
    return row;
  }

  async update(tx: Executor, id: string, patch: RequirementPatch): Promise<RequirementDbRow> {
    const [row] = await tx
      .update(kycRequirements)
      .set(patch)
      .where(eq(kycRequirements.id, id))
      .returning();
    if (!row) throw new Error('requirement update returned no row');
    return row;
  }
}
