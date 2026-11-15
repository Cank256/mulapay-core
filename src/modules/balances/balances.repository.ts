/**
 * SQL for `core.account_balances`. The table is written only by the journal line trigger
 * (migration 0002); the one write here inserts all-zero rows so they can be locked.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { accountBalances, accounts } from '../../db/schema';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';

export type AccountBalanceRow = typeof accountBalances.$inferSelect;

export interface AccountBalanceWithAccount {
  readonly accountId: string;
  readonly code: string;
  readonly purpose: string;
  readonly normalBalance: string;
  readonly currency: string;
  readonly postedDebitsMinor: bigint;
  readonly postedCreditsMinor: bigint;
}

@Injectable()
export class BalancesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /**
   * Locks the balance rows a posting will change, creating missing ones at zero, in
   * ascending account id order (spec 5.3 rule 8) so concurrent postings cannot deadlock.
   */
  async lockForPosting(
    tx: Executor,
    accountIds: readonly string[],
    currency: string
  ): Promise<AccountBalanceRow[]> {
    const ordered = [...accountIds].sort();
    await tx
      .insert(accountBalances)
      .values(ordered.map((accountId) => ({ accountId, currency })))
      .onConflictDoNothing();
    return tx
      .select()
      .from(accountBalances)
      .where(
        and(inArray(accountBalances.accountId, ordered), eq(accountBalances.currency, currency))
      )
      .orderBy(asc(accountBalances.accountId))
      .for('update');
  }

  async listForAccount(accountId: string, tx: Executor = this.db): Promise<AccountBalanceRow[]> {
    return tx
      .select()
      .from(accountBalances)
      .where(eq(accountBalances.accountId, accountId))
      .orderBy(asc(accountBalances.currency));
  }

  async listForMerchant(
    merchantId: string,
    environment: LedgerEnvironment,
    tx: Executor = this.db
  ): Promise<AccountBalanceWithAccount[]> {
    return tx
      .select({
        accountId: accounts.id,
        code: accounts.code,
        purpose: accounts.purpose,
        normalBalance: accounts.normalBalance,
        currency: accountBalances.currency,
        postedDebitsMinor: accountBalances.postedDebitsMinor,
        postedCreditsMinor: accountBalances.postedCreditsMinor,
      })
      .from(accountBalances)
      .innerJoin(accounts, eq(accounts.id, accountBalances.accountId))
      .where(and(eq(accounts.merchantId, merchantId), eq(accounts.environment, environment)))
      .orderBy(asc(accounts.code), asc(accountBalances.currency));
  }

  /** True when any live account of the merchant has debits different from credits. */
  async merchantHasNonZeroLiveBalance(
    merchantId: string,
    tx: Executor = this.db
  ): Promise<boolean> {
    const [row] = await tx
      .select({ found: sql<number>`1` })
      .from(accountBalances)
      .innerJoin(accounts, eq(accounts.id, accountBalances.accountId))
      .where(
        and(
          eq(accounts.merchantId, merchantId),
          eq(accounts.environment, 'live'),
          ne(accountBalances.postedDebitsMinor, accountBalances.postedCreditsMinor)
        )
      )
      .limit(1);
    return row !== undefined;
  }
}
