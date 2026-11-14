-- MulaPay Core: read access to the gateway's event tables (decisions D2 and D3).
--
-- Run by the gateway table owner or a superuser AFTER the gateway's Knex migrations have
-- created these tables, and after 001_core_roles_and_schema.sql:
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/bootstrap/002_gateway_read_grants.sql
--
-- Fails loudly if a table does not exist. Never widen these grants: core must not be able
-- to write gateway-owned tables (spec section 17, rule 6).

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO mulapay_core_ro;
GRANT SELECT ON public.operation_events, public.provider_operations TO mulapay_core_ro;
