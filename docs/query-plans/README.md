# Query plans

Committed `EXPLAIN (ANALYZE, BUFFERS)` output for every hot query (spec 9.2 rule 7 and
section 16). Each phase adds a `phaseN.sql` script and its `phaseN.txt` output.

A script seeds synthetic rows inside a transaction, runs `ANALYZE`, explains each query,
and rolls back, so it can run against any freshly migrated database:

```bash
psql "postgres://mulapay_core_rw:...@localhost:5433/mulapay" -f docs/query-plans/phase1.sql > docs/query-plans/phase1.txt
```

## Phase 1 ([phase1.sql](phase1.sql), [phase1.txt](phase1.txt))

| Query                                     | Index used                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| API key authentication by `key_id`        | `api_keys_key_id_key`, then `merchants_pkey`                      |
| Dashboard principal resolution (per call) | `users_ref_key`, `merchant_members_user_idx`, `merchants_pkey`    |
| Refresh-token rotation                    | `sessions_refresh_token_hash_key`                                 |
| Active sessions of a user                 | `sessions_user_active_idx` (partial, `revoked_at is null`)        |
| Session family revocation                 | `sessions_family_idx`                                             |
| Merchant API key list                     | `api_keys_merchant_revoked_idx`                                   |
| Admin merchant list, keyset page          | `merchants_status_created_idx`, `merchants_created_idx`           |
| Admin audit list, 90-day window           | per-partition `merchant_id, created_at` index; pruned to 4 months |

Seed sizes: 20k merchants, 60k users, 200k sessions, 40k API keys, 200k audit rows.

## Phase 2 ([phase2.sql](phase2.sql), [phase2.txt](phase2.txt))

| Query                                          | Index used                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Posting: idempotency key lookup                | `journal_entry_keys_pkey`                                                       |
| Reversal: entry by public ref                  | `journal_entry_keys_entry_ref_key`                                              |
| Posting: resolve account codes                 | `accounts_environment_code_key`                                                 |
| Posting: lock balance rows in account id order | `account_balances_account_id_currency_pk`                                       |
| Entry lines by (entry id, created_at)          | per-partition `journal_lines` pkey; other partitions pruned at run time         |
| Merchant close: any non-zero live balance      | `accounts_merchant_idx`, then `account_balances` pkey                           |
| Merchant balances in one environment           | `accounts_merchant_idx`, then `account_balances` pkey                           |
| Account lines, newest first, 90-day window     | per-partition `journal_lines_account_created_idx`; out-of-window months pruned  |
| Merchant lines, newest first, 90-day window    | per-partition `journal_lines_merchant_created_idx`; out-of-window months pruned |
| Integrity: invalid entries in a window         | scans the window's partitions only (a full read of the window is the point)     |

Seed sizes: 2k merchants (8k accounts), 100k entries and 200k lines, inserted through the
ledger triggers. The balance-agreement integrity query recomputes every account from all
lines and is a full scan by design; it runs on a schedule (Phase 6), not per request.

## Payments and transactions ([phase4.sql](phase4.sql), [phase4.txt](phase4.txt))

| Query                                           | Index used                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Payment by ref with its transaction             | `payments_ref_key`, then the transaction primary key in one partition (the rest never executed)                      |
| Payments list, first page and keyset page       | `payments_merchant_created_idx`, 26 rows, then 26 primary-key probes                                                 |
| Transactions list, first page                   | per-partition `transactions_merchant_created_idx` under Merge Append, stopping at the limit                          |
| Transactions list, keyset page, status filter   | the same indexes; at this seed size the planner sorts the 1 to 3 thousand matching rows instead                      |
| Transactions by reference                       | per-partition indexes on `gateway_external_id`, `provider_transaction_id` or the merchant index                      |
| Transaction by ref                              | `transaction_keys_ref_key`, then one partition by primary key                                                        |
| Lifecycle locks (payment, transaction)          | `payments_pkey`, then the transaction primary key in one partition                                                   |
| Timeline, event dedupe                          | `transaction_events_transaction_idx`, `transaction_events_key_idx`                                                   |
| Idempotency claim                               | `idempotency_keys_key_idx`                                                                                           |
| Expiry sweeps                                   | partial `payments_created_expiry_idx`, partial `checkout_sessions_open_expiry_idx`                                   |
| Link by ref and slug, link list, session by ref | `payment_links_ref_key`, `payment_links_slug_key`, `payment_links_merchant_created_idx`, `checkout_sessions_ref_key` |

