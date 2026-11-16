/** SQL for what a merchant tells us about itself: `merchant_profiles` and `kyc_parties`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { kycParties, merchantProfiles } from '../../db/schema';

export type MerchantProfileRow = typeof merchantProfiles.$inferSelect;
export type PartyRow = typeof kycParties.$inferSelect;
export type NewParty = typeof kycParties.$inferInsert;

export interface ProfileFields {
  readonly registrationNumber?: string | null;
  readonly tinEnc?: string | null;
  readonly tinHmac?: string | null;
  readonly incorporationDate?: string | null;
  readonly businessType?: string | null;
  readonly address?: Record<string, string>;
}

@Injectable()
export class KycDataRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async findProfile(
    merchantId: string,
    tx: Executor = this.db
  ): Promise<MerchantProfileRow | undefined> {
    const [row] = await tx
      .select()
      .from(merchantProfiles)
      .where(eq(merchantProfiles.merchantId, merchantId))
      .limit(1);
    return row;
  }

  async upsertProfile(
    tx: Executor,
    merchantId: string,
    fields: ProfileFields
  ): Promise<MerchantProfileRow> {
    const [row] = await tx
      .insert(merchantProfiles)
      .values({ merchantId, ...fields })
      .onConflictDoUpdate({ target: merchantProfiles.merchantId, set: fields })
      .returning();
    if (!row) throw new Error('profile upsert returned no row');
    return row;
  }

  async insertParty(tx: Executor, values: NewParty): Promise<PartyRow> {
    const [row] = await tx.insert(kycParties).values(values).returning();
    if (!row) throw new Error('party insert returned no row');
    return row;
  }

  /** Active parties of a merchant, oldest first. */
  activeParties(merchantId: string, tx: Executor = this.db): Promise<PartyRow[]> {
    return tx
      .select()
      .from(kycParties)
      .where(and(eq(kycParties.merchantId, merchantId), eq(kycParties.status, 'active')))
      .orderBy(asc(kycParties.createdAt), asc(kycParties.ref));
  }

  async lockParty(tx: Executor, merchantId: string, ref: string): Promise<PartyRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycParties)
      .where(and(eq(kycParties.merchantId, merchantId), eq(kycParties.ref, ref)))
      .for('update');
    return row;
  }

  async removeParty(tx: Executor, id: string, at: Date): Promise<PartyRow> {
    const [row] = await tx
      .update(kycParties)
      .set({ status: 'removed', removedAt: at })
      .where(eq(kycParties.id, id))
      .returning();
    if (!row) throw new Error('party removal returned no row');
    return row;
  }
}
