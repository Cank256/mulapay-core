/**
 * Read-only queries the reconciliation checks run over core's own tables. Every query on a
 * partitioned table carries a `created_at` bound so Postgres reads only the partitions it
 * needs (spec 5.1, 9.2 rule 6). Bigint columns come back as text and become `bigint` here.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';

export interface StaleTransaction {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly merchantId: string;
  readonly provider: string | null;
  readonly externalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly outcomeUnknown: boolean;
  readonly since: Date;
}

export interface StatementCandidate {
  readonly id: string;
  readonly ref: string;
  readonly providerTransactionId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly completedAt: Date;
  readonly merchantId: string;
}

export interface ProviderLedgerBalance {
  readonly provider: string;
  readonly purpose: 'provider_clearing' | 'provider_float';
  readonly currency: string;
  /** Debit-positive: these are asset accounts. */
  readonly balanceMinor: bigint;
}

export interface MerchantPayableRow {
  readonly merchantId: string;
  readonly merchantRef: string;
  readonly currency: string;
  /** Credits minus debits on the payable account. */
  readonly postedMinor: bigint;
}

export interface ReserveComparison {
  readonly merchantId: string;
  readonly merchantRef: string;
  readonly currency: string;
  readonly accountMinor: bigint;
  readonly entriesMinor: bigint;
}

const PAYOUT_TYPES = ['payment', 'settlement', 'payout', 'refund'];

