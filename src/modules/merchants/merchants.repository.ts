/** SQL for `core.merchants`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { MerchantStatus } from '../../common/auth/principal';
import type { Executor } from '../../common/db/database.types';
import { DB_REPLICA, DB_RW } from '../../common/db/tokens';
import type { CursorKey } from '../../common/pagination/cursor';
import { merchants } from '../../db/schema';

export type MerchantRow = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type MerchantPatch = Partial<
  Pick<
    NewMerchant,
    | 'legalName'
    | 'tradingName'
    | 'country'
    | 'defaultCurrency'
    | 'riskRating'
    | 'mcc'
    | 'website'
    | 'supportEmail'
    | 'metadata'
  >
>;

export interface MerchantListFilter {
  readonly status?: MerchantStatus;
  readonly after?: CursorKey;
  readonly limit: number;
}

@Injectable()
export class MerchantsRepository {
  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(DB_REPLICA) private readonly replica: Executor
  ) {}

  async insert(tx: Executor, values: NewMerchant): Promise<MerchantRow> {
    const [row] = await tx.insert(merchants).values(values).returning();
    if (!row) throw new Error('merchant insert returned no row');
    return row;
  }

  async findById(id: string, tx: Executor = this.db): Promise<MerchantRow | undefined> {
    const [row] = await tx.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<MerchantRow | undefined> {
    const [row] = await tx.select().from(merchants).where(eq(merchants.ref, ref)).limit(1);
    return row;
  }

  async lockByRef(tx: Executor, ref: string): Promise<MerchantRow | undefined> {
    const [row] = await tx.select().from(merchants).where(eq(merchants.ref, ref)).for('update');
    return row;
  }

  async lockById(tx: Executor, id: string): Promise<MerchantRow | undefined> {
    const [row] = await tx.select().from(merchants).where(eq(merchants.id, id)).for('update');
    return row;
  }

  async update(tx: Executor, id: string, patch: MerchantPatch): Promise<MerchantRow> {
    const [row] = await tx.update(merchants).set(patch).where(eq(merchants.id, id)).returning();
    if (!row) throw new Error('merchant update returned no row');
    return row;
  }

  async setStatus(tx: Executor, id: string, status: MerchantStatus): Promise<MerchantRow> {
    const [row] = await tx
      .update(merchants)
      .set({ status })
      .where(eq(merchants.id, id))
      .returning();
    if (!row) throw new Error('merchant status update returned no row');
    return row;
  }

  /** KYC approval: the merchant's level, and its status when the approval changes it. */
  async setKycLevel(
    tx: Executor,
    id: string,
    kycLevel: number,
    status?: MerchantStatus
  ): Promise<MerchantRow> {
    const [row] = await tx
      .update(merchants)
      .set({ kycLevel, ...(status ? { status } : {}) })
      .where(eq(merchants.id, id))
      .returning();
    if (!row) throw new Error('merchant kyc update returned no row');
    return row;
  }

  /** Admin list, newest first, keyset on (created_at, ref). Reads the replica (spec 9.2). */
  list(filter: MerchantListFilter) {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(merchants.status, filter.status));
    if (filter.after) {
      const { createdAt, id: ref } = filter.after;
      const keyset = or(
        lt(merchants.createdAt, createdAt),
        and(eq(merchants.createdAt, createdAt), lt(merchants.ref, ref))
      );
      if (keyset) conditions.push(keyset);
    }
    return this.replica
      .select()
      .from(merchants)
      .where(and(...conditions))
      .orderBy(desc(merchants.createdAt), desc(merchants.ref))
      .limit(filter.limit + 1);
  }
}
