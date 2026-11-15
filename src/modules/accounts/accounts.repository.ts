/** SQL for `core.accounts`. Accounts are never deleted (migration 0002). */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { accounts } from '../../db/schema';
import type { LedgerEnvironment } from './domain/chart-of-accounts';

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

@Injectable()
export class AccountsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Inserts the rows whose (environment, code) does not exist yet. */
  async insertMissing(tx: Executor, rows: readonly NewAccount[]): Promise<void> {
    if (rows.length === 0) return;
    await tx
      .insert(accounts)
      .values([...rows])
      .onConflictDoNothing({ target: [accounts.environment, accounts.code] });
  }

  async findByCodes(
    tx: Executor,
    environment: LedgerEnvironment,
    codes: readonly string[]
  ): Promise<AccountRow[]> {
    return tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.environment, environment), inArray(accounts.code, [...codes])));
  }

  async findByCode(
    environment: LedgerEnvironment,
    code: string,
    tx: Executor = this.db
  ): Promise<AccountRow | undefined> {
    const [row] = await this.findByCodes(tx, environment, [code]);
    return row;
  }

  async listForMerchant(merchantId: string, tx: Executor = this.db): Promise<AccountRow[]> {
    return tx
      .select()
      .from(accounts)
      .where(eq(accounts.merchantId, merchantId))
      .orderBy(asc(accounts.environment), asc(accounts.code));
  }

  /** Accounts of one environment ordered by code, after `afterCode` (keyset on the unique index). */
  async list(
    filter: {
      readonly environment: LedgerEnvironment;
      readonly purpose?: string;
      readonly merchantId?: string;
      readonly afterCode?: string;
      readonly limit: number;
    },
    tx: Executor = this.db
  ): Promise<AccountRow[]> {
    const conditions = [eq(accounts.environment, filter.environment)];
    if (filter.purpose) conditions.push(eq(accounts.purpose, filter.purpose));
    if (filter.merchantId) conditions.push(eq(accounts.merchantId, filter.merchantId));
    if (filter.afterCode) conditions.push(gt(accounts.code, filter.afterCode));
    return tx
      .select()
      .from(accounts)
      .where(and(...conditions))
      .orderBy(asc(accounts.code))
      .limit(filter.limit);
  }
}
