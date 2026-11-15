# Database

Status: Phase 2 plus the payment and transaction tables (migration 0003). Identity,
merchants, roles, API keys, the audit log, the ledger core (currencies, chart of accounts,
balances, journal), payments, transactions, payment links, checkout sessions and idempotency.

## Schema and roles (decisions D1, D2)

Core shares the Postgres 16+ instance with the gateway. The gateway's Knex migrations
own `public`; core's migrations own `core`. Neither touches the other's objects.

| Role              | Rights                                                                                                                                    | Used by                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `mulapay_core_rw` | Owns schema `core`. No rights on gateway tables. Cannot create schemas.                                                                   | `DATABASE_URL` (via PgBouncer), `DATABASE_DIRECT_URL` |
| `mulapay_core_ro` | `SELECT` on `public.operation_events` and `public.provider_operations` only. No access to `core`. Every transaction read-only by default. | `DATABASE_RO_URL`                                     |

Role defaults (set by the bootstrap SQL): `statement_timeout` and
`idle_in_transaction_session_timeout` for both roles, `search_path = core` for rw, and
`default_transaction_read_only = on` for ro, so a mistakenly widened grant still cannot
write.

The integration suite proves each of these against a real Postgres
(`test/integration/database.int-spec.ts`).

## Setting up an environment

Run as a DBA or superuser, in this order:

1. `src/db/bootstrap/001_core_roles_and_schema.sql`: roles, passwords, defaults, the `core`
   schema and the `citext` extension (installed into `core`; the rw role cannot create
   extensions). Idempotent; re-run it to rotate passwords, and once on databases
   bootstrapped before Phase 1 so `citext` exists.

   ```bash
   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v rw_password="$CORE_RW_PASSWORD" -v ro_password="$CORE_RO_PASSWORD" \
     -v statement_timeout=15s -v idle_tx_timeout=10s \
     -f src/db/bootstrap/001_core_roles_and_schema.sql
   ```

2. Gateway migrations (in the gateway repository).
3. `src/db/bootstrap/002_gateway_read_grants.sql`, as the gateway table owner or superuser.
   It fails if the gateway tables do not exist yet.
4. `npm run db:migrate` (or `node dist/db/migrate.js` in the image) with
   `DATABASE_DIRECT_URL`.

The local Docker stack runs step 1 automatically on first start. Steps 2 and 3 are needed
locally only once core consumes gateway events (Phase 3).

## Connections

| Pool    | URL                    | Notes                                                           |
| ------- | ---------------------- | --------------------------------------------------------------- |
| rw      | `DATABASE_URL`         | Through PgBouncer in transaction mode                           |
| ro      | `DATABASE_RO_URL`      | Gateway table reads                                             |
| replica | `DATABASE_REPLICA_URL` | Reports, analytics, admin lists; falls back to rw               |
| direct  | `DATABASE_DIRECT_URL`  | Bypasses PgBouncer: migrations and the consumer's advisory lock |

Because PgBouncer runs in transaction mode, application code must not use session state
on pooled connections: no `SET`, no session advisory locks, no `LISTEN`, no named
prepared statements. Per-transaction settings use `set_config(name, value, true)`, which
`UnitOfWork.run` does for the statement and idle timeouts.

## Migrations

- Change `src/db/schema/*.ts`, then `npm run db:generate` to write SQL into
  `src/db/migrations`. Review the SQL; it is what runs.
- Apply with `npm run db:migrate`. Do not use `drizzle-kit migrate` or `drizzle-kit push`:
  both run `CREATE SCHEMA`, which needs database-level CREATE that `mulapay_core_rw` does
  not have.
- `src/db/migrator.ts` applies pending migrations in one transaction under an advisory
  lock, and refuses to run if an applied migration's file has changed. Migrations are
  append-only; correct a mistake with a new migration.
- `0000_core_foundation.sql` replaces drizzle-kit's generated `CREATE SCHEMA "core"` with a
  check that the bootstrap created it, and adds `core.set_updated_at()`, the trigger
  function for `updated_at` columns (spec section 5).

## Phase 1 tables (migration 0001)

