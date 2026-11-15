-- Hand edits to what drizzle-kit generated (marked in docs/DATABASE.md):
--   * core.transactions is declared PARTITION BY RANGE (created_at) (spec 5.1).
--   * Everything after "Hand-written" below: transaction and payment guards, the registry,
--     partitions, revokes and the new merchant permissions.
CREATE TABLE "core"."transaction_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"event_key" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"rejection_reason" text,
	"outcome_unknown" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_events_environment_check" CHECK ("core"."transaction_events"."environment" in ('test', 'live')),
	CONSTRAINT "transaction_events_source_check" CHECK ("core"."transaction_events"."source" in ('api', 'job', 'gateway_event', 'chase')),
	CONSTRAINT "transaction_events_outcome_check" CHECK ("core"."transaction_events"."outcome" in ('applied', 'noop', 'rejected')),
	CONSTRAINT "transaction_events_key_check" CHECK (char_length("core"."transaction_events"."event_key") between 1 and 128),
	CONSTRAINT "transaction_events_rejection_check" CHECK (("core"."transaction_events"."outcome" = 'rejected') = ("core"."transaction_events"."rejection_reason" is not null)),
	CONSTRAINT "transaction_events_status_check" CHECK (("core"."transaction_events"."from_status" is null or "core"."transaction_events"."from_status" in ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')) and "core"."transaction_events"."to_status" in ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "core"."transaction_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"transaction_created_at" timestamp with time zone NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"type" text NOT NULL,
	"gateway_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_keys_ref_key" UNIQUE("ref"),
	CONSTRAINT "transaction_keys_type_external_id_key" UNIQUE("type","gateway_external_id")
);
--> statement-breakpoint
CREATE TABLE "core"."transactions" (
	"id" uuid NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text,
	"channel" text NOT NULL,
	"gateway_operation_id" uuid,
	"gateway_external_id" text,
	"gateway_reference_id" text,
	"provider_transaction_id" text,
	"failure_code" text,
	"failure_reason" text,
	"outcome_unknown" boolean DEFAULT false NOT NULL,
	"initiated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "transactions_environment_check" CHECK ("core"."transactions"."environment" in ('test', 'live')),
	CONSTRAINT "transactions_ref_format_check" CHECK ("core"."transactions"."ref" ~ '^txn_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "transactions_type_check" CHECK ("core"."transactions"."type" in ('payment', 'payout', 'refund', 'fee', 'adjustment', 'transfer', 'settlement')),
	CONSTRAINT "transactions_status_check" CHECK ("core"."transactions"."type" <> 'payment' or "core"."transactions"."status" in ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "transactions_amount_check" CHECK ("core"."transactions"."amount_minor" > 0),
	CONSTRAINT "transactions_fee_net_check" CHECK ("core"."transactions"."fee_minor" >= 0 and "core"."transactions"."fee_minor" <= "core"."transactions"."amount_minor" and "core"."transactions"."net_minor" = "core"."transactions"."amount_minor" - "core"."transactions"."fee_minor"),
	CONSTRAINT "transactions_currency_check" CHECK ("core"."transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "transactions_channel_check" CHECK ("core"."transactions"."channel" in ('mobile_money', 'card', 'bank')),
	CONSTRAINT "transactions_provider_check" CHECK ("core"."transactions"."provider" is null or "core"."transactions"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "transactions_completed_at_check" CHECK ("core"."transactions"."type" <> 'payment' or (("core"."transactions"."status" in ('succeeded', 'failed', 'cancelled', 'expired')) = ("core"."transactions"."completed_at" is not null))),
	CONSTRAINT "transactions_outcome_unknown_check" CHECK (not "core"."transactions"."outcome_unknown" or "core"."transactions"."status" = 'processing'),
	CONSTRAINT "transactions_failure_check" CHECK (("core"."transactions"."failure_code" is null or ("core"."transactions"."failure_code" ~ '^[a-z][a-z0-9_]{0,63}$' and "core"."transactions"."status" in ('failed', 'cancelled', 'expired')))
        and ("core"."transactions"."failure_reason" is null or "core"."transactions"."failure_code" is not null)),
	CONSTRAINT "transactions_success_provider_check" CHECK ("core"."transactions"."type" <> 'payment' or "core"."transactions"."status" <> 'succeeded' or "core"."transactions"."provider" is not null),
	CONSTRAINT "transactions_external_id_check" CHECK ("core"."transactions"."gateway_external_id" is null or char_length("core"."transactions"."gateway_external_id") between 1 and 128)

) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "core"."checkout_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payment_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"description" text,
	"success_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"client_secret_hash" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_payment_id_key" UNIQUE("payment_id"),
	CONSTRAINT "checkout_sessions_environment_check" CHECK ("core"."checkout_sessions"."environment" in ('test', 'live')),
	CONSTRAINT "checkout_sessions_ref_format_check" CHECK ("core"."checkout_sessions"."ref" ~ '^cs_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "checkout_sessions_status_check" CHECK ("core"."checkout_sessions"."status" in ('open', 'complete', 'expired')),
	CONSTRAINT "checkout_sessions_amount_check" CHECK ("core"."checkout_sessions"."amount_minor" > 0),
	CONSTRAINT "checkout_sessions_secret_hash_check" CHECK ("core"."checkout_sessions"."client_secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_sessions_complete_check" CHECK (("core"."checkout_sessions"."status" = 'complete') = ("core"."checkout_sessions"."completed_at" is not null)
        and ("core"."checkout_sessions"."status" <> 'complete' or "core"."checkout_sessions"."payment_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."payment_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"slug" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"success_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_environment_check" CHECK ("core"."payment_links"."environment" in ('test', 'live')),
	CONSTRAINT "payment_links_ref_format_check" CHECK ("core"."payment_links"."ref" ~ '^pl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payment_links_slug_check" CHECK ("core"."payment_links"."slug" ~ '^[a-z0-9]{12}$'),
	CONSTRAINT "payment_links_amount_check" CHECK ("core"."payment_links"."amount_minor" is null or "core"."payment_links"."amount_minor" > 0),
	CONSTRAINT "payment_links_max_uses_check" CHECK ("core"."payment_links"."max_uses" is null or "core"."payment_links"."max_uses" > 0),
	CONSTRAINT "payment_links_used_count_check" CHECK ("core"."payment_links"."used_count" >= 0 and ("core"."payment_links"."max_uses" is null or "core"."payment_links"."used_count" <= "core"."payment_links"."max_uses")),
	CONSTRAINT "payment_links_title_check" CHECK (char_length("core"."payment_links"."title") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "core"."payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"channel" text NOT NULL,
	"payment_method" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"statement_descriptor" text,
	"return_url" text,
	"payment_link_id" uuid,
	"checkout_session_id" uuid,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_transaction_id_key" UNIQUE("transaction_id"),
	CONSTRAINT "payments_environment_check" CHECK ("core"."payments"."environment" in ('test', 'live')),
	CONSTRAINT "payments_ref_format_check" CHECK ("core"."payments"."ref" ~ '^pay_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payments_status_check" CHECK ("core"."payments"."status" in ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "payments_amount_check" CHECK ("core"."payments"."amount_minor" > 0),
	CONSTRAINT "payments_channel_check" CHECK ("core"."payments"."channel" in ('mobile_money', 'card', 'bank')),
	CONSTRAINT "payments_idempotency_key_check" CHECK (char_length("core"."payments"."idempotency_key") between 1 and 255),
	CONSTRAINT "payments_statement_descriptor_check" CHECK ("core"."payments"."statement_descriptor" is null or char_length("core"."payments"."statement_descriptor") between 1 and 22),
	CONSTRAINT "payments_origin_check" CHECK ("core"."payments"."payment_link_id" is null or "core"."payments"."checkout_session_id" is null)
);
--> statement-breakpoint
CREATE TABLE "core"."idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"locked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_environment_check" CHECK ("core"."idempotency_keys"."environment" in ('test', 'live')),
	CONSTRAINT "idempotency_keys_status_check" CHECK ("core"."idempotency_keys"."status" in ('in_flight', 'completed', 'failed')),
	CONSTRAINT "idempotency_keys_key_check" CHECK (char_length("core"."idempotency_keys"."key") between 1 and 255),
	CONSTRAINT "idempotency_keys_scope_check" CHECK ("core"."idempotency_keys"."scope" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "idempotency_keys_fingerprint_check" CHECK ("core"."idempotency_keys"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_completed_check" CHECK ("core"."idempotency_keys"."status" <> 'completed' or ("core"."idempotency_keys"."response_status" is not null and "core"."idempotency_keys"."response_body" is not null))
);
--> statement-breakpoint
ALTER TABLE "core"."transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_transaction_keys_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transaction_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transaction_events" ADD CONSTRAINT "transaction_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transaction_keys" ADD CONSTRAINT "transaction_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_registry_fk" FOREIGN KEY ("id") REFERENCES "core"."transaction_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "core"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."checkout_sessions" ADD CONSTRAINT "checkout_sessions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_links" ADD CONSTRAINT "payment_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_links" ADD CONSTRAINT "payment_links_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "core"."payment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "core"."checkout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_transaction_fk" FOREIGN KEY ("transaction_id","created_at") REFERENCES "core"."transactions"("id","created_at") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_events_key_idx" ON "core"."transaction_events" USING btree ("transaction_id","event_key");--> statement-breakpoint
CREATE INDEX "transaction_events_transaction_idx" ON "core"."transaction_events" USING btree ("transaction_id","created_at","id");--> statement-breakpoint
CREATE INDEX "transaction_events_rejected_idx" ON "core"."transaction_events" USING btree ("created_at") WHERE "core"."transaction_events"."outcome" = 'rejected';--> statement-breakpoint
CREATE INDEX "transaction_keys_merchant_idx" ON "core"."transaction_keys" USING btree ("merchant_id","environment");--> statement-breakpoint
CREATE INDEX "transactions_merchant_created_idx" ON "core"."transactions" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_merchant_status_created_idx" ON "core"."transactions" USING btree ("merchant_id","environment","status","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_gateway_external_id_idx" ON "core"."transactions" USING btree ("gateway_external_id") WHERE "core"."transactions"."gateway_external_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_provider_transaction_id_idx" ON "core"."transactions" USING btree ("provider_transaction_id") WHERE "core"."transactions"."provider_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_ref_key" ON "core"."checkout_sessions" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "checkout_sessions_merchant_created_idx" ON "core"."checkout_sessions" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkout_sessions_open_expiry_idx" ON "core"."checkout_sessions" USING btree ("expires_at") WHERE "core"."checkout_sessions"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_ref_key" ON "core"."payment_links" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_slug_key" ON "core"."payment_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "payment_links_merchant_created_idx" ON "core"."payment_links" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payments_ref_key" ON "core"."payments" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "core"."payments" USING btree ("merchant_id","environment","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_merchant_created_idx" ON "core"."payments" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_created_expiry_idx" ON "core"."payments" USING btree ("expires_at") WHERE "core"."payments"."status" = 'created';--> statement-breakpoint
CREATE INDEX "payments_checkout_session_idx" ON "core"."payments" USING btree ("checkout_session_id") WHERE "core"."payments"."checkout_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_key_idx" ON "core"."idempotency_keys" USING btree ("merchant_id","environment","scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "core"."idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Hand-written from here on.
-- ---------------------------------------------------------------------------------------
-- Payment state machine (spec 6.1). The domain service in
-- src/modules/payments/domain/payment-state-machine.ts is the source of truth and checks a
-- change first; this repeats the allowed pairs so no other code path can break them. An
-- integration test compares the two for every ordered pair of statuses.
--
-- The first seven pairs are the spec 6.1 diagram. The last two (created -> cancelled and
-- created -> expired) cover a payment that was never submitted to a provider; they are
-- listed as decisions to confirm in docs/ARCHITECTURE.md.
CREATE OR REPLACE FUNCTION core.payment_transition_allowed(from_status text, to_status text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT (from_status, to_status) IN (
    ('created', 'requires_action'),
    ('created', 'processing'),
    ('requires_action', 'processing'),
    ('requires_action', 'cancelled'),
    ('processing', 'succeeded'),
    ('processing', 'failed'),
    ('processing', 'expired'),
    ('created', 'cancelled'),
    ('created', 'expired')
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.payment_status_is_terminal(status text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT status IN ('succeeded', 'failed', 'cancelled', 'expired')
$$;
--> statement-breakpoint
-- Revokes `privileges` from the application role on every partition of core.<parent>.
-- Partition automation (Phase 9) must call it for each partition it creates.
CREATE OR REPLACE FUNCTION core.revoke_on_partitions(parent text, privileges text) RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  child record;
BEGIN
  FOR child IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = format('core.%I', parent)::regclass
  LOOP
    EXECUTE format('REVOKE %s ON core.%I FROM mulapay_core_rw', privileges, child.relname);
  END LOOP;
END
$$;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Transaction partitions: the current month and three ahead, plus a default partition as a
-- safety net (as for the journal). Transactions are updated while they are in flight but
-- never deleted, so only DELETE and TRUNCATE are revoked.
DO $$
BEGIN
  PERFORM core.create_monthly_partitions('transactions', (now() AT TIME ZONE 'UTC')::date, 4, false);
END
$$;
--> statement-breakpoint
CREATE TABLE core.transactions_default PARTITION OF core.transactions DEFAULT;--> statement-breakpoint
SELECT core.revoke_on_partitions('transactions', 'DELETE, TRUNCATE');--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.transactions FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Transaction registry: global uniqueness the partitioned table cannot hold itself. Rows
-- are written only by the transactions insert trigger (trigger depth 2) and never change.
CREATE OR REPLACE FUNCTION core.guard_transaction_keys() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'core.transaction_keys is written only by transaction inserts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transaction_keys_guard BEFORE INSERT ON core.transaction_keys FOR EACH ROW EXECUTE FUNCTION core.guard_transaction_keys();--> statement-breakpoint
CREATE TRIGGER transaction_keys_append_only BEFORE UPDATE OR DELETE ON core.transaction_keys FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER transaction_keys_no_truncate BEFORE TRUNCATE ON core.transaction_keys FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.transaction_keys FROM mulapay_core_rw;--> statement-breakpoint
-- See migration 0002: a foreign key check locks the referenced row FOR KEY SHARE, which
-- needs UPDATE on some column. The append-only trigger still refuses every UPDATE.
GRANT UPDATE (created_at) ON core.transaction_keys TO mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Transactions: insert and update guards.
CREATE OR REPLACE FUNCTION core.register_transaction() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'payment' AND NEW.status <> 'created' THEN
    RAISE EXCEPTION 'a payment transaction starts in created, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.transaction_keys (id, ref, transaction_created_at, merchant_id, environment, type, gateway_external_id)
  VALUES (NEW.id, NEW.ref, NEW.created_at, NEW.merchant_id, NEW.environment, NEW.type, NEW.gateway_external_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_transaction_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.environment, NEW.type, NEW.amount_minor, NEW.currency,
      NEW.channel, NEW.gateway_external_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.environment, OLD.type, OLD.amount_minor, OLD.currency,
      OLD.channel, OLD.gateway_external_id, OLD.created_at) THEN
    RAISE EXCEPTION 'core.transactions: identity, amount, currency and channel never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.type = 'payment' THEN
    IF core.payment_status_is_terminal(OLD.status) THEN
      RAISE EXCEPTION 'core.transactions: payment % is % and cannot change', OLD.ref, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT core.payment_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'core.transactions: payment cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Identifiers learned from the provider are set once.
  IF (OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider)
     OR (OLD.gateway_operation_id IS NOT NULL AND NEW.gateway_operation_id IS DISTINCT FROM OLD.gateway_operation_id)
     OR (OLD.gateway_reference_id IS NOT NULL AND NEW.gateway_reference_id IS DISTINCT FROM OLD.gateway_reference_id)
     OR (OLD.provider_transaction_id IS NOT NULL AND NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id) THEN
    RAISE EXCEPTION 'core.transactions: provider and gateway identifiers are set once'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transactions_register BEFORE INSERT ON core.transactions FOR EACH ROW EXECUTE FUNCTION core.register_transaction();--> statement-breakpoint
CREATE TRIGGER transactions_update_guard BEFORE UPDATE ON core.transactions FOR EACH ROW EXECUTE FUNCTION core.guard_transaction_update();--> statement-breakpoint
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON core.transactions FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON core.transactions FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Transaction events: append-only, and always about a transaction of the same merchant and
-- environment.
CREATE OR REPLACE FUNCTION core.check_transaction_event() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.transaction_keys k
     WHERE k.id = NEW.transaction_id AND k.merchant_id = NEW.merchant_id AND k.environment = NEW.environment
  ) THEN
    RAISE EXCEPTION 'transaction event does not match its transaction''s merchant and environment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transaction_events_check BEFORE INSERT ON core.transaction_events FOR EACH ROW EXECUTE FUNCTION core.check_transaction_event();--> statement-breakpoint
CREATE TRIGGER transaction_events_append_only BEFORE UPDATE OR DELETE ON core.transaction_events FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER transaction_events_no_truncate BEFORE TRUNCATE ON core.transaction_events FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.transaction_events FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Payments: insert and update guards, and agreement with the transaction.
CREATE OR REPLACE FUNCTION core.check_payment_insert() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'created' THEN
    RAISE EXCEPTION 'a payment starts in created, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_payment_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.transaction_id, NEW.merchant_id, NEW.environment, NEW.amount_minor,
      NEW.currency, NEW.channel, NEW.idempotency_key, NEW.payment_link_id, NEW.checkout_session_id,
      NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.transaction_id, OLD.merchant_id, OLD.environment, OLD.amount_minor,
      OLD.currency, OLD.channel, OLD.idempotency_key, OLD.payment_link_id, OLD.checkout_session_id,
      OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'core.payments: identity, amount, currency, channel, key and expiry never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF core.payment_status_is_terminal(OLD.status) THEN
    RAISE EXCEPTION 'core.payments: payment % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT core.payment_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'core.payments: payment cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A payment and its transaction are one business object stored in two rows. This runs at
-- commit and reads both rows fresh, so several updates in one transaction are checked
-- against their final state.
CREATE OR REPLACE FUNCTION core.assert_payment_agrees(p_transaction_id uuid) RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  tx record;
  pay record;
  tx_created timestamptz;
BEGIN
  SELECT k.transaction_created_at INTO tx_created FROM core.transaction_keys k WHERE k.id = p_transaction_id;
  SELECT t.type, t.status, t.amount_minor, t.currency, t.merchant_id, t.environment, t.channel
    INTO tx FROM core.transactions t WHERE t.id = p_transaction_id AND t.created_at = tx_created;
  SELECT p.status, p.amount_minor, p.currency, p.merchant_id, p.environment, p.channel
    INTO pay FROM core.payments p WHERE p.transaction_id = p_transaction_id;
  IF tx.type IS DISTINCT FROM 'payment' THEN
    RAISE EXCEPTION 'payment row refers to transaction % which is not a payment', p_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF pay.status IS NULL THEN
    RAISE EXCEPTION 'payment transaction % has no payment row', p_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (tx.status, tx.amount_minor, tx.currency, tx.merchant_id, tx.environment, tx.channel)
     IS DISTINCT FROM
     (pay.status, pay.amount_minor, pay.currency, pay.merchant_id, pay.environment, pay.channel) THEN
    RAISE EXCEPTION 'payment and transaction % disagree on status, amount, currency, merchant, environment or channel', p_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.payment_agrees_from_payment() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM core.assert_payment_agrees(NEW.transaction_id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.payment_agrees_from_transaction() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'payment' THEN
    PERFORM core.assert_payment_agrees(NEW.id);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payments_insert_check BEFORE INSERT ON core.payments FOR EACH ROW EXECUTE FUNCTION core.check_payment_insert();--> statement-breakpoint
CREATE TRIGGER payments_update_guard BEFORE UPDATE ON core.payments FOR EACH ROW EXECUTE FUNCTION core.guard_payment_update();--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON core.payments FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON core.payments FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_agree_with_transaction AFTER INSERT OR UPDATE ON core.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.payment_agrees_from_payment();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transactions_agree_with_payment AFTER INSERT OR UPDATE ON core.transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.payment_agrees_from_transaction();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.payments FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Payment links: terms never change after creation and the counter only grows. Links are
-- deactivated, never deleted: payments refer to them.
CREATE OR REPLACE FUNCTION core.guard_payment_link_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.environment, NEW.amount_minor, NEW.currency, NEW.slug, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.environment, OLD.amount_minor, OLD.currency, OLD.slug, OLD.created_at) THEN
    RAISE EXCEPTION 'core.payment_links: amount, currency, slug and identity never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.used_count < OLD.used_count THEN
    RAISE EXCEPTION 'core.payment_links: used_count never decreases'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payment_links_update_guard BEFORE UPDATE ON core.payment_links FOR EACH ROW EXECUTE FUNCTION core.guard_payment_link_update();--> statement-breakpoint
CREATE TRIGGER payment_links_no_delete BEFORE DELETE ON core.payment_links FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER payment_links_no_truncate BEFORE TRUNCATE ON core.payment_links FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.payment_links FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Checkout sessions: open -> complete | expired, both final. The payment is set once.
CREATE OR REPLACE FUNCTION core.guard_checkout_session_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.environment, NEW.amount_minor, NEW.currency,
      NEW.client_secret_hash, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.environment, OLD.amount_minor, OLD.currency,
      OLD.client_secret_hash, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'core.checkout_sessions: amount, currency, secret, expiry and identity never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'core.checkout_sessions: session % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
    RAISE EXCEPTION 'core.checkout_sessions: the payment is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_update_guard BEFORE UPDATE ON core.checkout_sessions FOR EACH ROW EXECUTE FUNCTION core.guard_checkout_session_update();--> statement-breakpoint
CREATE TRIGGER checkout_sessions_no_delete BEFORE DELETE ON core.checkout_sessions FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER checkout_sessions_no_truncate BEFORE TRUNCATE ON core.checkout_sessions FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.checkout_sessions FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Idempotency keys: updated_at only. Expired rows are deleted by a retention job (Phase 9),
-- so DELETE stays granted.
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON core.idempotency_keys FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Merchant permissions for the dashboard payment and transaction lists (spec 7.2). Every
-- team role may read them. Keep in step with src/common/authz/permissions.ts.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('payments:read', 'merchant', 'View payments and payment links'),
  ('transactions:read', 'merchant', 'View transactions');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('owner', 'payments:read'), ('owner', 'transactions:read'),
  ('admin', 'payments:read'), ('admin', 'transactions:read'),
  ('developer', 'payments:read'), ('developer', 'transactions:read'),
  ('finance', 'payments:read'), ('finance', 'transactions:read'),
  ('support', 'payments:read'), ('support', 'transactions:read'),
  ('viewer', 'payments:read'), ('viewer', 'transactions:read');
