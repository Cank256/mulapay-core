-- MulaPay Core: database roles and the `core` schema (decisions D1 and D2).
--
-- Run once per environment by a DBA or superuser, BEFORE `npm run db:migrate`:
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v rw_password="$CORE_RW_PASSWORD" -v ro_password="$CORE_RO_PASSWORD" \
--        -v statement_timeout=15s -v idle_tx_timeout=10s \
--        -f src/db/bootstrap/001_core_roles_and_schema.sql
--
-- Idempotent: safe to re-run, for example to rotate passwords.
--
-- mulapay_core_rw  full rights on schema core; no rights on gateway tables.
-- mulapay_core_ro  no rights on core; SELECT on two gateway tables, granted separately by
--                  002_gateway_read_grants.sql once the gateway's tables exist.

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE mulapay_core_rw LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mulapay_core_rw') \gexec
SELECT 'CREATE ROLE mulapay_core_ro LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mulapay_core_ro') \gexec

ALTER ROLE mulapay_core_rw WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'rw_password';
ALTER ROLE mulapay_core_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'ro_password';

-- Role-level defaults. They apply to every session, including PgBouncer server
-- connections, and back up the per-transaction values the UnitOfWork sets.
ALTER ROLE mulapay_core_rw SET statement_timeout = :'statement_timeout';
ALTER ROLE mulapay_core_rw SET idle_in_transaction_session_timeout = :'idle_tx_timeout';
ALTER ROLE mulapay_core_rw SET search_path = core;
ALTER ROLE mulapay_core_ro SET statement_timeout = :'statement_timeout';
ALTER ROLE mulapay_core_ro SET idle_in_transaction_session_timeout = :'idle_tx_timeout';
-- Defence in depth: the ro role cannot write even where a grant is widened by mistake.
ALTER ROLE mulapay_core_ro SET default_transaction_read_only = on;

SELECT format('GRANT CONNECT ON DATABASE %I TO mulapay_core_rw, mulapay_core_ro', current_database()) \gexec

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION mulapay_core_rw;
ALTER SCHEMA core OWNER TO mulapay_core_rw;
REVOKE ALL ON SCHEMA core FROM PUBLIC;

-- mulapay_core_rw must never hold rights on gateway tables in `public`. Tables grant
-- nothing to new roles by default; this revokes anything granted by hand.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mulapay_core_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mulapay_core_rw;