| Table                                      | Holds                                             | Notes                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `users`                                    | staff and merchant users                          | `email citext` unique; argon2id hash; encrypted MFA secret; lockout counters                                          |
| `sessions`                                 | one row per refresh token, grouped by `family_id` | token hash unique; partial index on live rows per user                                                                |
| `roles`, `permissions`, `role_permissions` | the authorization matrix (seeded)                 | a trigger refuses a permission of another actor type                                                                  |
| `staff_role_assignments`                   | staff role grants                                 | a trigger refuses non-staff users and merchant roles                                                                  |
| `merchants`                                | merchant profile and lifecycle status             | status, country, currency, MCC and KYC level checked; FKs to fee plans and settlement cycles arrive with those tables |
| `merchant_members`                         | team membership and role                          | unique (merchant, user); partial unique index: one active owner; a trigger refuses staff users                        |
| `invitations`                              | pending, accepted and revoked invitations         | token hash unique; partial unique index: one pending invite per (merchant, email)                                     |
| `api_keys`                                 | merchant API keys                                 | `key_id` unique; secret hash format checked; `ip_allowlist cidr[]`                                                    |
| `audit_logs`                               | the hash-chained audit trail                      | partitioned by month on `created_at`; append-only                                                                     |
| `audit_chain_head`                         | single row: last `seq` and `hash`                 | locked by every append; cannot be deleted                                                                             |

### Hand edits to the generated migration

drizzle-kit generated 0001; these edits were made by hand and are marked in the file:
`core.citext` unquoted, `audit_logs` declared `PARTITION BY RANGE (created_at)`, and
everything after the "Hand-written" marker (updated_at triggers, the append-only trigger
function, the partition function and initial partitions, revokes, actor-type triggers and
the role seed). drizzle-kit cannot express partitioning, so its snapshot records
`audit_logs` as a plain table; future `db:generate` runs still diff columns correctly.

### Audit log storage

- Monthly partitions `audit_logs_YYYYMM` from 2025-01 to three months after the migration
  ran, created by `core.create_monthly_partitions(parent, start, months, append_only)`,
  plus `audit_logs_default`. Phase 9 schedules partition creation (spec 5.1).
