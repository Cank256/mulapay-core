# Ledger

The ledger is a double-entry, append-only journal in PostgreSQL. It is the source of truth for
what MulaPay owes each merchant and holds at each provider. Redis is never part of it. Spec
sections 5.3 to 5.5 and 6.6 to 6.8 define it; this page says what the code does and how to check
it.

## Rules that cannot be broken by application code

PostgreSQL enforces these. Each is proven by `test/integration/ledger-schema.int-spec.ts`
(by violating it with plain SQL) and, as a second line, by the independent checks in
`test/support/invariants.ts` that run after every chaos test.

| Rule                                                                  | Mechanism                                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Debits equal credits in every entry, at least two lines               | deferred constraint triggers, checked at commit                                                      |
| Amounts are positive `bigint` minor units; direction carries the sign | `CHECK (amount_minor > 0)`                                                                           |
| One currency per entry; test accounts never meet live accounts        | line trigger                                                                                         |
| Posted entries never change                                           | `UPDATE`, `DELETE`, `TRUNCATE` revoked and refused by triggers on every partition                    |
| A correction is a new reversing entry                                 | `reverses_entry_id`; one reversal per entry; a reversal is never reversed; lines mirror the original |
| `account_balances` always equals the sum of the lines                 | only the line trigger writes it                                                                      |
| One entry per idempotency key                                         | unique `journal_entry_keys.idempotency_key`                                                          |
| Entries carry the time they were posted                               | `created_at` must equal the transaction timestamp                                                    |

Known limit (finding DB-1, `docs/SECURITY.md`): the application role owns these objects, so a
holder of its credentials could disable the triggers and re-grant itself privileges. The controls
stop application bugs and SQL injection through the application's own statements; they do not stop
a compromised database credential until the owner role is separated from the application role.

## The only write path

`PostingService.postEntry(tx, ...)` is the only code that inserts into the journal tables, and
`ReversalService.reverseEntry` the only one that corrects. `postEntry` validates balance before
touching the database, resolves account codes, locks `account_balances` rows in ascending account
id order (so concurrent postings cannot deadlock), inserts the entry and lines, and returns. Every
posting carries `idempotency_key = sha256(source + ':' + sourceId)`; replaying an event is a no-op
on that unique key.

## Chart of accounts

Seeded per environment (`test` and `live` never share an account). `{provider}` is `mtn`,
`airtel` or `flutterwave`.

| Code                                | Type      | Normal | Purpose                                               |
| ----------------------------------- | --------- | ------ | ----------------------------------------------------- |
| `1000:provider_clearing:{provider}` | asset     | debit  | collected, not yet received from the provider         |
| `1010:provider_float:{provider}`    | asset     | debit  | prefunded float used for payouts                      |
| `1100:bank:{key}`                   | asset     | debit  | a platform bank account, opened per real account      |
| `1200:settlement_in_transit`        | asset     | debit  | settlement paid out, not yet confirmed                |
| `1900:fx_clearing`                  | asset     | debit  | bridge for cross-currency entries                     |
| `2000:merchant_payable:{merchant}`  | liability | credit | what the platform owes the merchant                   |
| `2010:merchant_reserve:{merchant}`  | liability | credit | rolling reserve withheld                              |
| `2100:refund_payable`               | liability | credit | refunds owed, not yet sent                            |
| `2200:tax_payable`                  | liability | credit | withheld tax                                          |
| `4000:fee_revenue`                  | revenue   | credit | MulaPay fees                                          |
| `4100:fx_revenue`                   | revenue   | credit | FX spread                                             |
| `5000:provider_fee_expense`         | expense   | debit  | provider fees                                         |
| `5100:loss_writeoff`                | expense   | debit  | reconciliation write-offs                             |
| `9000:suspense`                     | asset     | debit  | unidentified money; must be zero, alerts after 1 hour |

## Posting patterns in the code today

Nothing posts until the gateway has said `successful`. A failed, expired or cancelled operation
posts nothing and releases its hold. An unknown outcome posts nothing and never will on inference.

**Collection succeeded** (`payments/domain/collection-posting.ts`; gross `G`, MulaPay fee `F`,
provider fee `P`; `F` and `P` are zero until the fee engine exists, so today's entry is the first
two lines):

```
DR 1000:provider_clearing:{provider}   G
CR 2000:merchant_payable:{merchant}    G
DR 2000:merchant_payable:{merchant}    F      (when F > 0)
CR 4000:fee_revenue                    F
DR 5000:provider_fee_expense           P      (when P > 0)
CR 1000:provider_clearing:{provider}   P
```

