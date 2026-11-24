-- Phase 4: Payouts and Refunds (P4-01)
-- Extends transactions to support disbursements (payouts) and refunds.
-- Status guards extended for payout and refund types.

-- =============================================================================
-- Payouts (Disbursements)
-- =============================================================================

CREATE TABLE "core"."payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"channel" text NOT NULL,
	"destination" jsonb NOT NULL,
	"destination_encrypted" text,
	"description" text,
	"hold_ref" text,
	"approval_ref" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_transaction_id_key" UNIQUE("transaction_id"),
	CONSTRAINT "payouts_ref_key" UNIQUE("ref"),
	CONSTRAINT "payouts_environment_check" CHECK ("core"."payouts"."environment" in ('test', 'live')),
	CONSTRAINT "payouts_ref_format_check" CHECK ("core"."payouts"."ref" ~ '^pyt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payouts_status_check" CHECK ("core"."payouts"."status" in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "payouts_amount_check" CHECK ("core"."payouts"."amount_minor" > 0),
	CONSTRAINT "payouts_channel_check" CHECK ("core"."payouts"."channel" in ('mobile_money', 'bank')),
	CONSTRAINT "payouts_idempotency_key_check" CHECK (char_length("core"."payouts"."idempotency_key") between 1 and 255),
	CONSTRAINT "payouts_currency_check" CHECK ("core"."payouts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_merchant_idempotency_key_idx" ON "core"."payouts" USING btree ("merchant_id","environment","idempotency_key");
--> statement-breakpoint
CREATE INDEX "payouts_merchant_created_idx" ON "core"."payouts" USING btree ("merchant_id","environment","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "core"."payouts" USING btree ("status") WHERE "core"."payouts"."status" in ('processing', 'pending_approval');
--> statement-breakpoint
ALTER TABLE "core"."payouts" ADD CONSTRAINT "payouts_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "core"."transaction_keys"("id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "core"."payouts" ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") NOT VALID;
--> statement-breakpoint

-- =============================================================================
-- Refunds
-- =============================================================================

CREATE TABLE "core"."refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"reason" text,
	"hold_ref" text,
	"approval_ref" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_transaction_id_key" UNIQUE("transaction_id"),
	CONSTRAINT "refunds_ref_key" UNIQUE("ref"),
	CONSTRAINT "refunds_environment_check" CHECK ("core"."refunds"."environment" in ('test', 'live')),
	CONSTRAINT "refunds_ref_format_check" CHECK ("core"."refunds"."ref" ~ '^rfd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "refunds_status_check" CHECK ("core"."refunds"."status" in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "refunds_amount_check" CHECK ("core"."refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_idempotency_key_check" CHECK (char_length("core"."refunds"."idempotency_key") between 1 and 255),
	CONSTRAINT "refunds_currency_check" CHECK ("core"."refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_reason_check" CHECK ("core"."refunds"."reason" is null or char_length("core"."refunds"."reason") between 1 and 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_merchant_idempotency_key_idx" ON "core"."refunds" USING btree ("merchant_id","environment","idempotency_key");
--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "core"."refunds" USING btree ("payment_id");
--> statement-breakpoint
CREATE INDEX "refunds_merchant_created_idx" ON "core"."refunds" USING btree ("merchant_id","environment","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "core"."refunds" USING btree ("status") WHERE "core"."refunds"."status" in ('processing', 'pending_approval');
--> statement-breakpoint
ALTER TABLE "core"."refunds" ADD CONSTRAINT "refunds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "core"."transaction_keys"("id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "core"."refunds" ADD CONSTRAINT "refunds_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "core"."refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "core"."payments"("id") NOT VALID;
--> statement-breakpoint

-- =============================================================================
-- Hand-written: Extend transaction status guards for payouts and refunds
-- =============================================================================

-- Drop existing payment-only status check
ALTER TABLE "core"."transactions" DROP CONSTRAINT IF EXISTS "transactions_status_check";

-- Add new status check that covers payments, payouts, and refunds
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_status_check" CHECK (
  (
    "type" = 'payment' AND
    "status" IN ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')
  ) OR (
    "type" = 'payout' AND
    "status" IN ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')
  ) OR (
    "type" = 'refund' AND
    "status" IN ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled')
  ) OR (
    "type" NOT IN ('payment', 'payout', 'refund')
  )
);

-- Drop existing payment-only completed_at check
ALTER TABLE "core"."transactions" DROP CONSTRAINT IF EXISTS "transactions_completed_at_check";

-- Add new completed_at check for payments, payouts, and refunds
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_completed_at_check" CHECK (
  (
    "type" = 'payment' AND
    (("status" IN ('succeeded', 'failed', 'cancelled', 'expired')) = ("completed_at" IS NOT NULL))
  ) OR (
    "type" = 'payout' AND
    (("status" IN ('succeeded', 'failed', 'cancelled', 'expired')) = ("completed_at" IS NOT NULL))
  ) OR (
    "type" = 'refund' AND
    (("status" IN ('succeeded', 'failed', 'cancelled')) = ("completed_at" IS NOT NULL))
  ) OR (
    "type" NOT IN ('payment', 'payout', 'refund')
  )
);

-- Drop existing payment-only success provider check
ALTER TABLE "core"."transactions" DROP CONSTRAINT IF EXISTS "transactions_success_provider_check";

-- Add new success provider check for payments, payouts, and refunds
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_success_provider_check" CHECK (
  (
    "type" = 'payment' AND
    ("status" <> 'succeeded' OR "provider" IS NOT NULL)
  ) OR (
    "type" = 'payout' AND
    ("status" <> 'succeeded' OR "provider" IS NOT NULL)
  ) OR (
    "type" = 'refund' AND
    ("status" <> 'succeeded' OR "provider" IS NOT NULL)
  ) OR (
    "type" NOT IN ('payment', 'payout', 'refund')
  )
);

-- =============================================================================
-- Hand-written: State transition guards for payouts
-- =============================================================================

-- Prevent invalid payout status transitions
CREATE OR REPLACE FUNCTION "core"."guard_payout_transitions"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only check on UPDATE
  IF (TG_OP = 'UPDATE' AND OLD.status <> NEW.status) THEN
    -- Terminal states cannot transition
    IF OLD.status IN ('succeeded', 'failed', 'cancelled', 'expired') THEN
      RAISE EXCEPTION 'payout status cannot change from terminal status % (payout %)', OLD.status, OLD.ref;
    END IF;

    -- created → pending_approval, processing, failed, cancelled
    IF OLD.status = 'created' AND NEW.status NOT IN ('pending_approval', 'processing', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'payout % cannot transition from created to %', OLD.ref, NEW.status;
    END IF;

    -- pending_approval → processing, cancelled
    IF OLD.status = 'pending_approval' AND NEW.status NOT IN ('processing', 'cancelled') THEN
      RAISE EXCEPTION 'payout % cannot transition from pending_approval to %', OLD.ref, NEW.status;
    END IF;

    -- processing → succeeded, failed, expired (not cancelled)
    IF OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'failed', 'expired') THEN
      RAISE EXCEPTION 'payout % cannot transition from processing to %', OLD.ref, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_payout_transitions_trigger"
BEFORE UPDATE ON "core"."payouts"
FOR EACH ROW
EXECUTE FUNCTION "core"."guard_payout_transitions"();

-- =============================================================================
-- Hand-written: State transition guards for refunds
-- =============================================================================

-- Prevent invalid refund status transitions
CREATE OR REPLACE FUNCTION "core"."guard_refund_transitions"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only check on UPDATE
  IF (TG_OP = 'UPDATE' AND OLD.status <> NEW.status) THEN
    -- Terminal states cannot transition
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'refund status cannot change from terminal status % (refund %)', OLD.status, OLD.ref;
    END IF;

    -- created → pending_approval, processing, failed, cancelled
    IF OLD.status = 'created' AND NEW.status NOT IN ('pending_approval', 'processing', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'refund % cannot transition from created to %', OLD.ref, NEW.status;
    END IF;

    -- pending_approval → processing, cancelled
    IF OLD.status = 'pending_approval' AND NEW.status NOT IN ('processing', 'cancelled') THEN
      RAISE EXCEPTION 'refund % cannot transition from pending_approval to %', OLD.ref, NEW.status;
    END IF;

    -- processing → succeeded, failed (no expired for refunds)
    IF OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'refund % cannot transition from processing to %', OLD.ref, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_refund_transitions_trigger"
BEFORE UPDATE ON "core"."refunds"
FOR EACH ROW
EXECUTE FUNCTION "core"."guard_refund_transitions"();

-- =============================================================================
-- Hand-written: Agreement triggers (keep transaction.status in sync)
-- =============================================================================

-- Payout status agreement: transaction.status = payout.status
CREATE OR REPLACE FUNCTION "core"."agree_payout_transaction_status"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status <> NEW.status) THEN
    UPDATE "core"."transactions"
    SET status = NEW.status,
        updated_at = NEW.updated_at,
        completed_at = CASE
          WHEN NEW.status IN ('succeeded', 'failed', 'cancelled', 'expired') THEN NEW.updated_at
          ELSE completed_at
        END
    WHERE id = NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agree_payout_transaction_status_trigger"
AFTER UPDATE ON "core"."payouts"
FOR EACH ROW
EXECUTE FUNCTION "core"."agree_payout_transaction_status"();

-- Refund status agreement: transaction.status = refund.status
CREATE OR REPLACE FUNCTION "core"."agree_refund_transaction_status"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status <> NEW.status) THEN
    UPDATE "core"."transactions"
    SET status = NEW.status,
        updated_at = NEW.updated_at,
        completed_at = CASE
          WHEN NEW.status IN ('succeeded', 'failed', 'cancelled') THEN NEW.updated_at
          ELSE completed_at
        END
    WHERE id = NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agree_refund_transaction_status_trigger"
AFTER UPDATE ON "core"."refunds"
FOR EACH ROW
EXECUTE FUNCTION "core"."agree_refund_transaction_status"();

-- =============================================================================
-- Grants
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON "core"."payouts" TO mulapay_core_rw;
GRANT SELECT ON "core"."payouts" TO mulapay_core_ro;

GRANT SELECT, INSERT, UPDATE ON "core"."refunds" TO mulapay_core_rw;
GRANT SELECT ON "core"."refunds" TO mulapay_core_ro;
