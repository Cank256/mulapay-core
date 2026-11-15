/**
 * Read-only integrity queries over the ledger (spec 6.6, 6.8 run 2).
 *
 * The entry scan carries a `created_at` window so partitions are pruned (spec 5.1). The
 * balance agreement check recomputes every (account, currency) from all journal lines:
 * that full scan is the point of the check, and it runs on a schedule, not per request.
 * Every list is capped so a corrupted ledger cannot produce an unbounded report.
 */
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';

export const INTEGRITY_ROW_LIMIT = 1000;

export interface InvalidEntryRow {
  readonly ref: string;
  readonly created_at: string;
  readonly line_count: number;
  readonly debits: string;
  readonly credits: string;
  readonly currency_mismatch: boolean;
}

export interface BalanceMismatchRow {
  readonly code: string;
  readonly environment: string;
  readonly currency: string;
  readonly recorded_debits: string;
  readonly recorded_credits: string;
  readonly journal_debits: string;
  readonly journal_credits: string;
}

export interface AccountAmountRow {
  readonly code: string;
  readonly environment: string;
  readonly currency: string;
  readonly balance: string;
}

export interface TotalsRow {
  readonly environment: string;
  readonly currency: string;
  readonly debits: string;
  readonly credits: string;
}

export interface TrialBalanceRow {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly normal_balance: string;
  readonly debits: string;
  readonly credits: string;
}

@Injectable()
export class LedgerIntegrityRepository {
  /** Entries with fewer than two lines, unequal debits and credits, or a foreign currency. */
  async invalidEntries(tx: Executor, from: Date, to: Date): Promise<InvalidEntryRow[]> {
    const result = await tx.execute<InvalidEntryRow & Record<string, unknown>>(sql`
      select e.ref,
             e.created_at::text as created_at,
             count(l.entry_id)::int as line_count,
             coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)::text as debits,
             coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)::text as credits,
             coalesce(bool_or(l.currency <> e.currency), false) as currency_mismatch
        from core.journal_entries e
        left join core.journal_lines l
          on l.entry_id = e.id and l.created_at = e.created_at
         and l.created_at >= ${from} and l.created_at < ${to}
       where e.created_at >= ${from} and e.created_at < ${to}
       group by e.id, e.created_at, e.ref
      having count(l.entry_id) < 2
          or coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)
             <> coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)
          or coalesce(bool_or(l.currency <> e.currency), false)
       order by e.created_at, e.ref
       limit ${INTEGRITY_ROW_LIMIT}`);
    return result.rows;
  }

  /** (account, currency) pairs where account_balances disagrees with the journal. */
  async balanceMismatches(tx: Executor): Promise<BalanceMismatchRow[]> {
    const result = await tx.execute<BalanceMismatchRow & Record<string, unknown>>(sql`
      with journal as (
        select account_id, currency,
               coalesce(sum(amount_minor) filter (where direction = 'debit'), 0) as debits,
               coalesce(sum(amount_minor) filter (where direction = 'credit'), 0) as credits
          from core.journal_lines
         group by account_id, currency
      )
      select a.code, a.environment, coalesce(b.currency, j.currency) as currency,
             coalesce(b.posted_debits_minor, 0)::text as recorded_debits,
             coalesce(b.posted_credits_minor, 0)::text as recorded_credits,
             coalesce(j.debits, 0)::text as journal_debits,
             coalesce(j.credits, 0)::text as journal_credits
        from core.account_balances b
        full join journal j on j.account_id = b.account_id and j.currency = b.currency
        join core.accounts a on a.id = coalesce(b.account_id, j.account_id)
       where coalesce(b.posted_debits_minor, 0) <> coalesce(j.debits, 0)
          or coalesce(b.posted_credits_minor, 0) <> coalesce(j.credits, 0)
       order by a.code, 3
       limit ${INTEGRITY_ROW_LIMIT}`);
    return result.rows;
  }

  /** Suspense balances that are not zero (spec 5.4: must be cleared). */
  async nonZeroSuspense(tx: Executor): Promise<AccountAmountRow[]> {
    const result = await tx.execute<AccountAmountRow & Record<string, unknown>>(sql`
      select a.code, a.environment, b.currency,
             (b.posted_debits_minor - b.posted_credits_minor)::text as balance
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       where a.purpose = 'suspense' and b.posted_debits_minor <> b.posted_credits_minor
       order by a.environment, b.currency
       limit ${INTEGRITY_ROW_LIMIT}`);
    return result.rows;
  }

  /** Merchant payable or reserve accounts in a debit position (spec 5.3 rule 7). */
  async negativeMerchantBalances(tx: Executor): Promise<AccountAmountRow[]> {
    const result = await tx.execute<AccountAmountRow & Record<string, unknown>>(sql`
      select a.code, a.environment, b.currency,
             (b.posted_credits_minor - b.posted_debits_minor)::text as balance
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       where a.purpose in ('merchant_payable', 'merchant_reserve')
         and b.posted_debits_minor > b.posted_credits_minor
       order by a.code, b.currency
       limit ${INTEGRITY_ROW_LIMIT}`);
    return result.rows;
  }

  /** Total debits and credits over all accounts, per environment and currency. */
  async totals(tx: Executor): Promise<TotalsRow[]> {
    const result = await tx.execute<TotalsRow & Record<string, unknown>>(sql`
      select a.environment, b.currency,
             sum(b.posted_debits_minor)::text as debits,
             sum(b.posted_credits_minor)::text as credits
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       group by a.environment, b.currency
       order by a.environment, b.currency`);
    return result.rows;
  }

  /** One row per account with a balance in the currency (spec 6.6, trial balance). */
  async trialBalance(
    tx: Executor,
    environment: string,
    currency: string
  ): Promise<TrialBalanceRow[]> {
    const result = await tx.execute<TrialBalanceRow & Record<string, unknown>>(sql`
      select a.code, a.name, a.type, a.normal_balance,
             b.posted_debits_minor::text as debits,
             b.posted_credits_minor::text as credits
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       where a.environment = ${environment} and b.currency = ${currency}
         and (b.posted_debits_minor <> 0 or b.posted_credits_minor <> 0)
       order by a.code`);
    return result.rows;
  }
}
