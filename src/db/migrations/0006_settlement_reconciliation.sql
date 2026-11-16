-- Hand edits to what drizzle-kit generated (marked in docs/DATABASE.md): everything after
-- "Hand-written" below: the merchant foreign key, the settlement transaction rules, the
-- state guards, the append-only rules, the grants and the permissions.
CREATE TABLE "core"."reserve_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"hold_until" timestamp with time zone NOT NULL,
	"settlement_batch_id" uuid NOT NULL,
	"release_batch_id" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reserve_entries_amount_check" CHECK ("core"."reserve_entries"."amount_minor" > 0),
	CONSTRAINT "reserve_entries_release_check" CHECK ("core"."reserve_entries"."released_at" is null or "core"."reserve_entries"."release_batch_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "core"."rolling_reserves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"percent_bps" integer NOT NULL,
	"hold_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rolling_reserves_bps_check" CHECK ("core"."rolling_reserves"."percent_bps" between 0 and 10000),
	CONSTRAINT "rolling_reserves_days_check" CHECK ("core"."rolling_reserves"."hold_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_batch_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"kind" text NOT NULL,
	"event_key" text,
	"actor" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"run_id" uuid,
	"environment" text DEFAULT 'live' NOT NULL,
	"currency" char(3) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"gross_minor" bigint NOT NULL,
	"refund_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"reserve_minor" bigint NOT NULL,
	"reserve_release_minor" bigint NOT NULL,
	"dispute_hold_minor" bigint NOT NULL,
	"aml_hold_minor" bigint NOT NULL,
	"shortfall_minor" bigint NOT NULL,
	"payable_draw_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"min_payout_minor" bigint NOT NULL,
	"reserve_hold_days" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"destination_id" uuid,
	"destination_fingerprint" text,
	"provider" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"payout_ref" text,
	"payout_transaction_id" uuid,
	"hold_id" uuid,
	"released_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failure_code" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_batches_ref_format_check" CHECK (ref ~ '^stl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "settlement_batches_live_check" CHECK ("core"."settlement_batches"."environment" = 'live'),
	CONSTRAINT "settlement_batches_status_check" CHECK ("core"."settlement_batches"."status" in ('draft', 'pending_approval', 'approved', 'releasing', 'paid', 'failed', 'cancelled')),
	CONSTRAINT "settlement_batches_period_check" CHECK ("core"."settlement_batches"."period_end" > "core"."settlement_batches"."period_start"),
	CONSTRAINT "settlement_batches_amounts_check" CHECK ("core"."settlement_batches"."gross_minor" >= 0 and "core"."settlement_batches"."refund_minor" >= 0 and "core"."settlement_batches"."fee_minor" >= 0
        and "core"."settlement_batches"."reserve_minor" >= 0 and "core"."settlement_batches"."reserve_release_minor" >= 0
        and "core"."settlement_batches"."dispute_hold_minor" >= 0 and "core"."settlement_batches"."aml_hold_minor" >= 0 and "core"."settlement_batches"."shortfall_minor" >= 0
        and "core"."settlement_batches"."payable_draw_minor" >= 0 and "core"."settlement_batches"."min_payout_minor" >= 0),
	CONSTRAINT "settlement_batches_net_check" CHECK ("core"."settlement_batches"."net_minor" = "core"."settlement_batches"."payable_draw_minor" + "core"."settlement_batches"."reserve_release_minor"),
	CONSTRAINT "settlement_batches_min_payout_check" CHECK ("core"."settlement_batches"."net_minor" > 0 and "core"."settlement_batches"."net_minor" >= "core"."settlement_batches"."min_payout_minor"),
	CONSTRAINT "settlement_batches_approval_check" CHECK (("core"."settlement_batches"."status" not in ('approved', 'releasing', 'paid') or ("core"."settlement_batches"."approved_by" is not null and "core"."settlement_batches"."approved_at" is not null))
        and ("core"."settlement_batches"."approved_by" is null or "core"."settlement_batches"."submitted_by" is null or "core"."settlement_batches"."approved_by" <> "core"."settlement_batches"."submitted_by")),
	CONSTRAINT "settlement_batches_release_check" CHECK (("core"."settlement_batches"."status" not in ('releasing', 'paid') or ("core"."settlement_batches"."payout_ref" is not null and "core"."settlement_batches"."payout_transaction_id" is not null and "core"."settlement_batches"."released_at" is not null))
        and ("core"."settlement_batches"."status" <> 'paid' or "core"."settlement_batches"."paid_at" is not null)),
	CONSTRAINT "settlement_batches_provider_check" CHECK ("core"."settlement_batches"."provider" is null or "core"."settlement_batches"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "settlement_batches_payout_ref_format_check" CHECK (payout_ref is null or payout_ref ~ '^po_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"currency" char(3) NOT NULL,
	"delay_days" smallint NOT NULL,
	"cutoff_time" text NOT NULL,
	"timezone" text NOT NULL,
	"min_payout_minor" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_cycles_ref_format_check" CHECK (ref ~ '^scy_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "settlement_cycles_delay_check" CHECK ("core"."settlement_cycles"."delay_days" between 0 and 90),
	CONSTRAINT "settlement_cycles_cutoff_check" CHECK ("core"."settlement_cycles"."cutoff_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "settlement_cycles_min_payout_check" CHECK ("core"."settlement_cycles"."min_payout_minor" >= 0),
	CONSTRAINT "settlement_cycles_name_length_check" CHECK (char_length("core"."settlement_cycles"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text NOT NULL,
	"channel" text DEFAULT 'mobile_money' NOT NULL,
	"details_enc" text NOT NULL,
	"display" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "settlement_destinations_ref_format_check" CHECK (ref ~ '^sd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "settlement_destinations_provider_check" CHECK ("core"."settlement_destinations"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "settlement_destinations_channel_check" CHECK ("core"."settlement_destinations"."channel" = 'mobile_money'),
	CONSTRAINT "settlement_destinations_status_check" CHECK ("core"."settlement_destinations"."status" in ('active', 'retired')),
	CONSTRAINT "settlement_destinations_retired_check" CHECK (("core"."settlement_destinations"."status" = 'retired') = ("core"."settlement_destinations"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"transaction_id" uuid,
	"transaction_ref" text,
	"kind" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_items_kind_check" CHECK ("core"."settlement_items"."kind" in ('payment', 'refund', 'reserve_withheld', 'reserve_released', 'dispute_hold', 'aml_hold')),
	CONSTRAINT "settlement_items_amount_check" CHECK ("core"."settlement_items"."amount_minor" > 0 and "core"."settlement_items"."fee_minor" >= 0),
	CONSTRAINT "settlement_items_net_check" CHECK ("core"."settlement_items"."net_minor" = "core"."settlement_items"."amount_minor" - "core"."settlement_items"."fee_minor" and "core"."settlement_items"."fee_minor" <= "core"."settlement_items"."amount_minor"),
	CONSTRAINT "settlement_items_transaction_check" CHECK (("core"."settlement_items"."kind" in ('payment', 'refund')) = ("core"."settlement_items"."transaction_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."settlement_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"cycle_id" uuid NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"triggered_by" text NOT NULL,
	"merchants_considered" integer DEFAULT 0 NOT NULL,
	"batches_created" integer DEFAULT 0 NOT NULL,
	"rolled_over" integer DEFAULT 0 NOT NULL,
	"nothing_to_settle" integer DEFAULT 0 NOT NULL,
	"failed_merchants" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_runs_ref_format_check" CHECK (ref ~ '^srun_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "settlement_runs_status_check" CHECK ("core"."settlement_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "settlement_runs_finished_check" CHECK (("core"."settlement_runs"."status" = 'running') = ("core"."settlement_runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."provider_statement_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"provider_ref" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matched_transaction_id" uuid,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"match_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_statement_rows_amount_check" CHECK ("core"."provider_statement_rows"."amount_minor" > 0),
	CONSTRAINT "provider_statement_rows_status_check" CHECK ("core"."provider_statement_rows"."match_status" in ('pending', 'matched_reference', 'matched_amount', 'unmatched', 'mismatch', 'duplicate')),
	CONSTRAINT "provider_statement_rows_matched_check" CHECK (("core"."provider_statement_rows"."match_status" in ('matched_reference', 'matched_amount')) = ("core"."provider_statement_rows"."matched_transaction_id" is not null)
        or "core"."provider_statement_rows"."match_status" in ('mismatch', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE "core"."provider_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"provider" text NOT NULL,
	"currency" char(3) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"file_key" text,
	"content_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"unmatched_count" integer DEFAULT 0 NOT NULL,
	"mismatch_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_statements_ref_format_check" CHECK (ref ~ '^pst_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "provider_statements_provider_check" CHECK ("core"."provider_statements"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "provider_statements_period_check" CHECK ("core"."provider_statements"."period_end" > "core"."provider_statements"."period_start"),
	CONSTRAINT "provider_statements_status_check" CHECK ("core"."provider_statements"."status" in ('uploaded', 'matching', 'matched', 'failed')),
	CONSTRAINT "provider_statements_rows_check" CHECK ("core"."provider_statements"."row_count" > 0 and "core"."provider_statements"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."reconciliation_exception_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"exception_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_exception_notes_kind_check" CHECK ("core"."reconciliation_exception_notes"."kind" in ('note', 'assignment', 'status', 'resolution', 'approval', 'system')),
	CONSTRAINT "reconciliation_exception_notes_body_check" CHECK (char_length("core"."reconciliation_exception_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "core"."reconciliation_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"run_id" uuid,
	"last_run_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"currency" char(3),
	"amount_minor" bigint,
	"merchant_id" uuid,
	"transaction_id" uuid,
	"gateway_operation_id" text,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actual" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"resolution" text,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_entry_ref" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_exceptions_ref_format_check" CHECK (ref ~ '^rce_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "reconciliation_exceptions_kind_check" CHECK ("core"."reconciliation_exceptions"."kind" ~ '^[a-z][a-z0-9_]{2,63}$'),
	CONSTRAINT "reconciliation_exceptions_severity_check" CHECK ("core"."reconciliation_exceptions"."severity" in ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "reconciliation_exceptions_status_check" CHECK ("core"."reconciliation_exceptions"."status" in ('open', 'investigating', 'resolved', 'written_off')),
	CONSTRAINT "reconciliation_exceptions_resolution_check" CHECK (("core"."reconciliation_exceptions"."status" in ('open', 'investigating')) = ("core"."reconciliation_exceptions"."resolution" is null)
        and ("core"."reconciliation_exceptions"."status" = 'written_off') = ("core"."reconciliation_exceptions"."resolution" = 'written_off')
        and ("core"."reconciliation_exceptions"."resolution" is null or "core"."reconciliation_exceptions"."resolution" in ('matched_manually', 'corrected_with_reversal', 'written_off'))
        and ("core"."reconciliation_exceptions"."resolution" is null) = ("core"."reconciliation_exceptions"."resolved_at" is null)
        and ("core"."reconciliation_exceptions"."resolution" is null) = ("core"."reconciliation_exceptions"."resolved_by" is null)),
	CONSTRAINT "reconciliation_exceptions_environment_check" CHECK ("core"."reconciliation_exceptions"."environment" in ('test', 'live')),
	CONSTRAINT "reconciliation_exceptions_amount_check" CHECK ("core"."reconciliation_exceptions"."amount_minor" is null or "core"."reconciliation_exceptions"."amount_minor" >= 0),
	CONSTRAINT "reconciliation_exceptions_occurrences_check" CHECK ("core"."reconciliation_exceptions"."occurrences" >= 1),
	CONSTRAINT "reconciliation_exceptions_json_check" CHECK (jsonb_typeof("core"."reconciliation_exceptions"."expected") = 'object' and jsonb_typeof("core"."reconciliation_exceptions"."actual") = 'object')
);
--> statement-breakpoint
CREATE TABLE "core"."reconciliation_resolution_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"exception_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"currency" char(3),
	"amount_minor" bigint,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"entry_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_resolution_requests_ref_format_check" CHECK (ref ~ '^rca_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "reconciliation_resolution_requests_kind_check" CHECK ("core"."reconciliation_resolution_requests"."kind" in ('corrected_with_reversal', 'written_off')),
	CONSTRAINT "reconciliation_resolution_requests_status_check" CHECK ("core"."reconciliation_resolution_requests"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "reconciliation_resolution_requests_decision_check" CHECK (("core"."reconciliation_resolution_requests"."status" = 'pending') = ("core"."reconciliation_resolution_requests"."decided_by" is null and "core"."reconciliation_resolution_requests"."decided_at" is null)
        and ("core"."reconciliation_resolution_requests"."decided_by" is null or "core"."reconciliation_resolution_requests"."decided_by" <> "core"."reconciliation_resolution_requests"."requested_by")
        and ("core"."reconciliation_resolution_requests"."status" <> 'approved') = ("core"."reconciliation_resolution_requests"."entry_ref" is null)),
	CONSTRAINT "reconciliation_resolution_requests_writeoff_check" CHECK ("core"."reconciliation_resolution_requests"."kind" <> 'written_off' or ("core"."reconciliation_resolution_requests"."amount_minor" > 0 and "core"."reconciliation_resolution_requests"."currency" is not null)),
	CONSTRAINT "reconciliation_resolution_requests_reason_check" CHECK (char_length("core"."reconciliation_resolution_requests"."reason") between 3 and 1000)
);
--> statement-breakpoint
CREATE TABLE "core"."reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_key" text NOT NULL,
	"run_key" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"triggered_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_ref_format_check" CHECK (ref ~ '^rcr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "reconciliation_runs_kind_check" CHECK ("core"."reconciliation_runs"."kind" in ('gateway_gap', 'ledger_integrity', 'provider_statement', 'balance_proof')),
	CONSTRAINT "reconciliation_runs_status_check" CHECK ("core"."reconciliation_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "reconciliation_runs_finished_check" CHECK (("core"."reconciliation_runs"."status" = 'running') = ("core"."reconciliation_runs"."finished_at" is null)),
	CONSTRAINT "reconciliation_runs_counts_check" CHECK ("core"."reconciliation_runs"."checked_count" >= 0 and "core"."reconciliation_runs"."matched_count" >= 0 and "core"."reconciliation_runs"."exception_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"impact" text NOT NULL,
	"affected_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"affected_merchants" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"commander" uuid,
	"public" boolean DEFAULT false NOT NULL,
	"public_message" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"dedupe_key" text,
	"detection_count" integer DEFAULT 1 NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_ref_format_check" CHECK ("core"."incidents"."ref" ~ '^inc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "incidents_severity_check" CHECK ("core"."incidents"."severity" in ('sev1', 'sev2', 'sev3', 'sev4')),
	CONSTRAINT "incidents_status_check" CHECK ("core"."incidents"."status" in ('investigating', 'identified', 'monitoring', 'resolved')),
	CONSTRAINT "incidents_resolved_check" CHECK (("core"."incidents"."status" = 'resolved') = ("core"."incidents"."resolved_at" is not null)),
	CONSTRAINT "incidents_source_check" CHECK ("core"."incidents"."source" in ('manual', 'reconciliation', 'consumer'))
);
--> statement-breakpoint
ALTER TABLE "core"."reserve_entries" ADD CONSTRAINT "reserve_entries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reserve_entries" ADD CONSTRAINT "reserve_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reserve_entries" ADD CONSTRAINT "reserve_entries_settlement_batch_id_settlement_batches_id_fk" FOREIGN KEY ("settlement_batch_id") REFERENCES "core"."settlement_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reserve_entries" ADD CONSTRAINT "reserve_entries_release_batch_id_settlement_batches_id_fk" FOREIGN KEY ("release_batch_id") REFERENCES "core"."settlement_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."rolling_reserves" ADD CONSTRAINT "rolling_reserves_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."rolling_reserves" ADD CONSTRAINT "rolling_reserves_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batch_events" ADD CONSTRAINT "settlement_batch_events_batch_id_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."settlement_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batches" ADD CONSTRAINT "settlement_batches_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batches" ADD CONSTRAINT "settlement_batches_cycle_id_settlement_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "core"."settlement_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batches" ADD CONSTRAINT "settlement_batches_run_id_settlement_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."settlement_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batches" ADD CONSTRAINT "settlement_batches_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_batches" ADD CONSTRAINT "settlement_batches_destination_id_settlement_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "core"."settlement_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_cycles" ADD CONSTRAINT "settlement_cycles_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_destinations" ADD CONSTRAINT "settlement_destinations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_destinations" ADD CONSTRAINT "settlement_destinations_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_items" ADD CONSTRAINT "settlement_items_batch_id_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."settlement_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."settlement_runs" ADD CONSTRAINT "settlement_runs_cycle_id_settlement_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "core"."settlement_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."provider_statement_rows" ADD CONSTRAINT "provider_statement_rows_statement_id_provider_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "core"."provider_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."provider_statements" ADD CONSTRAINT "provider_statements_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_exception_notes" ADD CONSTRAINT "reconciliation_exception_notes_exception_id_reconciliation_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "core"."reconciliation_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_last_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "core"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_resolution_requests" ADD CONSTRAINT "reconciliation_resolution_requests_exception_id_reconciliation_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "core"."reconciliation_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_resolution_requests" ADD CONSTRAINT "reconciliation_resolution_requests_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reserve_entries_source_batch_key" ON "core"."reserve_entries" USING btree ("settlement_batch_id");--> statement-breakpoint
CREATE INDEX "reserve_entries_due_idx" ON "core"."reserve_entries" USING btree ("merchant_id","currency","hold_until") WHERE "core"."reserve_entries"."released_at" is null;--> statement-breakpoint
CREATE INDEX "reserve_entries_release_batch_idx" ON "core"."reserve_entries" USING btree ("release_batch_id") WHERE "core"."reserve_entries"."release_batch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rolling_reserves_merchant_currency_key" ON "core"."rolling_reserves" USING btree ("merchant_id","currency");--> statement-breakpoint
CREATE INDEX "settlement_batch_events_batch_idx" ON "core"."settlement_batch_events" USING btree ("batch_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batch_events_key_idx" ON "core"."settlement_batch_events" USING btree ("batch_id","event_key") WHERE "core"."settlement_batch_events"."event_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batches_ref_key" ON "core"."settlement_batches" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batches_live_period_key" ON "core"."settlement_batches" USING btree ("merchant_id","cycle_id","currency","period_start","period_end") WHERE "core"."settlement_batches"."status" not in ('cancelled', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batches_payout_ref_key" ON "core"."settlement_batches" USING btree ("payout_ref") WHERE "core"."settlement_batches"."payout_ref" is not null;--> statement-breakpoint
CREATE INDEX "settlement_batches_merchant_created_idx" ON "core"."settlement_batches" USING btree ("merchant_id","created_at" DESC NULLS LAST,"ref");--> statement-breakpoint
CREATE INDEX "settlement_batches_status_idx" ON "core"."settlement_batches" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "settlement_batches_cycle_idx" ON "core"."settlement_batches" USING btree ("cycle_id","period_end" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_cycles_ref_key" ON "core"."settlement_cycles" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_cycles_name_key" ON "core"."settlement_cycles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_destinations_ref_key" ON "core"."settlement_destinations" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_destinations_active_key" ON "core"."settlement_destinations" USING btree ("merchant_id","currency") WHERE "core"."settlement_destinations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "settlement_items_batch_idx" ON "core"."settlement_items" USING btree ("batch_id","kind","occurred_at","id");--> statement-breakpoint
CREATE INDEX "settlement_items_transaction_idx" ON "core"."settlement_items" USING btree ("transaction_id") WHERE "core"."settlement_items"."transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_runs_ref_key" ON "core"."settlement_runs" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_runs_cycle_period_key" ON "core"."settlement_runs" USING btree ("cycle_id","period_end");--> statement-breakpoint
CREATE INDEX "settlement_runs_cycle_created_idx" ON "core"."settlement_runs" USING btree ("cycle_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_statement_rows_row_key" ON "core"."provider_statement_rows" USING btree ("statement_id","row_no");--> statement-breakpoint
CREATE INDEX "provider_statement_rows_ref_idx" ON "core"."provider_statement_rows" USING btree ("provider_ref");--> statement-breakpoint
CREATE INDEX "provider_statement_rows_matched_idx" ON "core"."provider_statement_rows" USING btree ("matched_transaction_id") WHERE "core"."provider_statement_rows"."matched_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_statements_ref_key" ON "core"."provider_statements" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_statements_content_key" ON "core"."provider_statements" USING btree ("provider","currency","content_sha256");--> statement-breakpoint
CREATE INDEX "provider_statements_created_idx" ON "core"."provider_statements" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_exception_notes_idx" ON "core"."reconciliation_exception_notes" USING btree ("exception_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_exceptions_ref_key" ON "core"."reconciliation_exceptions" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_exceptions_open_dedupe_key" ON "core"."reconciliation_exceptions" USING btree ("dedupe_key") WHERE "core"."reconciliation_exceptions"."status" in ('open', 'investigating');--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_queue_idx" ON "core"."reconciliation_exceptions" USING btree ("status","severity","created_at" DESC NULLS LAST) WHERE "core"."reconciliation_exceptions"."status" in ('open', 'investigating');--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_kind_idx" ON "core"."reconciliation_exceptions" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_transaction_idx" ON "core"."reconciliation_exceptions" USING btree ("transaction_id") WHERE "core"."reconciliation_exceptions"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_assignee_idx" ON "core"."reconciliation_exceptions" USING btree ("assigned_to","status") WHERE "core"."reconciliation_exceptions"."assigned_to" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_resolution_requests_ref_key" ON "core"."reconciliation_resolution_requests" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_resolution_requests_pending_key" ON "core"."reconciliation_resolution_requests" USING btree ("exception_id") WHERE "core"."reconciliation_resolution_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reconciliation_resolution_requests_status_idx" ON "core"."reconciliation_resolution_requests" USING btree ("status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_ref_key" ON "core"."reconciliation_runs" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_run_key_key" ON "core"."reconciliation_runs" USING btree ("kind","run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_single_flight_key" ON "core"."reconciliation_runs" USING btree ("kind","scope_key") WHERE "core"."reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "reconciliation_runs_kind_started_idx" ON "core"."reconciliation_runs" USING btree ("kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_ref_key" ON "core"."incidents" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_open_dedupe_key" ON "core"."incidents" USING btree ("dedupe_key") WHERE "core"."incidents"."dedupe_key" is not null and "core"."incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "core"."incidents" USING btree ("status","severity","detected_at" DESC NULLS LAST);
--> statement-breakpoint
-- Hand-written ---------------------------------------------------------------------------
-- merchants.settlement_cycle_id was created in Phase 1 without its foreign key (spec 5.2).
ALTER TABLE "core"."merchants" ADD CONSTRAINT "merchants_settlement_cycle_id_fk" FOREIGN KEY ("settlement_cycle_id") REFERENCES "core"."settlement_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- The settlement payout is a `transactions` row of type `settlement` (spec 5.2 lists the type).
-- Statuses for that type, and the rule that a terminal one never changes.
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_settlement_status_check"
  CHECK (type <> 'settlement' OR status IN ('created', 'processing', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "core"."transactions" ADD CONSTRAINT "transactions_settlement_completed_at_check"
  CHECK (type <> 'settlement' OR ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)));--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_settlement_transaction() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.type <> 'settlement' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'core.transactions: settlement payout % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'created' AND NEW.status IN ('processing', 'succeeded', 'failed'))
    OR (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed'))) THEN
    RAISE EXCEPTION 'core.transactions: settlement payout cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transactions_settlement_guard BEFORE UPDATE ON core.transactions FOR EACH ROW EXECUTE FUNCTION core.guard_settlement_transaction();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Settlement batches: amounts are fixed at creation; status moves along one path.
CREATE OR REPLACE FUNCTION core.settlement_transition_allowed(from_status text, to_status text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT (from_status, to_status) IN (
    ('draft', 'pending_approval'), ('draft', 'cancelled'),
    ('pending_approval', 'approved'), ('pending_approval', 'cancelled'),
    ('approved', 'releasing'), ('approved', 'cancelled'),
    ('releasing', 'paid'), ('releasing', 'failed')
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_settlement_batch() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.cycle_id, NEW.run_id, NEW.environment, NEW.currency,
      NEW.period_start, NEW.period_end, NEW.gross_minor, NEW.refund_minor, NEW.fee_minor,
      NEW.reserve_minor, NEW.reserve_release_minor, NEW.dispute_hold_minor, NEW.aml_hold_minor,
      NEW.shortfall_minor, NEW.payable_draw_minor, NEW.net_minor, NEW.min_payout_minor,
      NEW.reserve_hold_days, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.cycle_id, OLD.run_id, OLD.environment, OLD.currency,
      OLD.period_start, OLD.period_end, OLD.gross_minor, OLD.refund_minor, OLD.fee_minor,
      OLD.reserve_minor, OLD.reserve_release_minor, OLD.dispute_hold_minor, OLD.aml_hold_minor,
      OLD.shortfall_minor, OLD.payable_draw_minor, OLD.net_minor, OLD.min_payout_minor,
      OLD.reserve_hold_days, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'core.settlement_batches: identity, period and amounts never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT core.settlement_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'core.settlement_batches: batch cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('paid', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'core.settlement_batches: batch % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Once releasing, the payout it created never changes.
  IF OLD.payout_ref IS NOT NULL AND (NEW.payout_ref IS DISTINCT FROM OLD.payout_ref
      OR NEW.payout_transaction_id IS DISTINCT FROM OLD.payout_transaction_id) THEN
    RAISE EXCEPTION 'core.settlement_batches: the payout of a batch is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_batches_guard BEFORE UPDATE ON core.settlement_batches FOR EACH ROW EXECUTE FUNCTION core.guard_settlement_batch();--> statement-breakpoint
-- Reserve entries: the amount and the due date never change; a release is final.
CREATE OR REPLACE FUNCTION core.guard_reserve_entry() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.currency, NEW.amount_minor, NEW.hold_until, NEW.settlement_batch_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.currency, OLD.amount_minor, OLD.hold_until, OLD.settlement_batch_id, OLD.created_at) THEN
    RAISE EXCEPTION 'core.reserve_entries: amount, due date and source never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'core.reserve_entries: a released reserve cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reserve_entries_guard BEFORE UPDATE ON core.reserve_entries FOR EACH ROW EXECUTE FUNCTION core.guard_reserve_entry();--> statement-breakpoint
-- Exceptions: a resolved or written-off exception is final, and what it is about never changes.
CREATE OR REPLACE FUNCTION core.guard_reconciliation_exception() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.run_id, NEW.kind, NEW.dedupe_key, NEW.environment, NEW.merchant_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.run_id, OLD.kind, OLD.dedupe_key, OLD.environment, OLD.merchant_id, OLD.created_at) THEN
    RAISE EXCEPTION 'core.reconciliation_exceptions: what an exception is about never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('resolved', 'written_off') THEN
    RAISE EXCEPTION 'core.reconciliation_exceptions: exception % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_exceptions_guard BEFORE UPDATE ON core.reconciliation_exceptions FOR EACH ROW EXECUTE FUNCTION core.guard_reconciliation_exception();--> statement-breakpoint
-- Runs: a completed run is final; a failed one may be taken again (attempts + 1).
CREATE OR REPLACE FUNCTION core.guard_run() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION '%: run % is completed and cannot change', TG_TABLE_NAME, OLD.ref
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_guard BEFORE UPDATE ON core.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION core.guard_run();--> statement-breakpoint
CREATE TRIGGER settlement_runs_guard BEFORE UPDATE ON core.settlement_runs FOR EACH ROW EXECUTE FUNCTION core.guard_run();--> statement-breakpoint
-- Resolution requests: only a pending request can be decided, once.
CREATE OR REPLACE FUNCTION core.guard_resolution_request() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'core.reconciliation_resolution_requests: request % is % and cannot change', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.ref, NEW.exception_id, NEW.kind, NEW.payload, NEW.currency, NEW.amount_minor, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.exception_id, OLD.kind, OLD.payload, OLD.currency, OLD.amount_minor, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'core.reconciliation_resolution_requests: what was requested never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_resolution_requests_guard BEFORE UPDATE ON core.reconciliation_resolution_requests FOR EACH ROW EXECUTE FUNCTION core.guard_resolution_request();--> statement-breakpoint
-- updated_at maintenance for the remaining tables with the column.
CREATE TRIGGER settlement_cycles_set_updated_at BEFORE UPDATE ON core.settlement_cycles FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER rolling_reserves_set_updated_at BEFORE UPDATE ON core.rolling_reserves FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER provider_statements_set_updated_at BEFORE UPDATE ON core.provider_statements FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER incidents_set_updated_at BEFORE UPDATE ON core.incidents FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Append-only tables: items, batch events and notes are never updated or deleted.
CREATE TRIGGER settlement_items_append_only BEFORE UPDATE OR DELETE ON core.settlement_items FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER settlement_items_no_truncate BEFORE TRUNCATE ON core.settlement_items FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER settlement_batch_events_append_only BEFORE UPDATE OR DELETE ON core.settlement_batch_events FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER settlement_batch_events_no_truncate BEFORE TRUNCATE ON core.settlement_batch_events FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER reconciliation_exception_notes_append_only BEFORE UPDATE OR DELETE ON core.reconciliation_exception_notes FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER reconciliation_exception_notes_no_truncate BEFORE TRUNCATE ON core.reconciliation_exception_notes FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER incidents_no_delete BEFORE DELETE ON core.incidents FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.settlement_items FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.settlement_batch_events FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.reconciliation_exception_notes FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.settlement_batches FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.settlement_runs FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.settlement_cycles FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.settlement_destinations FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.reserve_entries FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.reconciliation_runs FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.reconciliation_exceptions FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.reconciliation_resolution_requests FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.provider_statements FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.provider_statement_rows FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.incidents FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Permissions (spec 7.3, 11). Keep in step with src/common/authz/permissions.ts.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('settlement:read', 'staff', 'Read settlement cycles, payables, batches and destinations'),
  ('settlement:prepare', 'staff', 'Prepare settlement: cycles, destinations, reserves, running a cycle, submitting and cancelling batches'),
  ('settlement:approve', 'staff', 'Approve a settlement batch (never the person who submitted it)'),
  ('settlement:release', 'staff', 'Release an approved settlement batch to the merchant'),
  ('reconciliation:read', 'staff', 'Read reconciliation runs, exceptions and statements'),
  ('reconciliation:work', 'staff', 'Run reconciliation, upload statements and work the exception queue'),
  ('reconciliation:approve', 'staff', 'Decide a reversal or write-off resolution (never the requester)'),
  ('settlements:read', 'merchant', 'View settlements and download settlement statements');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('super_admin', 'settlement:read'), ('super_admin', 'settlement:prepare'), ('super_admin', 'settlement:approve'),
  ('super_admin', 'settlement:release'), ('super_admin', 'reconciliation:read'), ('super_admin', 'reconciliation:work'),
  ('super_admin', 'reconciliation:approve'),
  ('operations', 'settlement:read'), ('operations', 'settlement:prepare'), ('operations', 'settlement:release'),
  ('operations', 'reconciliation:read'), ('operations', 'reconciliation:work'),
  ('compliance', 'settlement:read'), ('compliance', 'reconciliation:read'),
  ('auditor', 'settlement:read'), ('auditor', 'reconciliation:read'),
  ('support_agent', 'settlement:read'),
  ('owner', 'settlements:read'), ('admin', 'settlements:read'), ('finance', 'settlements:read'),
  ('support', 'settlements:read'), ('viewer', 'settlements:read');
