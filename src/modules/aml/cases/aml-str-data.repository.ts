/**
 * Read-only SQL that gathers what an STR package needs from tables other modules own:
 * the merchant's KYC profile and parties, the transactions behind a case's alerts and the
 * merchant's screenings. Reads only; nothing here writes.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { amlScreenings, kycParties, merchantProfiles } from '../../../db/schema';

export interface StrTransaction {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly status: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly channel: string;
  readonly provider: string | null;
  readonly completedAt: string | null;
}

@Injectable()
export class AmlStrDataRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async profile(merchantId: string) {
    const [row] = await this.db
      .select()
      .from(merchantProfiles)
      .where(eq(merchantProfiles.merchantId, merchantId))
      .limit(1);
    return row;
  }

  parties(merchantId: string) {
    return this.db.select().from(kycParties).where(eq(kycParties.merchantId, merchantId));
  }

  screenings(merchantId: string) {
    return this.db.select().from(amlScreenings).where(eq(amlScreenings.merchantId, merchantId));
  }

  async transactions(ids: readonly string[]): Promise<StrTransaction[]> {
    if (ids.length === 0) return [];
    const result = await this.db.execute<{
      id: string;
      ref: string;
      type: string;
      status: string;
      amount_minor: string;
      currency: string;
      channel: string;
      provider: string | null;
      completed_at: string | null;
    }>(sql`
      select t.id, t.ref, t.type, t.status, t.amount_minor::text as amount_minor, t.currency, t.channel,
             t.provider, to_json(t.completed_at) #>> '{}' as completed_at
        from core.transaction_keys k
        join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
       where k.id in (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `
       )})
       order by t.created_at, t.ref`);
    return result.rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      type: r.type,
      status: r.status,
      amountMinor: r.amount_minor,
      currency: r.currency,
      channel: r.channel,
      provider: r.provider,
      completedAt: r.completed_at,
    }));
  }
}
