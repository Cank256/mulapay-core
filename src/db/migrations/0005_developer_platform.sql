-- Hand edits to what drizzle-kit generated (marked in docs/DATABASE.md):
--   * core.api_request_logs and core.webhook_deliveries are declared PARTITION BY RANGE
--     (created_at) (spec 5.1).
--   * Everything after "Hand-written" below: updated_at triggers, partitions, append-only
--     and delivery guards, revokes and the merchant permissions.
CREATE TABLE "core"."api_request_logs" (
	"id" uuid NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"route" text NOT NULL,
	"status_code" smallint NOT NULL,
	"latency_ms" integer NOT NULL,
	"request_id" text NOT NULL,
	"idempotency_key" text,
	"ip" text,
	"user_agent" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_request_logs_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "api_request_logs_environment_check" CHECK ("core"."api_request_logs"."environment" in ('test', 'live')),
	CONSTRAINT "api_request_logs_status_check" CHECK ("core"."api_request_logs"."status_code" between 100 and 599),
	CONSTRAINT "api_request_logs_latency_check" CHECK ("core"."api_request_logs"."latency_ms" >= 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "core"."merchant_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"type" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_events_environment_check" CHECK ("core"."merchant_events"."environment" in ('test', 'live')),
	CONSTRAINT "merchant_events_type_check" CHECK ("core"."merchant_events"."type" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "merchant_events_ref_format_check" CHECK ("core"."merchant_events"."ref" ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "core"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_attempts_check" CHECK ("core"."outbox"."attempts" >= 0),
	CONSTRAINT "outbox_event_type_check" CHECK ("core"."outbox"."event_type" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "outbox_published_check" CHECK ("core"."outbox"."published_at" is null or "core"."outbox"."locked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "core"."webhook_deliveries" (
	"id" uuid NOT NULL,
	"ref" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"replay_of_ref" text,
	"attempt" smallint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" smallint,
	"response_ms" integer,
	"response_body_excerpt" text,
	"error" text,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "webhook_deliveries_environment_check" CHECK ("core"."webhook_deliveries"."environment" in ('test', 'live')),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("core"."webhook_deliveries"."status" in ('pending', 'succeeded', 'failed', 'exhausted')),
	CONSTRAINT "webhook_deliveries_attempt_check" CHECK ("core"."webhook_deliveries"."attempt" between 0 and 7),
	CONSTRAINT "webhook_deliveries_pending_check" CHECK (("core"."webhook_deliveries"."status" = 'pending') = ("core"."webhook_deliveries"."next_attempt_at" is not null)),
	CONSTRAINT "webhook_deliveries_excerpt_check" CHECK ("core"."webhook_deliveries"."response_body_excerpt" is null or char_length("core"."webhook_deliveries"."response_body_excerpt") <= 1024)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "core"."webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"enabled_events" text[] NOT NULL,
	"secret_enc" text NOT NULL,
	"previous_secret_enc" text,
	"previous_secret_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_environment_check" CHECK ("core"."webhook_endpoints"."environment" in ('test', 'live')),
	CONSTRAINT "webhook_endpoints_status_check" CHECK ("core"."webhook_endpoints"."status" in ('active', 'disabled', 'auto_disabled')),
	CONSTRAINT "webhook_endpoints_url_check" CHECK (char_length("core"."webhook_endpoints"."url") between 10 and 2048),
	CONSTRAINT "webhook_endpoints_events_check" CHECK (cardinality("core"."webhook_endpoints"."enabled_events") > 0),
	CONSTRAINT "webhook_endpoints_failure_count_check" CHECK ("core"."webhook_endpoints"."failure_count" >= 0),
	CONSTRAINT "webhook_endpoints_previous_secret_check" CHECK (("core"."webhook_endpoints"."previous_secret_enc" is null) = ("core"."webhook_endpoints"."previous_secret_expires_at" is null)),
	CONSTRAINT "webhook_endpoints_disabled_check" CHECK (("core"."webhook_endpoints"."status" = 'active') = ("core"."webhook_endpoints"."disabled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD COLUMN "signing_secret_enc" text;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD COLUMN "signing_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."api_request_logs" ADD CONSTRAINT "api_request_logs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_request_logs" ADD CONSTRAINT "api_request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "core"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_events" ADD CONSTRAINT "merchant_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "core"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_merchant_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."merchant_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_request_logs_ref_key" ON "core"."api_request_logs" USING btree ("ref","created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_merchant_created_idx" ON "core"."api_request_logs" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_request_logs_request_id_idx" ON "core"."api_request_logs" USING btree ("merchant_id","request_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_events_ref_key" ON "core"."merchant_events" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "merchant_events_merchant_created_idx" ON "core"."merchant_events" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "core"."outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_available_idx" ON "core"."outbox" USING btree ("available_at") WHERE "core"."outbox"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_ref_key" ON "core"."webhook_deliveries" USING btree ("ref","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_dedupe_key" ON "core"."webhook_deliveries" USING btree ("dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_merchant_created_idx" ON "core"."webhook_deliveries" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "core"."webhook_deliveries" USING btree ("endpoint_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "core"."webhook_deliveries" USING btree ("status","next_attempt_at") WHERE "core"."webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_ref_key" ON "core"."webhook_endpoints" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_merchant_idx" ON "core"."webhook_endpoints" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST) WHERE "core"."webhook_endpoints"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_signing_check" CHECK (not "core"."api_keys"."signing_required" or "core"."api_keys"."signing_secret_enc" is not null);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Hand-written.
CREATE TRIGGER webhook_endpoints_set_updated_at BEFORE UPDATE ON core.webhook_endpoints FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER webhook_deliveries_set_updated_at BEFORE UPDATE ON core.webhook_deliveries FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Partitions: the current month and three ahead, plus a default partition as a safety net
-- (as for the journal). Retention drops partitions (spec 11), so DELETE and TRUNCATE are
-- revoked on both tables. Request logs are never updated, so UPDATE is revoked too.
DO $$
BEGIN
  PERFORM core.create_monthly_partitions('webhook_deliveries', (now() AT TIME ZONE 'UTC')::date, 4, false);
  PERFORM core.create_monthly_partitions('api_request_logs', (now() AT TIME ZONE 'UTC')::date, 4, true);
END
$$;--> statement-breakpoint
CREATE TABLE core.webhook_deliveries_default PARTITION OF core.webhook_deliveries DEFAULT;--> statement-breakpoint
CREATE TABLE core.api_request_logs_default PARTITION OF core.api_request_logs DEFAULT;--> statement-breakpoint
SELECT core.revoke_on_partitions('webhook_deliveries', 'DELETE, TRUNCATE');--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.webhook_deliveries FROM mulapay_core_rw;--> statement-breakpoint
SELECT core.revoke_on_partitions('api_request_logs', 'UPDATE, DELETE, TRUNCATE');--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.api_request_logs FROM mulapay_core_rw;--> statement-breakpoint
CREATE TRIGGER api_request_logs_append_only BEFORE UPDATE OR DELETE ON core.api_request_logs FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER api_request_logs_no_truncate BEFORE TRUNCATE ON core.api_request_logs FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Merchant events are the merchant-visible record of what happened: append-only. A foreign
-- key check takes FOR KEY SHARE on the referenced row, which Postgres only allows to a role
-- holding UPDATE on some column (see migration 0002); the trigger still refuses every update.
REVOKE UPDATE, DELETE, TRUNCATE ON core.merchant_events FROM mulapay_core_rw;--> statement-breakpoint
GRANT UPDATE (created_at) ON core.merchant_events TO mulapay_core_rw;--> statement-breakpoint
CREATE TRIGGER merchant_events_append_only BEFORE UPDATE OR DELETE ON core.merchant_events FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER merchant_events_no_truncate BEFORE TRUNCATE ON core.merchant_events FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Outbox rows are deleted by retention once published, never truncated.
REVOKE TRUNCATE ON core.outbox FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Webhook deliveries. A delivery leaves `pending` once and is then final: a replay is a new
-- delivery, so a delivered event can never be re-sent by editing a row. Identity columns
-- never change, and the endpoint, event and merchant must agree.
CREATE OR REPLACE FUNCTION core.guard_webhook_delivery() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempt <> 0 THEN
      RAISE EXCEPTION 'a webhook delivery starts pending with no attempts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM core.webhook_endpoints e
       WHERE e.id = NEW.endpoint_id AND e.merchant_id = NEW.merchant_id
         AND e.environment = NEW.environment
    ) THEN
      RAISE EXCEPTION 'webhook delivery endpoint does not belong to the merchant and environment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM core.merchant_events v
       WHERE v.id = NEW.event_id AND v.merchant_id = NEW.merchant_id
         AND v.environment = NEW.environment AND v.type = NEW.event_type
    ) THEN
      RAISE EXCEPTION 'webhook delivery event does not match the merchant, environment and type'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.replay_of_ref IS DISTINCT FROM OLD.replay_of_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook delivery identity columns never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'webhook delivery is % and final; replay it as a new delivery', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'webhook delivery attempts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER webhook_deliveries_guard BEFORE INSERT OR UPDATE ON core.webhook_deliveries FOR EACH ROW EXECUTE FUNCTION core.guard_webhook_delivery();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Webhook endpoints are soft-deleted; identity columns never change.
CREATE OR REPLACE FUNCTION core.guard_webhook_endpoint() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'webhook endpoint identity columns never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER webhook_endpoints_guard BEFORE UPDATE ON core.webhook_endpoints FOR EACH ROW EXECUTE FUNCTION core.guard_webhook_endpoint();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.webhook_endpoints FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Merchant permissions for the dashboard developer pages (spec 7.2). Keep in step with
-- src/common/authz/permissions.ts.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('webhooks:read', 'merchant', 'View webhook endpoints and deliveries'),
  ('webhooks:manage', 'merchant', 'Create, change and delete webhook endpoints; replay deliveries'),
  ('request_logs:read', 'merchant', 'View API request logs');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('owner', 'webhooks:read'), ('owner', 'webhooks:manage'), ('owner', 'request_logs:read'),
  ('admin', 'webhooks:read'), ('admin', 'webhooks:manage'), ('admin', 'request_logs:read'),
  ('developer', 'webhooks:read'), ('developer', 'webhooks:manage'), ('developer', 'request_logs:read'),
  ('support', 'webhooks:read'), ('support', 'request_logs:read'),
  ('viewer', 'webhooks:read');