**Settlement paid** (`settlement/domain/settlement-posting.ts`). Two entries, posted when the
gateway confirms the payout, never at draft, approval or release:

```
Entry 1   DR 2000:merchant_payable      P + V     (P drawn from payable, N = P + R)
          DR/CR 2010:merchant_reserve   |R - V|   (debit when R > V, credit when V > R)
          CR 1200:settlement_in_transit N
Entry 2   DR 1200:settlement_in_transit N
          CR 1010:provider_float:{provider}  N
```

Decision to confirm (open since Phase 6): entry 2 credits provider float, not `1100:bank` as spec
5.5 writes it, because the payout leaves through the gateway. The balance proof compares that
account with the gateway's own balance.

**Reversal** (`ReversalService.reverseEntry`): a new entry with every line's direction flipped and
`reverses_entry_id` set. Manual adjustments and reversals always go through approvals.

**Not built** (spec phases 3 and 4): merchant payouts and refunds as products (their postings are
specified in spec 5.5 but no service posts them), and the event consumer that will drive collection
postings from gateway events. See `docs/PRODUCTION_READINESS.md`.

## Balances

```
posted    = f(normal_balance, posted_debits, posted_credits)
held      = sum(holds where state = 'active')
reserved  = sum(reserve_entries where released_at is null)
available = posted - held - reserved
pending   = sum(payments in processing)      informational, never spendable
```

A hold is created before money leaves, captured once or released once, and expires on a schedule.
`available` is what settlement, payouts and refunds draw on, and the domain service refuses to take
a merchant payable account into a debit position.

## Investigating a discrepancy

Start with what the database can prove, read-only, as a superuser or the read replica. Each query
returns the offending rows; an empty result means the invariant holds. The same checks run in
tests (`test/support/invariants.ts`) and hourly in production (reconciliation run 2).

```sql
-- 1. Is any entry unbalanced?  (must be empty)
select entry_id, currency,
       sum(case direction when 'debit' then amount_minor else -amount_minor end) as imbalance
  from core.journal_lines group by entry_id, currency
having sum(case direction when 'debit' then amount_minor else -amount_minor end) <> 0;

-- 2. Does any balance disagree with its lines?  (must be empty)
with lines as (
  select account_id, currency,
         coalesce(sum(amount_minor) filter (where direction = 'debit'), 0)  as debits,
         coalesce(sum(amount_minor) filter (where direction = 'credit'), 0) as credits
    from core.journal_lines group by account_id, currency)
select b.account_id, b.currency, b.posted_debits_minor, l.debits, b.posted_credits_minor, l.credits
  from core.account_balances b full join lines l using (account_id, currency)
 where b.posted_debits_minor  is distinct from l.debits
    or b.posted_credits_minor is distinct from l.credits;

-- 3. Is anything in suspense?  (must be zero)
select a.environment, b.currency, b.posted_debits_minor - b.posted_credits_minor as suspense
  from core.account_balances b join core.accounts a on a.id = b.account_id
 where a.purpose = 'suspense' and b.posted_debits_minor <> b.posted_credits_minor;

-- 4. Did one business event post twice?  (must be empty)
select source, source_id, kind, count(*) from core.journal_entries
 where reverses_entry_id is null group by 1, 2, 3 having count(*) > 1;

-- 5. Everything one payment did.
select e.ref, e.kind, e.posted_at, l.line_no, a.code, l.direction, l.amount_minor
  from core.payments p
  join core.journal_entries e on e.transaction_id = p.transaction_id
  join core.journal_lines l on l.entry_id = e.id and l.created_at = e.created_at
  join core.accounts a on a.id = l.account_id
 where p.ref = $1 order by e.created_at, l.line_no;
```

If a query returns rows:

1. Do not edit anything. Posted entries cannot be updated, and a workaround that disables a
   trigger is a security incident (see FINDING DB-1).
2. Open a `sev1` incident (`core_ledger_integrity_failures` above zero pages on its own).
3. Take the entry refs from the result and read the audit trail (`GET /admin/v1/audit-logs`) for the
   request, actor and trace id that wrote them.
4. Correct with a reversing entry through the approvals workflow, never with SQL. A write-off goes to
   `5100:loss_writeoff` and needs a second approver.
5. Record the cause in the incident postmortem and add a test that reproduces it.