@Injectable()
export class ReconciliationQueriesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** `processing` transactions with a gateway key, in flight longer than `olderThan`. */
  async staleProcessing(
    environment: string,
    filter: { merchantId?: string; currency?: string },
    window: { olderThan: Date; since: Date },
    limit: number,
    executor: Executor = this.db
  ): Promise<StaleTransaction[]> {
    const result = await executor.execute<{
      id: string;
      ref: string;
      type: string;
      merchant_id: string;
      provider: string | null;
      external_id: string;
      amount_minor: string;
      currency: string;
      outcome_unknown: boolean;
      since: string;
    }>(sql`
      select t.id, t.ref, t.type, t.merchant_id, t.provider,
             t.gateway_external_id as external_id, t.amount_minor::text as amount_minor,
             t.currency, t.outcome_unknown,
             to_json(coalesce(t.initiated_at, t.created_at)) #>> '{}' as since
        from core.transactions t
       where t.created_at >= ${window.since}
         and t.environment = ${environment}
         and t.status = 'processing'
         and t.gateway_external_id is not null
         and t.type in ${PAYOUT_TYPES}
         and coalesce(t.initiated_at, t.created_at) <= ${window.olderThan}
         and (${filter.merchantId ?? null}::uuid is null or t.merchant_id = ${filter.merchantId ?? null}::uuid)
         and (${filter.currency ?? null}::text is null or t.currency = ${filter.currency ?? null}::text)
       order by coalesce(t.initiated_at, t.created_at), t.ref
       limit ${limit}`);
    return result.rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      type: r.type,
      merchantId: r.merchant_id,
      provider: r.provider,
      externalId: r.external_id,
      amountMinor: BigInt(r.amount_minor),
      currency: r.currency,
      outcomeUnknown: r.outcome_unknown,
      since: new Date(r.since),
    }));
  }

  /** Which of these gateway external ids core has a transaction for (any type, any age). */
  async knownExternalIds(
    environment: string,
    externalIds: readonly string[],
    executor: Executor = this.db
  ): Promise<Set<string>> {
    if (externalIds.length === 0) return new Set();
    const result = await executor.execute<{ external_id: string }>(sql`
      select gateway_external_id as external_id
        from core.transaction_keys
       where environment = ${environment}
         and gateway_external_id in ${[...externalIds]}`);
    return new Set(result.rows.map((r) => r.external_id));
  }

  /** Succeeded transactions of one provider and currency completed within the window. */
  async statementCandidates(
    provider: string,
    currency: string,
    from: Date,
    to: Date,
    executor: Executor = this.db
  ): Promise<StatementCandidate[]> {
    const result = await executor.execute<{
      id: string;
      ref: string;
      provider_transaction_id: string | null;
      amount_minor: string;
      currency: string;
      completed_at: string;
      merchant_id: string;
    }>(sql`
      select id, ref, provider_transaction_id, amount_minor::text as amount_minor, currency,
             to_json(completed_at) #>> '{}' as completed_at, merchant_id
        from core.transactions
       where created_at >= ${new Date(from.getTime() - 7 * 86_400_000)}
         and created_at <= ${to}
         and environment = 'live'
         and status = 'succeeded'
         and provider = ${provider}
         and currency = ${currency}
         and type in ${PAYOUT_TYPES}
         and completed_at >= ${from} and completed_at < ${to}
       order by completed_at, ref`);
    return result.rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      providerTransactionId: r.provider_transaction_id,
      amountMinor: BigInt(r.amount_minor),
      currency: r.currency,
      completedAt: new Date(r.completed_at),
      merchantId: r.merchant_id,
    }));
  }

  /** Provider clearing and float balances per provider and currency, from the ledger. */
  async providerLedgerBalances(
    environment: string,
    currency: string | undefined,
    executor: Executor = this.db
  ): Promise<ProviderLedgerBalance[]> {
    const result = await executor.execute<{
      provider: string;
      purpose: 'provider_clearing' | 'provider_float';
      currency: string;
      balance: string;
    }>(sql`
      select a.provider, a.purpose, b.currency,
             (b.posted_debits_minor - b.posted_credits_minor)::text as balance
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
       where a.environment = ${environment}
         and a.purpose in ('provider_clearing', 'provider_float')
         and (${currency ?? null}::text is null or b.currency = ${currency ?? null}::text)
       order by a.provider, a.purpose, b.currency`);
    return result.rows.map((r) => ({
      provider: r.provider,
      purpose: r.purpose,
      currency: r.currency,
      balanceMinor: BigInt(r.balance),
    }));
  }

  /**
   * Every merchant's payable balance (credits minus debits) recomputed from the journal
   * lines, the source of truth: the balance proof compares it with what the balances service
   * reports, which reads the `account_balances` projection.
   */
  async merchantPayables(
    environment: string,
    filter: { currency?: string; merchantId?: string },
    limit: number,
    executor: Executor = this.db
  ): Promise<MerchantPayableRow[]> {
    const result = await executor.execute<{
      merchant_id: string;
      merchant_ref: string;
      currency: string;
      posted: string;
    }>(sql`
      select m.id as merchant_id, m.ref as merchant_ref, l.currency,
             sum(case when l.direction = 'credit' then l.amount_minor else -l.amount_minor end)::text as posted
        from core.journal_lines l
        join core.accounts a on a.id = l.account_id
        join core.merchants m on m.id = a.merchant_id
       where a.environment = ${environment}
         and a.purpose = 'merchant_payable'
         and (${filter.currency ?? null}::text is null or l.currency = ${filter.currency ?? null}::text)
         and (${filter.merchantId ?? null}::uuid is null or m.id = ${filter.merchantId ?? null}::uuid)
       group by m.id, m.ref, l.currency
       order by m.ref, l.currency
       limit ${limit}`);
    return result.rows.map((r) => ({
      merchantId: r.merchant_id,
      merchantRef: r.merchant_ref,
      currency: r.currency,
      postedMinor: BigInt(r.posted),
    }));
  }

  /** Merchant reserve account balance against unreleased reserve entries, live only. */
  async reserveComparisons(
    filter: { currency?: string; merchantId?: string },
    limit: number,
    executor: Executor = this.db
  ): Promise<ReserveComparison[]> {
    const result = await executor.execute<{
      merchant_id: string;
      merchant_ref: string;
      currency: string;
      account_minor: string;
      entries_minor: string;
    }>(sql`
      with account as (
        select a.merchant_id, b.currency,
               (b.posted_credits_minor - b.posted_debits_minor) as minor
          from core.account_balances b
          join core.accounts a on a.id = b.account_id
         where a.environment = 'live' and a.purpose = 'merchant_reserve'
      ), entries as (
        select merchant_id, currency, sum(amount_minor) as minor
          from core.reserve_entries where released_at is null
         group by merchant_id, currency
      )
      select m.id as merchant_id, m.ref as merchant_ref,
             coalesce(a.currency, e.currency) as currency,
             coalesce(a.minor, 0)::text as account_minor,
             coalesce(e.minor, 0)::text as entries_minor
        from account a
        full join entries e on e.merchant_id = a.merchant_id and e.currency = a.currency
        join core.merchants m on m.id = coalesce(a.merchant_id, e.merchant_id)
       where (${filter.currency ?? null}::text is null or coalesce(a.currency, e.currency) = ${filter.currency ?? null}::text)
         and (${filter.merchantId ?? null}::uuid is null or m.id = ${filter.merchantId ?? null}::uuid)
       order by m.ref
       limit ${limit}`);
    return result.rows.map((r) => ({
      merchantId: r.merchant_id,
      merchantRef: r.merchant_ref,
      currency: r.currency,
      accountMinor: BigInt(r.account_minor),
      entriesMinor: BigInt(r.entries_minor),
    }));
  }

  /** Merchants whose payable minus active holds is below zero (spec 5.3 rule 7). */
  async negativeAvailable(
    environment: string,
    currency: string | undefined,
    executor: Executor = this.db
  ): Promise<
    { merchantId: string; merchantRef: string; currency: string; availableMinor: bigint }[]
  > {
    const result = await executor.execute<{
      merchant_id: string;
      merchant_ref: string;
      currency: string;
      available: string;
    }>(sql`
      select m.id as merchant_id, m.ref as merchant_ref, b.currency,
             ((b.posted_credits_minor - b.posted_debits_minor)
              - coalesce((select sum(h.amount_minor) from core.holds h
                           where h.merchant_id = a.merchant_id and h.environment = a.environment
                             and h.currency = b.currency and h.state = 'active'), 0))::text as available
        from core.account_balances b
        join core.accounts a on a.id = b.account_id
        join core.merchants m on m.id = a.merchant_id
       where a.environment = ${environment} and a.purpose = 'merchant_payable'
         and (${currency ?? null}::text is null or b.currency = ${currency ?? null}::text)
         and ((b.posted_credits_minor - b.posted_debits_minor)
              - coalesce((select sum(h.amount_minor) from core.holds h
                           where h.merchant_id = a.merchant_id and h.environment = a.environment
                             and h.currency = b.currency and h.state = 'active'), 0)) < 0
       limit 1000`);
    return result.rows.map((r) => ({
      merchantId: r.merchant_id,
      merchantRef: r.merchant_ref,
      currency: r.currency,
      availableMinor: BigInt(r.available),
    }));
  }

  /** Whether a journal entry exists and whether it is itself a reversal. */
  async entryReversalState(
    ref: string,
    executor: Executor = this.db
  ): Promise<{ isReversal: boolean; environment: string } | undefined> {
    const result = await executor.execute<{ is_reversal: boolean; environment: string }>(sql`
      select k.reverses_entry_id is not null as is_reversal, e.environment
        from core.journal_entry_keys k
        join core.journal_entries e
          on e.id = k.entry_id and e.created_at = k.entry_created_at
       where k.entry_ref = ${ref}`);
    const row = result.rows[0];
    return row ? { isReversal: row.is_reversal, environment: row.environment } : undefined;
  }

  /**
   * Environment and currency of journal entries, read from the journal itself (not the key
   * registry, which a corrupting write would have bypassed). `created_at` is the partition key
   * exactly as the integrity report returned it, so the read is pruned.
   */
  async entryScopes(
    entries: readonly { ref: string; createdAt: string }[],
    executor: Executor = this.db
  ): Promise<Map<string, { environment: string; currency: string }>> {
    if (entries.length === 0) return new Map();
    const pairs = sql.join(
      entries.map((e) => sql`(${e.ref}, ${e.createdAt})`),
      sql`, `
    );
    const result = await executor.execute<{
      ref: string;
      environment: string;
      currency: string;
    }>(sql`
      select ref, environment, currency from core.journal_entries
       where (ref, created_at::text) in (${pairs})`);
    return new Map(
      result.rows.map((r) => [r.ref, { environment: r.environment, currency: r.currency }])
    );
  }

  /** The internal id of an active staff user, by public ref. */
  async staffIdByRef(ref: string, executor: Executor = this.db): Promise<string | undefined> {
    const result = await executor.execute<{ id: string }>(sql`
      select id from core.users where ref = ${ref} and type = 'staff' and status = 'active'`);
    return result.rows[0]?.id;
  }

  /** Public refs of users, by internal id. */
  async userRefs(
    ids: readonly string[],
    executor: Executor = this.db
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const result = await executor.execute<{ id: string; ref: string }>(sql`
      select id, ref from core.users where id in ${[...ids]}`);
    return new Map(result.rows.map((r) => [r.id, r.ref]));
  }
}
