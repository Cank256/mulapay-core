# Database

Status: Phase 1. Identity, merchants, roles, API keys and the audit log.

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

## Open question for Phase 2: table ownership

Decision D2 gives `mulapay_core_rw` full rights on `core`, so it owns the tables its
migrations create. Decision D5 relies on `REVOKE UPDATE, DELETE ON journal tables FROM
mulapay_core_rw` and on triggers. A table owner can re-grant itself those rights, disable
triggers and drop the table, so the revoke does not hold against a compromised rw
connection. A separate owner role for migrations, with rw holding only DML grants, would
make D5 enforceable. This needs a decision before the ledger tables are created.

The same applies to `audit_logs` since Phase 1: the revoke and the triggers stop
application code, but not an attacker holding the rw (owner) credentials.
