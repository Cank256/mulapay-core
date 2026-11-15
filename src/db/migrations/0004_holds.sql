-- Hand edits to what drizzle-kit generated (marked in docs/DATABASE.md): everything after
-- "Hand-written" below, i.e. the hold guards and the revokes.
CREATE TABLE "core"."holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"transaction_id" uuid,
	"expires_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"capture_key" text,
	"release_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holds_environment_check" CHECK ("core"."holds"."environment" in ('test', 'live')),
	CONSTRAINT "holds_ref_format_check" CHECK ("core"."holds"."ref" ~ '^hold_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "holds_amount_check" CHECK ("core"."holds"."amount_minor" > 0),
	CONSTRAINT "holds_state_check" CHECK ("core"."holds"."state" in ('active', 'captured', 'released', 'expired')),
	CONSTRAINT "holds_reason_check" CHECK (char_length("core"."holds"."reason") between 1 and 200),
	CONSTRAINT "holds_idempotency_key_check" CHECK (char_length("core"."holds"."idempotency_key") between 1 and 128),
	CONSTRAINT "holds_created_by_check" CHECK ("core"."holds"."created_by" ~ '^(user|api_key|system|job):[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "holds_end_state_check" CHECK (("core"."holds"."state" = 'captured') = ("core"."holds"."captured_at" is not null and "core"."holds"."capture_key" is not null)
        and ("core"."holds"."state" = 'released') = ("core"."holds"."released_at" is not null and "core"."holds"."release_key" is not null)
        and ("core"."holds"."state" = 'expired') = ("core"."holds"."expired_at" is not null)
        and ("core"."holds"."capture_key" is null or "core"."holds"."state" = 'captured')
        and ("core"."holds"."release_key" is null or "core"."holds"."state" = 'released')),
	CONSTRAINT "holds_expiry_check" CHECK ("core"."holds"."expires_at" is null or "core"."holds"."expires_at" > "core"."holds"."created_at")
);
--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holds_ref_key" ON "core"."holds" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_idempotency_key_key" ON "core"."holds" USING btree ("environment","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_capture_key_key" ON "core"."holds" USING btree ("environment","capture_key") WHERE "core"."holds"."capture_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "holds_release_key_key" ON "core"."holds" USING btree ("environment","release_key") WHERE "core"."holds"."release_key" is not null;--> statement-breakpoint
CREATE INDEX "holds_merchant_active_idx" ON "core"."holds" USING btree ("merchant_id","environment","currency") WHERE "core"."holds"."state" = 'active';--> statement-breakpoint
CREATE INDEX "holds_expiry_idx" ON "core"."holds" USING btree ("expires_at") WHERE "core"."holds"."state" = 'active' and "core"."holds"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "holds_transaction_idx" ON "core"."holds" USING btree ("transaction_id") WHERE "core"."holds"."transaction_id" is not null;
--> statement-breakpoint
-- Hand-written ---------------------------------------------------------------------------
-- Holds: insert and update guards (spec 6.7). A hold is placed active, on a merchant payable
-- account of its own merchant and environment, and ends exactly once.
CREATE OR REPLACE FUNCTION core.check_hold_insert() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  acct record;
BEGIN
  IF NEW.state <> 'active' THEN
    RAISE EXCEPTION 'a hold starts active, not %', NEW.state USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.purpose, a.merchant_id, a.environment, a.currency, a.active INTO acct
    FROM core.accounts a WHERE a.id = NEW.account_id;
  IF acct.purpose IS DISTINCT FROM 'merchant_payable'
     OR acct.merchant_id IS DISTINCT FROM NEW.merchant_id
     OR acct.environment IS DISTINCT FROM NEW.environment
     OR (acct.currency IS NOT NULL AND acct.currency <> NEW.currency)
     OR NOT acct.active THEN
    RAISE EXCEPTION 'a hold reserves against an active payable account of its own merchant, environment and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_hold_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.environment, NEW.account_id, NEW.currency,
      NEW.amount_minor, NEW.reason, NEW.transaction_id, NEW.expires_at, NEW.idempotency_key,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.environment, OLD.account_id, OLD.currency,
      OLD.amount_minor, OLD.reason, OLD.transaction_id, OLD.expires_at, OLD.idempotency_key,
      OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'core.holds: identity, amount, account, currency, expiry and key never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'core.holds: hold % is % and cannot change', OLD.ref, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER holds_insert_check BEFORE INSERT ON core.holds FOR EACH ROW EXECUTE FUNCTION core.check_hold_insert();--> statement-breakpoint
CREATE TRIGGER holds_update_guard BEFORE UPDATE ON core.holds FOR EACH ROW EXECUTE FUNCTION core.guard_hold_update();--> statement-breakpoint
CREATE TRIGGER holds_no_delete BEFORE DELETE ON core.holds FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER holds_no_truncate BEFORE TRUNCATE ON core.holds FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.holds FROM mulapay_core_rw;--> statement-breakpoint
-- Staff permissions for the admin ledger, balance and hold reads (spec 7.3). Keep in step
-- with src/common/authz/permissions.ts.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('ledger:read', 'staff', 'Read accounts, journal entries, statements, the trial balance and integrity'),
  ('balances:read', 'staff', 'Read merchant balances'),
  ('holds:read', 'staff', 'Read holds');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('super_admin', 'ledger:read'), ('super_admin', 'balances:read'), ('super_admin', 'holds:read'),
  ('operations', 'ledger:read'), ('operations', 'balances:read'), ('operations', 'holds:read'),
  ('compliance', 'ledger:read'), ('compliance', 'balances:read'), ('compliance', 'holds:read'),
  ('auditor', 'ledger:read'), ('auditor', 'balances:read'), ('auditor', 'holds:read'),
  ('support_agent', 'balances:read'), ('support_agent', 'holds:read');
