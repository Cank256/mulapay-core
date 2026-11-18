-- Phase 3 (gateway integration): gateway_events and gateway_requests tables (spec 3.6, 5.2, 10.2).
--
-- `gateway_events` stores every event from the gateway event stream (spec 3.6), with dedupe on
-- `gateway_event_id`, processing status (`apply_status`), and retry tracking. Partitioned monthly
-- by `created_at` (when core received it), with 1-year retention (Phase 9 note).
--
-- `gateway_requests` records every HTTP call core makes to the gateway (spec 5.2): provider,
-- operation type, external_id, status, latency, error, attempt. Used for reconciliation, debugging
-- and metrics. No retention (financial audit trail).
--
-- `consumer_cursors` already exists (0008_support_operations.sql) and has the 'gateway' cursor.
-- This migration adds the retention policy row for gateway_events to `partition_policies`.

CREATE TABLE core.gateway_events (
  id bigserial NOT NULL,
  gateway_event_id uuid NOT NULL,
  -- The cursor value from the gateway's event stream; monotonic but not gapless.
  gateway_id bigint NOT NULL,
  operation_id text,
  provider_id text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('collection', 'disbursement', 'refund')),
  external_id text NOT NULL,
  reference_id text,
  provider_transaction_id text,
  status text NOT NULL CHECK (status IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')),
  previous_status text CHECK (previous_status IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')),
  amount numeric(15,4) NOT NULL,
  currency char(3) NOT NULL,
  reason text,
  -- Where the event came from: provider_response | callback | reconciliation.
  source text NOT NULL CHECK (source IN ('provider_response', 'callback', 'reconciliation')),
  -- When the event occurred at the gateway (gateway's timestamp).
  occurred_at timestamptz NOT NULL,
  -- When core received it (insert timestamp, used for partitioning).
  created_at timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  -- When the handler ran (null if not yet processed).
  processed_at timestamptz,
  -- Whether the handler succeeded, was skipped, or failed.
  apply_status text NOT NULL DEFAULT 'pending' CHECK (apply_status IN ('pending', 'applied', 'skipped', 'failed')),
  apply_error text,
  -- How many times the handler has been attempted (incremented before each attempt).
  attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT gateway_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT gateway_events_gateway_id_check CHECK (gateway_id >= 0),
  CONSTRAINT gateway_events_pkey PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);--> statement-breakpoint

-- Default partition to catch rows without a matching month partition (spec 5.1).
CREATE TABLE core.gateway_events_default PARTITION OF core.gateway_events DEFAULT;--> statement-breakpoint

-- Deduplicate on gateway_event_id; must include the partition key (created_at) because
-- PostgreSQL requires all partition columns in unique constraints on partitioned tables.
CREATE UNIQUE INDEX gateway_events_gateway_event_id_idx ON core.gateway_events (gateway_event_id, created_at);--> statement-breakpoint

-- Indexes for the event consumer and reconciliation queries.
CREATE INDEX gateway_events_gateway_id_idx ON core.gateway_events (gateway_id);--> statement-breakpoint
CREATE INDEX gateway_events_external_id_idx ON core.gateway_events (external_id, operation_type);--> statement-breakpoint
CREATE INDEX gateway_events_apply_status_idx ON core.gateway_events (apply_status) WHERE apply_status IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX gateway_events_occurred_at_idx ON core.gateway_events (occurred_at);--> statement-breakpoint

-- Trigger to prevent updates and deletes (append-only).
CREATE TRIGGER gateway_events_append_only BEFORE UPDATE OR DELETE ON core.gateway_events FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER gateway_events_no_truncate BEFORE TRUNCATE ON core.gateway_events FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint

-- Timestamp management (created_at is set by DEFAULT, updated_at doesn't exist for append-only).
-- No set_updated_at trigger because events are immutable after insert.

CREATE TABLE core.gateway_requests (
  id bigserial PRIMARY KEY,
  transaction_id uuid,
  provider text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('collection', 'disbursement', 'refund', 'query', 'balance')),
  external_id text NOT NULL,
  http_status integer,
  latency_ms integer,
  error_code text,
  -- Which retry attempt (0 for first call, 1+ for retries).
  attempt integer NOT NULL DEFAULT 0,
  -- Correlation ID for the request (from headers or generated).
  request_id text,
  created_at timestamptz NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  CONSTRAINT gateway_requests_attempt_check CHECK (attempt >= 0),
  CONSTRAINT gateway_requests_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0)
);--> statement-breakpoint

-- Indexes for reconciliation, debugging, and metrics queries.
CREATE INDEX gateway_requests_transaction_id_idx ON core.gateway_requests (transaction_id);--> statement-breakpoint
CREATE INDEX gateway_requests_external_id_idx ON core.gateway_requests (external_id);--> statement-breakpoint
CREATE INDEX gateway_requests_created_at_idx ON core.gateway_requests (created_at);--> statement-breakpoint

-- Append-only: no updates or deletes.
CREATE TRIGGER gateway_requests_append_only BEFORE UPDATE OR DELETE ON core.gateway_requests FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER gateway_requests_no_truncate BEFORE TRUNCATE ON core.gateway_requests FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint

-- Revoke destructive operations from the application role (grants additive; revokes per table).
REVOKE DELETE, TRUNCATE ON core.gateway_events FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.gateway_requests FROM mulapay_core_rw;--> statement-breakpoint

-- Add gateway_events to partition policies with 1-year retention (365 days).
-- NOTE: This table has a constraint that only allows retention on specific tables.
INSERT INTO core.partition_policies (parent, revoked_privileges, retention_days)
VALUES ('gateway_events', 'DELETE, TRUNCATE', 365);--> statement-breakpoint

-- Grant SELECT on gateway tables to read-only role.
GRANT SELECT ON core.gateway_events TO mulapay_core_ro;--> statement-breakpoint
GRANT SELECT ON core.gateway_requests TO mulapay_core_ro;--> statement-breakpoint