- `UPDATE`, `DELETE` and `TRUNCATE` are revoked from `mulapay_core_rw` on the parent and on
  every partition, and a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE`
  trigger raise. `test/integration/identity-schema.int-spec.ts` proves both.
- List queries always carry a `created_at` window (default 90 days, max 366), so the
  planner prunes partitions; plans are in [query-plans/](query-plans/README.md).

## Phase 2 tables (migration 0002)

| Table                | Holds                                                   | Notes                                                                                                  |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `currencies`         | ISO 4217 code, minor-unit exponent (spec 3.8)           | seeded with the 17 supported currencies; append-only                                                   |
| `accounts`           | the chart of accounts (spec 5.4), per environment       | unique `(environment, code)`; purpose fixes code number and type; never deleted                        |
| `account_balances`   | posted debits and credits per (account, currency)       | written only by the journal line trigger; never deleted                                                |
| `journal_entry_keys` | one row per entry: idempotency key, ref, reversed entry | unpartitioned, so the three are globally unique; written only by the entry insert trigger; append-only |
| `journal_entries`    | entry header: source, source id, transaction, reversal  | partitioned by month on `created_at`; append-only                                                      |
| `journal_lines`      | one debit or credit of a bigint amount on one account   | partitioned by month on `created_at`; append-only                                                      |

### Ledger invariants enforced by Postgres (spec 5.3, decision D5)

Each is proven by `test/integration/ledger-schema.int-spec.ts`, which violates it with
plain SQL as `mulapay_core_rw` (and as the superuser where a trigger backs a revoke).

| Invariant                                  | Mechanism                                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debits equal credits, at least two lines   | `journal_entries_balanced` and `journal_lines_balanced`: `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, checked at commit for every entry and every line                                                                                        |
| Positive bigint amounts                    | `amount_minor bigint`, `CHECK (amount_minor > 0)`; every `*_minor` column is `bigint`                                                                                                                                                                    |
| Single currency per entry                  | line trigger: line currency = entry currency; account currency (when set) = line currency                                                                                                                                                                |
| Test never touches live                    | line trigger: account environment = entry environment                                                                                                                                                                                                    |
| Merchant accounts stay with their merchant | line trigger: a merchant account only in that merchant's entries; `lines.merchant_id` copied from the account                                                                                                                                            |
| No posting to inactive accounts            | line trigger                                                                                                                                                                                                                                             |
| Entries are not back-dated                 | entry and line triggers: `created_at` (and `posted_at`) must equal `now()`, the transaction timestamp; a line's foreign key `(entry_id, created_at)` then ties it to an entry of its own transaction                                                     |
| One entry per idempotency key, unique refs | `journal_entry_keys` primary key and unique `entry_ref`, filled by the entry insert trigger; direct inserts refused                                                                                                                                      |
| Append-only journal                        | `UPDATE, DELETE, TRUNCATE` revoked on the parents and every partition; `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers raise                                                                                                                    |
| Corrections are reversals                  | `source = 'reversal'` iff `reverses_entry_id` is set; at most one reversal per entry (unique in the registry); a reversal is never reversed; same environment, currency, merchant and transaction; lines mirror the original exactly (checked at commit) |
| Balances agree with the ledger             | `account_balances` changes only from the line trigger (trigger depth 2); direct updates, non-zero inserts, deletes and truncates are refused; totals are `CHECK (>= 0)`                                                                                  |
| Chart of accounts                          | CHECKs: code format, purpose fixes number and type, normal balance follows type, scope columns (merchant, provider, bank key); merchant codes carry the merchant ref; only `name` and `active` change                                                    |
| Currency exponents never change            | `currencies` append-only                                                                                                                                                                                                                                 |

Not enforced by the database, by design: a merchant liability account going negative.
`PostingService` refuses it unless the caller passes `allowNegativeMerchantBalance`
(spec 6.4 `allow_negative_refund` needs that path), and the integrity check reports it.

### Hand edits to the generated migration

drizzle-kit generated 0002; these edits were made by hand and are marked in the file:
`journal_entries` and `journal_lines` declared `PARTITION BY RANGE (created_at)`, and
everything after the "Hand-written" marker: the id generators for seed rows
(`core.gen_uuid_v7()`, `core.gen_public_id(prefix)`), the triggers above, partitions, revokes,
the seeds, and a column grant (below). As in 0001, the snapshot records the two journal
tables as plain tables.

**`GRANT UPDATE (created_at)`** on `currencies`, `journal_entry_keys` and
`journal_entries`. A foreign key check locks the referenced row with `FOR KEY SHARE`, which
Postgres only allows to a role holding `UPDATE` on some column of that table. Without it,
inserting an account or a journal line fails with "permission denied". The append-only
triggers still refuse every `UPDATE`, so the grant opens no write path.

### Partitions and seeds

- `journal_entries` and `journal_lines` get the month the migration ran plus three ahead,
  via `core.create_monthly_partitions`, and a default partition each. Revokes apply to
  every partition. Phase 9 partition automation must create months ahead (as for
  `audit_logs`).
- Seeds: the 17 currencies, and the 15 platform and provider accounts of spec 5.4 in each
  environment. Bank accounts (`1100:bank:{key}`) are opened per real bank account with
  `AccountsService.openBankAccount`. Merchant payable and reserve accounts are opened in
  both environments in the transaction that creates the merchant; the migration backfills
  them for merchants that already existed.

## Payment and transaction tables (migration 0003)

| Table                | Holds                                                        | Notes                                                                                                                  |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `transactions`       | one row per money movement (only `payment` so far)           | partitioned by month on `created_at`; never deleted; terminal payment rows never change                                |
| `transaction_keys`   | registry: unique `ref`, unique `(type, gateway_external_id)` | filled only by the `transactions` insert trigger; append-only; lets a lookup by ref read one partition                 |
| `transaction_events` | one row per distinct event key: applied, no-op or rejected   | append-only; unique `(transaction_id, event_key)`; the merchant timeline and the reconciliation input                  |
| `payments`           | the merchant-facing charge, one per payment transaction      | shares `created_at` with its transaction (composite FK); unique `(merchant_id, environment, idempotency_key)` for ever |
| `payment_links`      | reusable links, fixed or open amount                         | `used_count <= max_uses` is a CHECK; terms never change; never deleted                                                 |
| `checkout_sessions`  | hosted-payment intent with a client secret hash              | `open -> complete \| expired`, final; one payment, set once                                                            |
| `idempotency_keys`   | request fingerprint and stored response, 24 hours            | unique `(merchant_id, environment, scope, key)`; unpartitioned; a retention job (Phase 9) deletes expired rows         |

### Invariants enforced by Postgres

`test/integration/payments-schema.int-spec.ts` violates each with plain SQL as
`mulapay_core_rw`.

| Invariant                                    | Mechanism                                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment state machine                        | `core.payment_transition_allowed(from, to)` used by BEFORE UPDATE triggers on `transactions` and `payments`; a test compares it with the domain table for all 49 pairs       |
| Terminal payments are final                  | the same triggers refuse any update to a `succeeded`, `failed`, `cancelled` or `expired` row, even one that restates its status                                              |
| A payment starts `created`                   | BEFORE INSERT triggers                                                                                                                                                       |
| A payment and its transaction agree          | deferred constraint triggers on both tables compare status, amount, currency, merchant, environment and channel at commit; a payment transaction without a payment row fails |
| Amount, currency, channel, ref never change  | update guards; `net = amount - fee`, `0 <= fee <= amount`                                                                                                                    |
| Provider and gateway ids are set once        | update guard                                                                                                                                                                 |
| `unknown` is a flag, never a status          | CHECK `outcome_unknown` only while `processing`                                                                                                                              |
| Completed means terminal                     | CHECK `completed_at` is set exactly when the status is terminal; a success needs a provider                                                                                  |
| Unique ref and external id across partitions | `transaction_keys` unique constraints                                                                                                                                        |
| One use per payer, never over `max_uses`     | CHECK on `payment_links`; `used_count` never decreases (trigger)                                                                                                             |
| Events are append-only and scoped            | triggers and revokes; an event must match its transaction's merchant and environment                                                                                         |
| Financial rows are never deleted             | `DELETE`/`TRUNCATE` revoked and refused by triggers on transactions, payments, links and sessions                                                                            |

### Hand edits to the generated migration

drizzle-kit generated 0003; these edits are marked in the file: `transactions` declared
`PARTITION BY RANGE (created_at)` (the snapshot records it as a plain table), and everything
after the "Hand-written" marker (state machine functions, triggers, partitions, revokes and
the two merchant permissions). `core.revoke_on_partitions(parent, privileges)` revokes on
every partition; Phase 9 partition automation must call it for each partition it creates, as
it must for `core.create_monthly_partitions`.

`transactions` has the same month partitions as the journal (current month and three ahead,
plus a default). `transaction_events` and `idempotency_keys` grow per transaction but are not
partitioned: events are a few rows per payment and are read by transaction id, idempotency
rows live 24 hours. Revisit both with the Phase 9 load tests.

## Holds (migration 0004)

`core.holds` (spec 5.2, 6.7), unpartitioned. Rules enforced by Postgres: a hold is placed
`active` on an active `merchant_payable` account of its own merchant, environment and
currency; amount, account, expiry and the placing key never change; `state` leaves `active`
once, each end state carries its own timestamp and key (`holds_end_state_check`); capture and
release keys are unique per environment; rows are never deleted (DELETE and TRUNCATE revoked
and refused by trigger). Hand-written part of the migration: the two guard functions, the
triggers, the revoke and the staff permissions `ledger:read`, `balances:read`, `holds:read`.

## Open question: table ownership

Still open. Decision D2 gives `mulapay_core_rw` full rights on `core`, so it owns the
tables its migrations create. A table owner can re-grant itself the revoked rights,
disable triggers and drop tables, so the revokes and triggers of migrations 0001 and 0002
stop application code and mistakes, but not an attacker holding the rw credentials.
Phase 2 builds the ledger the same way as the Phase 1 audit log, which keeps the
decision reversible: moving ownership to a separate migration role later is
`ALTER TABLE ... OWNER TO` plus a bootstrap change, with no schema rewrite. This needs a
decision before production.