Seed sizes: 2k merchants, 60k payments (one merchant has 6k) spread over 80 days across four
monthly partitions, 140k events, 20k links, 20k sessions, 60k idempotency keys.

Two findings from the first run changed the code:

- **`ORDER BY created_at DESC` does not match a `DESC NULLS LAST` index.** Postgres read the
  whole 90-day window and sorted it (6,000 rows for a 26-row page). The queries now say
  `NULLS LAST` (`src/common/pagination/keyset.ts`); the first page reads 26 rows from the
  newest partition and one from each older one. Phase 1 and 2 lists that use drizzle's
  `desc()` have the same mismatch; they are small tables, but re-check them in Phase 9.
- **A keyset cursor written as one `OR`, or as a row comparison, makes the planner sort.**
  The condition is now `created_at <= cursor AND (created_at < cursor OR ref < cursor_ref)`.
- `transactions_merchant_status_created_idx` gained `ref desc` so a status-filtered list can
  be served in order.

## Developer platform ([phase5.sql](phase5.sql), [phase5.txt](phase5.txt))

| Query                                         | Index used                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key authentication by `key_id`            | `api_keys_key_id_key`, then `merchants_pkey` (0.09 ms; the Redis cache sits in front of it)                                                      |
| Outbox claim (`FOR UPDATE SKIP LOCKED`)       | partial `outbox_available_idx`, bitmap scan of the unpublished rows, top-50 sort (2.6 ms with 600 due rows)                                      |
| Fan-out: active endpoints of a merchant       | partial `webhook_endpoints_merchant_idx`                                                                                                         |
| Event feed, first page; event by ref          | `merchant_events_merchant_created_idx` (26 rows); `merchant_events_ref_key`                                                                      |
| Overdue pending deliveries (recovery sweep)   | per-partition partial `(status, next_attempt_at)` indexes; see the note below                                                                    |
| Delivery by ref, lease, fan-out dedupe lookup | one partition only, through `(ref, created_at)` and `(dedupe_key, created_at)`: the others are pruned                                            |
| Delivery log, first page, 90-day window       | per-partition `(merchant_id, environment, created_at desc, ref desc)` indexes; partitions outside the window pruned                              |
| Request log, first page; by request id        | Merge Append over the per-partition merchant indexes (26 rows) and one probe of `api_keys_pkey` per row; `(merchant_id, request_id, created_at)` |

Seed sizes: 2k merchants, 40k API keys, 20k endpoints, 100k events, about 100k deliveries over
four monthly partitions, 200k request logs, 60k outbox rows.

Note on the recovery sweep: the seed leaves 5% of deliveries pending and overdue (about 5,000
rows), so the top-N sort over them takes 88 ms. In production the sweep runs every second and
re-queues what it finds, so the overdue set stays near zero; the query is bounded by `LIMIT 200`
and a 30-day lookback. Re-check it with the Phase 9 load tests if a worker outage can leave
thousands overdue.

## Phase 9 ([phase9.sql](phase9.sql), [phase9.txt](phase9.txt))

Run as the database superuser (it switches `session_replication_role` to seed quickly). It seeds
about a million rows: 2k merchants, 600,000 transactions over 80 days (one merchant has 30,000),
120,000 holds, 360,000 daily rollups, 200,000 notifications and deliveries, 50,000 reconciliation
exceptions, 300,000 idempotency keys and 300,000 outbox rows. Planner settings are PostgreSQL
defaults with `shared_buffers = 256MB`. Timings come from a shared development machine and move
run to run; the plan shapes, the buffer counts and the WAL bytes do not.

**How the hot queries were found.** The whole suite was run once with `pg_stat_statements`
(`PG_STAT_STATEMENTS=1`), which recorded 6,941 statements. The calls and total time of each, by
table, pointed at: `account_balances`, `payments` and `transactions` reads and locks,
`audit_chain_head`, `idempotency_keys`, `outbox`, `holds`. Most slow means were `FOR UPDATE` waits on
primary keys in the concurrency tests (3 to 5 buffer hits per call, no reads), not bad plans. One
was structural and is a finding: `audit_chain_head` (see `docs/SECURITY.md` PERF-2).

