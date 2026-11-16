# Database

Status: Phase 2, the payment and transaction tables (migration 0003), holds (0004) and the
developer platform tables (0005). Identity,
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

## Developer platform tables (migration 0005)

| Table                | Holds                                              | Notes                                                                                                           |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `merchant_events`    | the merchant-visible event log                     | append-only (revokes, triggers); `type` shape checked; index `(merchant, environment, created_at desc, ref)`    |
| `outbox`             | announcements waiting for a worker (spec 8.8)      | unique `dedupe_key`; partial index on `available_at` where unpublished; published rows are deleted by retention |
| `webhook_endpoints`  | a merchant's endpoints and their encrypted secrets | soft-deleted; `status` and `disabled_at` agree; previous secret and its expiry both or neither                  |
| `webhook_deliveries` | one row per (endpoint, event) and its attempts     | partitioned by month on `created_at`; final once it leaves `pending`; partial index `(status, next_attempt_at)` |
| `api_request_logs`   | one row per authenticated public API call, no body | partitioned by month; append-only; retention drops partitions                                                   |
| `api_keys` (changed) | `signing_secret_enc`, `signing_required`           | `signing_required` needs a signing secret (CHECK)                                                               |

### Invariants enforced by Postgres

`test/integration/developer-schema.int-spec.ts` violates each with plain SQL.

| Invariant                                                | Mechanism                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A delivery starts `pending` with no attempts             | `core.guard_webhook_delivery` (BEFORE INSERT)                                                                                                                                   |
| Endpoint, event, merchant and environment agree          | the same trigger looks the endpoint and event up                                                                                                                                |
| A delivery leaves `pending` once, then never changes     | the same trigger (BEFORE UPDATE): identity columns fixed, attempts never decrease, a non-pending row refuses every update; a replay is a new row                                |
| Pending exactly when a next attempt is set               | CHECK `webhook_deliveries_pending_check`                                                                                                                                        |
| A repeated fan-out adds nothing                          | unique `(dedupe_key, created_at)`; the fan-out uses the event's `created_at`                                                                                                    |
| Events and request logs are never changed or deleted     | `UPDATE, DELETE, TRUNCATE` revoked on the parent and every partition, plus `core.reject_mutation` triggers; `merchant_events` keeps `UPDATE (created_at)` for foreign key locks |
| Deliveries and endpoints are never deleted               | `DELETE, TRUNCATE` revoked (endpoints are soft-deleted)                                                                                                                         |
| Endpoint identity never changes                          | `core.guard_webhook_endpoint`                                                                                                                                                   |
| A disabled endpoint has a disabled time, and the reverse | CHECK `webhook_endpoints_disabled_check`                                                                                                                                        |
| An outbox row is published only after it was claimed     | CHECK `outbox_published_check`                                                                                                                                                  |
| One outbox row per business fact                         | unique `outbox_dedupe_key_key`                                                                                                                                                  |
| A key that must sign has a signing secret                | CHECK `api_keys_signing_check`                                                                                                                                                  |

### Hand edits to the generated migration

drizzle-kit generated 0005; these edits are marked in the file: `api_request_logs` and
`webhook_deliveries` declared `PARTITION BY RANGE (created_at)` (the snapshot records them as
plain tables), and everything after the "Hand-written" marker: `updated_at` triggers, the monthly
partitions (the current month and three ahead, plus a default partition each, via
`core.create_monthly_partitions`), the revokes, the append-only triggers, the delivery and
endpoint guards and the three merchant permissions with their role grants. Phase 9 partition
automation must create months ahead and call `core.revoke_on_partitions` for the new ones, as for
the other partitioned tables.

`webhook_deliveries` and `api_request_logs` refs embed their creation time: a lookup by ref reads
one partition. Retention (spec 11): both 90 days, by dropping partitions.

## Compliance tables (migration 0007)

