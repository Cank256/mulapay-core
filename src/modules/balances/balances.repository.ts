/**
 * SQL for `core.account_balances`. The table is written only by the journal line trigger
 * (migration 0002); the one write here inserts all-zero rows so they can be locked.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { accountBalances, accounts, holds, transactions } from '../../db/schema';
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

  /**
   * Locks the merchant's payable balance row for this currency (creating it at zero) and
   * returns its totals. Holds are placed under this lock, so two placements for one
   * merchant and currency never see the same available balance (spec 5.3 rule 8: it is
   * the only balance row a placement locks, so it cannot deadlock with a posting).
   */
  async lockPayable(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string
  ): Promise<{ accountId: string; debits: bigint; credits: bigint } | undefined> {
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.merchantId, merchantId),
          eq(accounts.environment, environment),
          eq(accounts.purpose, 'merchant_payable')
        )
      );
    if (!account) return undefined;
    // lockForPosting creates the row at zero when missing, so one row always comes back.
    const [row] = (await this.lockForPosting(tx, [account.id], currency)) as [AccountBalanceRow];
    return {
      accountId: account.id,
      debits: row.postedDebitsMinor,
      credits: row.postedCreditsMinor,
    };
  }
  /** The payable account's totals without locking, for reads. */
  async readPayable(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string
  ): Promise<{ debits: bigint; credits: bigint }> {
    const [row] = await tx
      .select({
        debits: accountBalances.postedDebitsMinor,
        credits: accountBalances.postedCreditsMinor,
      })
      .from(accountBalances)
      .innerJoin(accounts, eq(accounts.id, accountBalances.accountId))
      .where(
        and(
          eq(accounts.merchantId, merchantId),
          eq(accounts.environment, environment),
          eq(accounts.purpose, 'merchant_payable'),
          eq(accountBalances.currency, currency)
        )
      );
    return row ?? { debits: 0n, credits: 0n };
  }
  /** `held = sum(holds where state = 'active')` for one merchant, environment and currency. */
  async sumActiveHolds(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string
  ): Promise<bigint> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${holds.amountMinor}), 0)` })
      .from(holds)
      .where(
        and(
          eq(holds.merchantId, merchantId),
          eq(holds.environment, environment),
          eq(holds.currency, currency),
          eq(holds.state, 'active')
        )
      );
    return BigInt((row as { total: string }).total);
  }
  /**
   * `pending = sum(transactions where type = 'payment' and status = 'processing')`. The
   * `created_at` bound prunes partitions (spec 9.2 rule 6); informational only.
   */
  async sumProcessingPayments(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string,
    since: Date
  ): Promise<bigint> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.merchantId, merchantId),
          eq(transactions.environment, environment),
          eq(transactions.currency, currency),
          eq(transactions.type, 'payment'),
          eq(transactions.status, 'processing'),
          gte(transactions.createdAt, since)
        )
      );
    return BigInt((row as { total: string }).total);
  }
  /** Currencies in which the merchant has a payable balance row or an active hold. */
  async currenciesInUse(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment
  ): Promise<string[]> {
    const rows = await tx.execute<{ currency: string }>(sql`
      select ab.currency
        from core.account_balances ab
        join core.accounts a on a.id = ab.account_id
       where a.merchant_id = ${merchantId} and a.environment = ${environment} and a.purpose = 'merchant_payable'
      union
      select h.currency from core.holds h
       where h.merchant_id = ${merchantId} and h.environment = ${environment} and h.state = 'active'
      order by currency`);
    return rows.rows.map((r) => r.currency);
  }
}