| Query                                                                   | Plan                                                                                                                   | ms         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| Balances: accounts by code, holds sum, pending sum (A1 to A4)           | `accounts_environment_code_key`, `holds_merchant_active_idx`, `transactions_merchant_status_created_idx` per partition | 0.6 to 8.6 |
| Transactions first page at 600k rows (A5)                               | per-partition `transactions_merchant_created_idx`, Merge Append                                                        | 6.6        |
| Dashboard overview: 30 days of rollups (A6)                             | `daily_merchant_rollups` unique index                                                                                  | 0.2        |
| Settlement period totals, active holds, hold expiry (A8 to A10)         | merchant index bitmap scan; two partial hold indexes                                                                   | 0.1 to 37  |
| Exception queue, dedupe update, run lookup (A11 to A13)                 | partial indexes; the queue's first run was 20 ms cold, 3 ms warm                                                       | 0.1 to 3.3 |
| Notifications: unread count, inbox, dedupe, delivery sweep (A14 to A17) | partial and composite indexes; sweep reads each partition's partial index                                              | 0.7 to 30  |
| AML velocity rebuild, suspense check (A18, A19)                         | merchant status index; `accounts_purpose_idx`                                                                          | 0.8 to 3   |
| Idempotency purge, outbox purge, outbox claim (C1 to C3)                | `idempotency_keys_expires_idx`; `outbox_pkey` range; `outbox_available_idx`                                            | 0.3 to 55  |

The empty future partitions show as `Seq Scan` at cost 0.00: they hold no rows. Pruning is real:
`Subplans Removed` appears on every windowed query, and C5 shows a 30-day window reading only the
partitions it spans.

### Findings and the decisions they led to

| #   | Finding                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                    | Decision                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No index serves `status = 'processing'` across merchants. The gateway gap run, the stuck-transaction monitor and the stuck list each scan every partition of their window. | B1 to B3: 13, 47 and 41 ms before; 0.7, 0.16 and 0.13 ms after, at 600k rows. The scan cost grows with the table; the indexed cost grows with the number of in-flight payments.                                                                             | **Added** `transactions_processing_idx`, a partial index of in-flight rows only (migration 0010). WAL for the full payment lifecycle: 105.5 MB against 113.0 MB without it (-6.7%, inside noise): indexed rows leave the index as they finish.                                                                                                                       |
| 2   | The nightly rollup recompute reads the whole 35-day window, filtering on `coalesce(completed_at, updated_at)`, which no index can serve.                                   | A7: 460 ms before, 15 ms with an expression index on final rows.                                                                                                                                                                                            | **Not added.** The index covers every completed payment: WAL 136.5 MB against 113.0 MB (+20.8%) on the hottest financial table, for a job that runs once a day and is far under its timeout today. Revisit when one day's window exceeds about 5 million rows or the job nears the 15 s statement timeout; the index and its measurement are in the script (B2, B3). |
| 3   | Outbox purge as a plain `published_at < cutoff` scan reads the whole primary key to find nothing once the backlog is gone.                                                 | C2 and C2b/C2c. Outbox ids are UUID v7, so `id < bound(cutoff)` is a primary-key range. C2b and C2c are both inflated by the 89,000 dead rows the preceding DELETE left in the same transaction; the bounded form still reads about a third of the buffers. | Used the bounded form (`uuidTimeBound`); **no new index** on the outbox, which is write-heavy.                                                                                                                                                                                                                                                                       |
| 4   | `partition_status` and `partitions_due_for_retention` read the catalogue.                                                                                                  | C4: 15 ms and 520 ms cold, 1.9 ms warm.                                                                                                                                                                                                                     | Run every 6 hours and on `/metrics` scrapes: acceptable. The scrape refresh is cheap once cached.                                                                                                                                                                                                                                                                    |
| 5   | Phase 4 asked for the Phase 1 and 2 lists that use drizzle's `desc()` to be re-checked against `NULLS LAST` indexes.                                                       | Not re-planned. None of those statements was among the slow ones in the capture (they are small tables), which is absence of evidence, not a plan.                                                                                                          | **Still open**, low priority.                                                                                                                                                                                                                                                                                                                                        |

Re-running the script on a database that already has migration 0010 is safe: it drops the index
inside its own transaction to measure "before" and rolls back.
