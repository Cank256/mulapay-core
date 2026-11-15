/**
 * SQL for `core.api_keys`. Management methods are scoped by `merchantId` (spec 8.4); the
 * authentication lookup is by `key_id`, which the key itself carries.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { apiKeys, merchants } from '../../db/schema';

export type ApiKeyRow = typeof apiKeys.$inferSelect;

@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: typeof apiKeys.$inferInsert): Promise<ApiKeyRow> {
    const [row] = await tx.insert(apiKeys).values(values).returning();
    if (!row) throw new Error('api key insert returned no row');
    return row;
  }

  list(merchantId: string) {
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.merchantId, merchantId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(200);
  }

  async lockByRef(tx: Executor, merchantId: string, ref: string): Promise<ApiKeyRow | undefined> {
    const [row] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.merchantId, merchantId), eq(apiKeys.ref, ref)))
      .for('update');
    return row;
  }

  async hasSuccessor(tx: Executor, merchantId: string, id: string): Promise<boolean> {
    const rows = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.merchantId, merchantId), eq(apiKeys.rolledFromId, id)))
      .limit(1);
    return rows.length > 0;
  }

  async revoke(tx: Executor, merchantId: string, id: string, at: Date, by: string) {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: at, revokedBy: by })
      .where(and(eq(apiKeys.merchantId, merchantId), eq(apiKeys.id, id)))
      .returning();
    return row;
  }

  async setExpiry(tx: Executor, merchantId: string, id: string, expiresAt: Date) {
    const [row] = await tx
      .update(apiKeys)
      .set({ expiresAt })
      .where(and(eq(apiKeys.merchantId, merchantId), eq(apiKeys.id, id)))
      .returning();
    return row;
  }

  /** Authentication lookup: the key and its merchant's status. */
  async findForAuthentication(keyId: string) {
    const [row] = await this.db
      .select({
        key: apiKeys,
        merchantRef: merchants.ref,
        merchantStatus: merchants.status,
      })
      .from(apiKeys)
      .innerJoin(merchants, eq(merchants.id, apiKeys.merchantId))
      .where(eq(apiKeys.keyId, keyId))
      .limit(1);
    return row;
  }
}
