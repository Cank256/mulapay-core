/**
 * Financial invariants as plain SQL against the database, independent of the application's own
 * integrity service (spec 5.3, 6.6, 6.7, 6.8). A second, separately written check is the point:
 * a bug in one cannot hide a violation from the other.
 *
 * Every check returns the offending rows, so a failing test prints what is wrong. All checks are
 * read-only and run as a superuser on their own connection, so they see only committed data.
 */
import { Client } from 'pg';

export interface Violation {
  readonly invariant: string;
  readonly rows: readonly Record<string, unknown>[];
}

const CHECKS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    // Spec 5.3 (1): debits equal credits for every entry.
    name: 'unbalanced_entry',
    sql: `select entry_id, currency, sum(case direction when 'debit' then amount_minor else -amount_minor end)::text as imbalance
            from core.journal_lines group by entry_id, currency
           having sum(case direction when 'debit' then amount_minor else -amount_minor end) <> 0 limit 20`,
  },
  {
    // Spec 5.3 (2): one currency per entry, and every line carries its entry's currency.
    name: 'mixed_currency_entry',
    sql: `select l.entry_id, l.currency as line_currency, e.currency as entry_currency
            from core.journal_lines l join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
           where l.currency <> e.currency limit 20`,
  },
  {
    // Spec 5.3 (4): at least two lines per entry.
    name: 'entry_with_fewer_than_two_lines',
    sql: `select e.id, count(l.entry_id)::text as lines from core.journal_entries e
            left join core.journal_lines l on l.entry_id = e.id and l.created_at = e.created_at
           group by e.id having count(l.entry_id) < 2 limit 20`,
  },
  {
    // Spec 5.3 (6): account_balances equals the sum of the lines, per account and currency.
    name: 'balance_disagrees_with_lines',
    sql: `with lines as (
            select account_id, currency,
                   coalesce(sum(amount_minor) filter (where direction = 'debit'), 0) as debits,
                   coalesce(sum(amount_minor) filter (where direction = 'credit'), 0) as credits
              from core.journal_lines group by account_id, currency)
          select coalesce(b.account_id, l.account_id) as account_id, coalesce(b.currency, l.currency) as currency,
                 b.posted_debits_minor::text as balance_debits, l.debits::text as line_debits,
                 b.posted_credits_minor::text as balance_credits, l.credits::text as line_credits
            from core.account_balances b full join lines l on l.account_id = b.account_id and l.currency = b.currency
           where coalesce(b.posted_debits_minor, 0) <> coalesce(l.debits, 0)
              or coalesce(b.posted_credits_minor, 0) <> coalesce(l.credits, 0) limit 20`,
  },
  {
    // The platform's own money: a merchant is owed, never owing (spec 5.3 (7)).
    name: 'merchant_payable_in_debit_position',
    sql: `select a.code, b.currency, (b.posted_debits_minor - b.posted_credits_minor)::text as debit_position
            from core.account_balances b join core.accounts a on a.id = b.account_id
           where a.purpose = 'merchant_payable' and b.posted_debits_minor > b.posted_credits_minor limit 20`,
  },
  {
    // Spec 6.7: available = posted - held - reserved must not be negative.
    name: 'negative_available_balance',
    sql: `with held as (
            select merchant_id, environment, currency, sum(amount_minor) as held from core.holds where state = 'active' group by 1, 2, 3),
          reserved as (
            select merchant_id, currency, sum(amount_minor) as reserved from core.reserve_entries where released_at is null group by 1, 2)
          select a.code, b.currency,
                 (b.posted_credits_minor - b.posted_debits_minor)::text as posted,
                 coalesce(h.held, 0)::text as held, coalesce(r.reserved, 0)::text as reserved
            from core.account_balances b join core.accounts a on a.id = b.account_id and a.purpose = 'merchant_payable'
            left join held h on h.merchant_id = a.merchant_id and h.environment = a.environment and h.currency = b.currency
            left join reserved r on r.merchant_id = a.merchant_id and r.currency = b.currency and a.environment = 'live'
           where (b.posted_credits_minor - b.posted_debits_minor) - coalesce(h.held, 0) < 0 limit 20`,
  },
  {
    // Idempotency in effect: one ledger effect per business event. A replay must never create a
    // second entry for the same (source, source id, kind), other than reversals.
    name: 'duplicate_posting_for_one_source_event',
    sql: `select source, source_id, kind, count(*)::text as entries from core.journal_entries
           where reverses_entry_id is null group by source, source_id, kind having count(*) > 1 limit 20`,
  },
  {
    // Spec 5.5: "Nothing posts until the gateway event is terminal", and a failed, expired or
    // cancelled payment posts nothing at all.
    name: 'payment_entry_for_a_payment_that_did_not_succeed',
    sql: `select e.ref, t.ref as transaction_ref, t.status from core.journal_entries e
            join core.transactions t on t.id = e.transaction_id
           where e.source = 'payment' and e.reverses_entry_id is null and t.status <> 'succeeded' limit 20`,
  },
  {
    // The converse: a succeeded payment that has posted exactly once.
    name: 'succeeded_payment_without_exactly_one_entry',
    sql: `select t.ref, t.environment, count(e.id)::text as entries from core.transactions t
            left join core.journal_entries e on e.transaction_id = t.id and e.source = 'payment' and e.reverses_entry_id is null
           where t.type = 'payment' and t.status = 'succeeded'
           group by t.id, t.ref, t.environment having count(e.id) <> 1 limit 20`,
  },
  {
    // Spec 6.9: nothing is posted for a settlement batch before it is paid.
    name: 'settlement_entry_before_paid',
    sql: `select b.ref, b.status, count(e.id)::text as entries from core.settlement_batches b
            join core.journal_entries e on e.source = 'settlement' and e.source_id like b.ref || ':%'
           where b.status <> 'paid' group by b.ref, b.status limit 20`,
  },
  {
    name: 'paid_settlement_without_entries',
    sql: `select b.ref, b.status from core.settlement_batches b
           where b.status = 'paid' and not exists (
             select 1 from core.journal_entries e where e.source = 'settlement' and e.source_id like b.ref || ':%') limit 20`,
  },
  {
    // Spec 6.7: a hold is captured once and released once; its end state is internally consistent.
    name: 'hold_in_two_end_states',
    sql: `select ref, state, captured_at is not null as captured, released_at is not null as released
            from core.holds
           where (captured_at is not null and released_at is not null)
              or (state = 'active' and (captured_at is not null or released_at is not null)) limit 20`,
  },
  {
    // Terminal payment states never change (spec 3.7): a terminal transaction has a completion time.
    name: 'terminal_transaction_without_completion_time',
    sql: `select ref, status from core.transactions
           where status in ('succeeded', 'failed', 'expired', 'cancelled') and completed_at is null limit 20`,
  },
  {
    // The audit chain is append-only and gap free: sequence numbers are contiguous.
    name: 'audit_sequence_gap',
    sql: `select seq, next_seq from (select seq, lead(seq) over (order by seq) as next_seq from core.audit_logs) s
           where next_seq is not null and next_seq <> seq + 1 limit 20`,
  },
];

