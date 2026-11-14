-- Test fixture: minimal stand-ins for the gateway-owned tables in `public`, so the
-- integration suite can prove the grants in src/db/bootstrap/002_gateway_read_grants.sql.
-- Columns follow the event contract in spec section 3.6. The real tables are created by
-- the gateway's Knex migrations; core never creates or alters them outside tests.

CREATE TABLE IF NOT EXISTS public.provider_operations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  provider_id text NOT NULL,
  operation_type text NOT NULL,
  external_id text,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.operation_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL,
  tenant_id text NOT NULL,
  provider_id text NOT NULL,
  operation_type text NOT NULL,
  external_id text NOT NULL,
  reference_id text,
  provider_transaction_id text,
  status text NOT NULL,
  previous_status text,
  amount numeric(15, 4) NOT NULL,
  currency char(3) NOT NULL,
  reason text,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