| Table                                                           | Holds                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `kyc_profiles`, `kyc_reviews`                                   | one profile per merchant (state, submission number, expiry); every review decision, append-only |
| `kyc_documents`                                                 | object key, SHA-256, content type, size, review state; the file itself is in object storage     |
| `kyc_parties`, `merchant_profiles`                              | directors and UBOs, and the business TIN; personal fields are AES-GCM encrypted                 |
| `kyc_verifications`                                             | each check a reviewer or provider recorded, append-only                                         |
| `kyc_requirements`, `kyc_level_limits`, `merchant_limits`       | data-driven requirements by country, business type and level; limits per level and currency     |
| `aml_screenings`                                                | sanctions and PEP screenings of merchant, directors and UBOs                                    |
| `aml_rules`, `aml_rule_versions`                                | monitoring rules and their append-only change history                                           |
| `aml_alerts`, `aml_cases`, `aml_case_notes`, `aml_str_packages` | alerts with SLA, cases, notes and STR exports                                                   |
| `aml_transaction_facts`                                         | what monitoring saw of each terminal transaction, append-only                                   |
| `aml_blocklist`, `aml_blocks`, `aml_block_holds`                | blocklist entries, merchant blocks, and the holds a block placed                                |
| `disputes`                                                      | disputes and chargebacks with their hold and resolution                                         |

### Invariants enforced by Postgres

`test/integration/compliance-schema.int-spec.ts` violates each with plain SQL.

| Invariant                                                                                             | Mechanism                                                                   |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A KYC profile moves along allowed transitions; its merchant never changes                             | `core.guard_kyc_profile`                                                    |
| A document's file never changes; verified or rejected is final; removal is final                      | `core.guard_kyc_document`; CHECK that review columns agree with the status  |
| A screening's result never changes; only a potential match is decided, once                           | `core.guard_aml_screening`                                                  |
| An alert's cause never changes; a closed alert is final                                               | `core.guard_aml_alert`; CHECK that resolution columns agree with the status |
| A closed case is final, except one STR filing record                                                  | `core.guard_aml_case`; CHECK that closing columns agree with the status     |
| A blocklist entry is removed once, by timestamp; a block is lifted once                               | `core.guard_aml_blocklist`, `core.guard_aml_block`; CHECK on lifted columns |
| A dispute's subject never changes; open, under review, resolved only; resolved final                  | `core.guard_dispute`; CHECK on resolution columns                           |
| Reviews, verifications, rule versions, case notes, STR packages, facts, block holds are never changed | `UPDATE, DELETE, TRUNCATE` revoked, plus `core.reject_mutation` triggers    |
| No compliance table loses rows                                                                        | `DELETE, TRUNCATE` revoked on the other tables                              |

### Hand edits to the generated migration

drizzle-kit generated 0007. Everything after the "Hand-written part of migration 0007" marker is
by hand: the guards, `updated_at` triggers, append-only triggers, revokes, the seeds (KYC
requirements, level limits, eight AML rules **disabled**) and the staff and merchant permissions
with their role grants. The paired-column CHECKs were first too weak (a closed row could omit its
closing columns); the schema test found it and they are tightened in the generated part. Seeded
limits are placeholders for Compliance to confirm (`docs/ARCHITECTURE.md`, "Phase 7 decisions to confirm").
Encryption contexts: `merchant_profiles.tin:{merchantId}`, `kyc_parties.full_name:{ref}`,
`kyc_parties.date_of_birth:{ref}`, `kyc_parties.id_number:{ref}`.

## Open question: table ownership

Still open. Decision D2 gives `mulapay_core_rw` full rights on `core`, so it owns the
tables its migrations create. A table owner can re-grant itself the revoked rights,
disable triggers and drop tables, so the revokes and triggers of migrations 0001 and 0002
stop application code and mistakes, but not an attacker holding the rw credentials.
Phase 2 builds the ledger the same way as the Phase 1 audit log, which keeps the
decision reversible: moving ownership to a separate migration role later is
`ALTER TABLE ... OWNER TO` plus a bootstrap change, with no schema rewrite. This needs a
decision before production.