/** Runs every invariant. An empty result means none is violated. */
export async function checkFinancialInvariants(
  superuserUrl: string,
  options: { only?: readonly string[]; skip?: readonly string[] } = {}
): Promise<Violation[]> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    // A long scan must not be cut short by the role default.
    await client.query('set statement_timeout = 0');
    const violations: Violation[] = [];
    for (const check of CHECKS) {
      if (options.only && !options.only.includes(check.name)) continue;
      if (options.skip?.includes(check.name)) continue;
      const result = await client.query(check.sql);
      if (result.rows.length > 0) {
        violations.push({ invariant: check.name, rows: result.rows as Record<string, unknown>[] });
      }
    }
    return violations;
  } finally {
    await client.end();
  }
}

export const INVARIANT_NAMES: readonly string[] = CHECKS.map((c) => c.name);

/** Trial balance per currency and environment: total debits and total credits of posted lines. */
export async function trialBalance(
  superuserUrl: string
): Promise<{ environment: string; currency: string; debits: bigint; credits: bigint }[]> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    const result = await client.query(
      `select a.environment, l.currency,
              coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)::text as debits,
              coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)::text as credits
         from core.journal_lines l join core.accounts a on a.id = l.account_id
        group by a.environment, l.currency order by 1, 2`
    );
    return result.rows.map((r) => ({
      environment: r.environment as string,
      currency: r.currency as string,
      debits: BigInt(r.debits as string),
      credits: BigInt(r.credits as string),
    }));
  } finally {
    await client.end();
  }
}
