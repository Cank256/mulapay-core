# Database

Status: Phase 0. Tables arrive from Phase 1 onward.

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
   schema. Idempotent; re-run it to rotate passwords.

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

## Open question for Phase 2: table ownership

Decision D2 gives `mulapay_core_rw` full rights on `core`, so it owns the tables its
migrations create. Decision D5 relies on `REVOKE UPDATE, DELETE ON journal tables FROM
mulapay_core_rw` and on triggers. A table owner can re-grant itself those rights, disable
triggers and drop the table, so the revoke does not hold against a compromised rw
connection. A separate owner role for migrations, with rw holding only DML grants, would
make D5 enforceable. This needs a decision before the ledger tables are created.
