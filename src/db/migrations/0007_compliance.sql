CREATE TABLE "core"."kyc_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kyc_profile_id" uuid NOT NULL,
	"type" text NOT NULL,
	"file_key" text NOT NULL,
	"file_hash" char(64) NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"rejection_note" text,
	"expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submission_no" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_documents_ref_check" CHECK ("core"."kyc_documents"."ref" ~ '^kdoc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "kyc_documents_status_check" CHECK ("core"."kyc_documents"."status" in ('uploaded', 'verified', 'rejected')),
	CONSTRAINT "kyc_documents_type_check" CHECK ("core"."kyc_documents"."type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "kyc_documents_mime_check" CHECK ("core"."kyc_documents"."mime" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "kyc_documents_size_check" CHECK ("core"."kyc_documents"."size_bytes" between 1 and 10485760),
	CONSTRAINT "kyc_documents_hash_check" CHECK ("core"."kyc_documents"."file_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "kyc_documents_review_check" CHECK (("core"."kyc_documents"."status" = 'uploaded') = ("core"."kyc_documents"."verified_by" is null)
        and ("core"."kyc_documents"."status" = 'uploaded') = ("core"."kyc_documents"."verified_at" is null)
        and ("core"."kyc_documents"."status" = 'rejected') = ("core"."kyc_documents"."rejection_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_level_limits" (
	"level" smallint NOT NULL,
	"currency" char(3) NOT NULL,
	"applies_when" text DEFAULT 'approved' NOT NULL,
	"per_txn_max_minor" bigint NOT NULL,
	"daily_volume_max_minor" bigint NOT NULL,
	"monthly_volume_max_minor" bigint NOT NULL,
	"payout_per_txn_max_minor" bigint NOT NULL,
	"daily_payout_max_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_level_limits_level_currency_applies_when_pk" PRIMARY KEY("level","currency","applies_when"),
	CONSTRAINT "kyc_level_limits_level_check" CHECK ("core"."kyc_level_limits"."level" between 1 and 3),
	CONSTRAINT "kyc_level_limits_applies_check" CHECK ("core"."kyc_level_limits"."applies_when" in ('approved', 'expired')),
	CONSTRAINT "kyc_level_limits_amounts_check" CHECK ("core"."kyc_level_limits"."per_txn_max_minor" > 0 and "core"."kyc_level_limits"."daily_volume_max_minor" >= "core"."kyc_level_limits"."per_txn_max_minor"
        and "core"."kyc_level_limits"."monthly_volume_max_minor" >= "core"."kyc_level_limits"."daily_volume_max_minor"
        and "core"."kyc_level_limits"."payout_per_txn_max_minor" > 0 and "core"."kyc_level_limits"."daily_payout_max_minor" >= "core"."kyc_level_limits"."payout_per_txn_max_minor")
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_parties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"full_name_enc" text NOT NULL,
	"date_of_birth_enc" text,
	"nationality" char(2),
	"id_number_enc" text,
	"id_number_hmac" text,
	"ownership_bps" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_parties_ref_check" CHECK ("core"."kyc_parties"."ref" ~ '^kpty_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "kyc_parties_kind_check" CHECK ("core"."kyc_parties"."kind" in ('director', 'ubo')),
	CONSTRAINT "kyc_parties_status_check" CHECK ("core"."kyc_parties"."status" in ('active', 'removed')),
	CONSTRAINT "kyc_parties_removed_check" CHECK (("core"."kyc_parties"."status" = 'removed') = ("core"."kyc_parties"."removed_at" is not null)),
	CONSTRAINT "kyc_parties_ownership_check" CHECK ("core"."kyc_parties"."ownership_bps" is null or ("core"."kyc_parties"."kind" = 'ubo' and "core"."kyc_parties"."ownership_bps" between 1 and 10000)),
	CONSTRAINT "kyc_parties_nationality_check" CHECK ("core"."kyc_parties"."nationality" is null or "core"."kyc_parties"."nationality" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"submission_no" integer DEFAULT 0 NOT NULL,
	"is_reverification" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reasons" text[],
	"rejection_details" jsonb,
	"info_requested_at" timestamp with time zone,
	"info_request_note" text,
	"expires_at" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"reverification_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_profiles_level_check" CHECK ("core"."kyc_profiles"."level" between 0 and 3),
	CONSTRAINT "kyc_profiles_status_check" CHECK ("core"."kyc_profiles"."status" in ('not_started', 'pending', 'in_review', 'approved', 'rejected', 'expired')),
	CONSTRAINT "kyc_profiles_reasons_check" CHECK (("core"."kyc_profiles"."status" = 'rejected') = ("core"."kyc_profiles"."rejection_reasons" is not null and cardinality("core"."kyc_profiles"."rejection_reasons") > 0)),
	CONSTRAINT "kyc_profiles_approved_check" CHECK ("core"."kyc_profiles"."status" <> 'approved' or ("core"."kyc_profiles"."expires_at" is not null and "core"."kyc_profiles"."reviewed_by" is not null and "core"."kyc_profiles"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"level" smallint NOT NULL,
	"country" text DEFAULT '*' NOT NULL,
	"business_type" text DEFAULT '*' NOT NULL,
	"requirement_code" text NOT NULL,
	"kind" text NOT NULL,
	"evidence_key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mandatory" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_requirements_level_check" CHECK ("core"."kyc_requirements"."level" between 1 and 3),
	CONSTRAINT "kyc_requirements_country_check" CHECK ("core"."kyc_requirements"."country" = '*' or "core"."kyc_requirements"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "kyc_requirements_business_type_check" CHECK ("core"."kyc_requirements"."business_type" = '*' or "core"."kyc_requirements"."business_type" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "kyc_requirements_code_check" CHECK ("core"."kyc_requirements"."requirement_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "kyc_requirements_kind_check" CHECK ("core"."kyc_requirements"."kind" in ('document', 'profile_field', 'party', 'verification')),
	CONSTRAINT "kyc_requirements_evidence_key_check" CHECK ("core"."kyc_requirements"."evidence_key" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kyc_profile_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"submission_no" integer NOT NULL,
	"decision" text NOT NULL,
	"level" smallint NOT NULL,
	"reviewer_id" uuid,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_reviews_decision_check" CHECK ("core"."kyc_reviews"."decision" in ('submitted', 'approved', 'rejected', 'info_requested', 'expired', 'reverification_due'))
);
--> statement-breakpoint
CREATE TABLE "core"."kyc_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kyc_profile_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"check_type" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submission_no" integer NOT NULL,
	"performed_by" uuid,
	"performed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_verifications_check_type_check" CHECK ("core"."kyc_verifications"."check_type" in ('document', 'business_registry', 'sanctions', 'address', 'bank_account', 'contact')),
	CONSTRAINT "kyc_verifications_status_check" CHECK ("core"."kyc_verifications"."status" in ('passed', 'failed', 'pending'))
);
--> statement-breakpoint
CREATE TABLE "core"."merchant_limits" (
	"merchant_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"per_txn_max_minor" bigint NOT NULL,
	"daily_volume_max_minor" bigint NOT NULL,
	"monthly_volume_max_minor" bigint NOT NULL,
	"payout_per_txn_max_minor" bigint NOT NULL,
	"daily_payout_max_minor" bigint NOT NULL,
	"source" text DEFAULT 'kyc' NOT NULL,
	"kyc_level" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_limits_merchant_id_currency_pk" PRIMARY KEY("merchant_id","currency"),
	CONSTRAINT "merchant_limits_source_check" CHECK ("core"."merchant_limits"."source" in ('kyc', 'manual')),
	CONSTRAINT "merchant_limits_amounts_check" CHECK ("core"."merchant_limits"."per_txn_max_minor" > 0 and "core"."merchant_limits"."daily_volume_max_minor" >= "core"."merchant_limits"."per_txn_max_minor"
        and "core"."merchant_limits"."monthly_volume_max_minor" >= "core"."merchant_limits"."daily_volume_max_minor"
        and "core"."merchant_limits"."payout_per_txn_max_minor" > 0 and "core"."merchant_limits"."daily_payout_max_minor" >= "core"."merchant_limits"."payout_per_txn_max_minor")
);
--> statement-breakpoint
CREATE TABLE "core"."merchant_profiles" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"registration_number" text,
	"tin_enc" text,
	"tin_hmac" text,
	"incorporation_date" date,
	"business_type" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."aml_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version" integer NOT NULL,
	"severity" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"transaction_id" uuid,
	"customer_id" uuid,
	"score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text NOT NULL,
	"assigned_to" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"hold_id" uuid,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_alerts_ref_check" CHECK ("core"."aml_alerts"."ref" ~ '^alrt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "aml_alerts_severity_check" CHECK ("core"."aml_alerts"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "aml_alerts_status_check" CHECK ("core"."aml_alerts"."status" in ('open', 'investigating', 'escalated', 'closed_false_positive', 'closed_confirmed')),
	CONSTRAINT "aml_alerts_action_check" CHECK ("core"."aml_alerts"."action" in ('flag', 'hold', 'block')),
	CONSTRAINT "aml_alerts_score_check" CHECK ("core"."aml_alerts"."score" between 0 and 100),
	CONSTRAINT "aml_alerts_resolved_check" CHECK (("core"."aml_alerts"."status" in ('closed_false_positive', 'closed_confirmed')) = ("core"."aml_alerts"."resolved_at" is not null)
        and ("core"."aml_alerts"."status" in ('closed_false_positive', 'closed_confirmed')) = ("core"."aml_alerts"."resolved_by" is not null)),
	CONSTRAINT "aml_alerts_escalated_check" CHECK (("core"."aml_alerts"."escalated_at" is null) = ("core"."aml_alerts"."escalation_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."aml_block_holds" (
	"block_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."aml_blocklist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"entry_type" text NOT NULL,
	"value_hmac" text NOT NULL,
	"value_hint" text NOT NULL,
	"reason" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"added_by" uuid,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_blocklist_ref_check" CHECK ("core"."aml_blocklist"."ref" ~ '^bl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "aml_blocklist_type_check" CHECK ("core"."aml_blocklist"."entry_type" in ('msisdn', 'email', 'account', 'bin', 'device', 'name')),
	CONSTRAINT "aml_blocklist_hmac_check" CHECK ("core"."aml_blocklist"."value_hmac" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "aml_blocklist_removed_check" CHECK (("core"."aml_blocklist"."removed_at" is null) = ("core"."aml_blocklist"."removed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."aml_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"alert_id" uuid,
	"case_id" uuid,
	"created_by" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_blocks_ref_check" CHECK ("core"."aml_blocks"."ref" ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "aml_blocks_status_check" CHECK ("core"."aml_blocks"."status" in ('active', 'lifted')),
	CONSTRAINT "aml_blocks_source_check" CHECK ("core"."aml_blocks"."source" in ('rule', 'case', 'manual')),
	CONSTRAINT "aml_blocks_lifted_check" CHECK (("core"."aml_blocks"."status" = 'lifted') = ("core"."aml_blocks"."lifted_at" is not null)
        and ("core"."aml_blocks"."status" = 'lifted') = ("core"."aml_blocks"."lifted_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."aml_case_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_case_notes_body_check" CHECK (char_length("core"."aml_case_notes"."body") between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "core"."aml_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"opened_by" uuid,
	"assigned_to" uuid,
	"outcome" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"str_filed_at" timestamp with time zone,
	"str_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_cases_ref_check" CHECK ("core"."aml_cases"."ref" ~ '^case_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "aml_cases_status_check" CHECK ("core"."aml_cases"."status" in ('open', 'investigating', 'closed')),
	CONSTRAINT "aml_cases_severity_check" CHECK ("core"."aml_cases"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "aml_cases_source_check" CHECK ("core"."aml_cases"."source" in ('screening', 'alert', 'manual')),
	CONSTRAINT "aml_cases_outcome_check" CHECK ("core"."aml_cases"."outcome" is null or "core"."aml_cases"."outcome" in ('no_action', 'false_positive', 'suspicious_activity_reported', 'merchant_blocked', 'merchant_offboarded')),
	CONSTRAINT "aml_cases_closed_check" CHECK (("core"."aml_cases"."status" = 'closed') = ("core"."aml_cases"."outcome" is not null)
        and ("core"."aml_cases"."status" = 'closed') = ("core"."aml_cases"."closed_at" is not null)
        and ("core"."aml_cases"."status" = 'closed') = ("core"."aml_cases"."closed_by" is not null)),
	CONSTRAINT "aml_cases_str_check" CHECK (("core"."aml_cases"."str_filed_at" is null) = ("core"."aml_cases"."str_reference" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."aml_rule_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."aml_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rule_type" text NOT NULL,
	"params" jsonb NOT NULL,
	"severity" text NOT NULL,
	"action" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_rules_code_check" CHECK ("core"."aml_rules"."code" ~ '^[a-z][a-z0-9_.-]{2,63}$'),
	CONSTRAINT "aml_rules_type_check" CHECK ("core"."aml_rules"."rule_type" in ('velocity', 'amount_threshold', 'structuring', 'geography', 'new_account', 'round_amount', 'counterparty_reuse')),
	CONSTRAINT "aml_rules_severity_check" CHECK ("core"."aml_rules"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "aml_rules_action_check" CHECK ("core"."aml_rules"."action" in ('flag', 'hold', 'block')),
	CONSTRAINT "aml_rules_effective_check" CHECK ("core"."aml_rules"."effective_to" is null or "core"."aml_rules"."effective_to" > "core"."aml_rules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "core"."aml_screenings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kyc_profile_id" uuid,
	"submission_no" integer,
	"provider" text NOT NULL,
	"lists" text[] DEFAULT '{}'::text[] NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"highest_score" numeric(4, 3),
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"screened_at" timestamp with time zone NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_screenings_ref_check" CHECK ("core"."aml_screenings"."ref" ~ '^scr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "aml_screenings_subject_type_check" CHECK ("core"."aml_screenings"."subject_type" in ('merchant', 'director', 'ubo', 'customer', 'counterparty')),
	CONSTRAINT "aml_screenings_status_check" CHECK ("core"."aml_screenings"."status" in ('clear', 'potential_match', 'confirmed_match')),
	CONSTRAINT "aml_screenings_review_check" CHECK (("core"."aml_screenings"."reviewed_by" is null) = ("core"."aml_screenings"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."aml_str_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"case_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"file_hash" char(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"alert_count" integer NOT NULL,
	"generated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_str_packages_ref_check" CHECK ("core"."aml_str_packages"."ref" ~ '^str_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "core"."aml_transaction_facts" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"counterparty_hmac" text,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aml_facts_amount_check" CHECK ("core"."aml_transaction_facts"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason_code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence_due_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"hold_id" uuid,
	"hold_minor" bigint DEFAULT 0 NOT NULL,
	"shortfall_minor" bigint DEFAULT 0 NOT NULL,
	"resolution_entry_ref" text,
	"resolution_note" text,
	"internal_note" text,
	"created_by" text NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_ref_check" CHECK ("core"."disputes"."ref" ~ '^dsp_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "disputes_environment_check" CHECK ("core"."disputes"."environment" = 'live'),
	CONSTRAINT "disputes_kind_check" CHECK ("core"."disputes"."kind" in ('chargeback', 'inquiry', 'pre_arbitration')),
	CONSTRAINT "disputes_status_check" CHECK ("core"."disputes"."status" in ('open', 'under_review', 'resolved')),
	CONSTRAINT "disputes_outcome_check" CHECK ("core"."disputes"."outcome" is null or "core"."disputes"."outcome" in ('merchant_won', 'merchant_lost', 'withdrawn')),
	CONSTRAINT "disputes_amount_check" CHECK ("core"."disputes"."amount_minor" > 0),
	CONSTRAINT "disputes_hold_check" CHECK ("core"."disputes"."hold_minor" >= 0 and "core"."disputes"."shortfall_minor" >= 0 and "core"."disputes"."hold_minor" + "core"."disputes"."shortfall_minor" = "core"."disputes"."amount_minor"
        and (("core"."disputes"."hold_minor" > 0) = ("core"."disputes"."hold_id" is not null))),
	CONSTRAINT "disputes_reason_check" CHECK (char_length("core"."disputes"."reason_code") between 1 and 64),
	CONSTRAINT "disputes_resolved_check" CHECK (("core"."disputes"."status" = 'resolved') = ("core"."disputes"."outcome" is not null)
        and ("core"."disputes"."status" = 'resolved') = ("core"."disputes"."resolved_at" is not null)
        and ("core"."disputes"."status" = 'resolved') = ("core"."disputes"."resolved_by" is not null)),
	CONSTRAINT "disputes_entry_check" CHECK ("core"."disputes"."resolution_entry_ref" is null or "core"."disputes"."outcome" = 'merchant_lost')
);
--> statement-breakpoint
ALTER TABLE "core"."kyc_documents" ADD CONSTRAINT "kyc_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "core"."kyc_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_documents" ADD CONSTRAINT "kyc_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_documents" ADD CONSTRAINT "kyc_documents_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_level_limits" ADD CONSTRAINT "kyc_level_limits_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_parties" ADD CONSTRAINT "kyc_parties_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_profiles" ADD CONSTRAINT "kyc_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_profiles" ADD CONSTRAINT "kyc_profiles_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_reviews" ADD CONSTRAINT "kyc_reviews_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "core"."kyc_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_reviews" ADD CONSTRAINT "kyc_reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_reviews" ADD CONSTRAINT "kyc_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_verifications" ADD CONSTRAINT "kyc_verifications_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "core"."kyc_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_verifications" ADD CONSTRAINT "kyc_verifications_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."kyc_verifications" ADD CONSTRAINT "kyc_verifications_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_limits" ADD CONSTRAINT "merchant_limits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_limits" ADD CONSTRAINT "merchant_limits_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_profiles" ADD CONSTRAINT "merchant_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_alerts" ADD CONSTRAINT "aml_alerts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_alerts" ADD CONSTRAINT "aml_alerts_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_alerts" ADD CONSTRAINT "aml_alerts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_alerts" ADD CONSTRAINT "aml_alerts_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "core"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_alerts" ADD CONSTRAINT "aml_alerts_case_id_aml_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "core"."aml_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_block_holds" ADD CONSTRAINT "aml_block_holds_block_id_aml_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "core"."aml_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_block_holds" ADD CONSTRAINT "aml_block_holds_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "core"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocklist" ADD CONSTRAINT "aml_blocklist_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocklist" ADD CONSTRAINT "aml_blocklist_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocks" ADD CONSTRAINT "aml_blocks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocks" ADD CONSTRAINT "aml_blocks_alert_id_aml_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "core"."aml_alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocks" ADD CONSTRAINT "aml_blocks_case_id_aml_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "core"."aml_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_blocks" ADD CONSTRAINT "aml_blocks_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_case_notes" ADD CONSTRAINT "aml_case_notes_case_id_aml_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "core"."aml_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_case_notes" ADD CONSTRAINT "aml_case_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_cases" ADD CONSTRAINT "aml_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_cases" ADD CONSTRAINT "aml_cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_cases" ADD CONSTRAINT "aml_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_cases" ADD CONSTRAINT "aml_cases_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_rule_versions" ADD CONSTRAINT "aml_rule_versions_rule_id_aml_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "core"."aml_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_rule_versions" ADD CONSTRAINT "aml_rule_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_rules" ADD CONSTRAINT "aml_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_screenings" ADD CONSTRAINT "aml_screenings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_screenings" ADD CONSTRAINT "aml_screenings_kyc_profile_id_kyc_profiles_id_fk" FOREIGN KEY ("kyc_profile_id") REFERENCES "core"."kyc_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_screenings" ADD CONSTRAINT "aml_screenings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_screenings" ADD CONSTRAINT "aml_screenings_case_id_aml_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "core"."aml_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_str_packages" ADD CONSTRAINT "aml_str_packages_case_id_aml_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "core"."aml_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_str_packages" ADD CONSTRAINT "aml_str_packages_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_transaction_facts" ADD CONSTRAINT "aml_transaction_facts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."aml_transaction_facts" ADD CONSTRAINT "aml_transaction_facts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_transaction_id_transaction_keys_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transaction_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "core"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_documents_ref_key" ON "core"."kyc_documents" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_documents_file_key_key" ON "core"."kyc_documents" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "kyc_documents_profile_idx" ON "core"."kyc_documents" USING btree ("kyc_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_documents_merchant_idx" ON "core"."kyc_documents" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_parties_ref_key" ON "core"."kyc_parties" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "kyc_parties_merchant_idx" ON "core"."kyc_parties" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_profiles_merchant_key" ON "core"."kyc_profiles" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "kyc_profiles_queue_idx" ON "core"."kyc_profiles" USING btree ("status","submitted_at") WHERE "core"."kyc_profiles"."status" in ('pending', 'in_review');--> statement-breakpoint
CREATE INDEX "kyc_profiles_expiry_idx" ON "core"."kyc_profiles" USING btree ("expires_at") WHERE "core"."kyc_profiles"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "kyc_profiles_review_due_idx" ON "core"."kyc_profiles" USING btree ("next_review_at") WHERE "core"."kyc_profiles"."status" = 'approved' and "core"."kyc_profiles"."reverification_notified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_requirements_scope_key" ON "core"."kyc_requirements" USING btree ("level","country","business_type","requirement_code");--> statement-breakpoint
CREATE INDEX "kyc_requirements_lookup_idx" ON "core"."kyc_requirements" USING btree ("country","business_type","level") WHERE "core"."kyc_requirements"."active";--> statement-breakpoint
CREATE INDEX "kyc_reviews_profile_idx" ON "core"."kyc_reviews" USING btree ("kyc_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_verifications_profile_idx" ON "core"."kyc_verifications" USING btree ("kyc_profile_id","check_type","performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_alerts_ref_key" ON "core"."aml_alerts" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_alerts_rule_transaction_key" ON "core"."aml_alerts" USING btree ("rule_code","transaction_id") WHERE "core"."aml_alerts"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "aml_alerts_queue_idx" ON "core"."aml_alerts" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "aml_alerts_merchant_idx" ON "core"."aml_alerts" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_alerts_case_idx" ON "core"."aml_alerts" USING btree ("case_id") WHERE "core"."aml_alerts"."case_id" is not null;--> statement-breakpoint
CREATE INDEX "aml_alerts_sla_idx" ON "core"."aml_alerts" USING btree ("due_at") WHERE "core"."aml_alerts"."status" in ('open', 'investigating');--> statement-breakpoint
CREATE UNIQUE INDEX "aml_block_holds_hold_key" ON "core"."aml_block_holds" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "aml_block_holds_block_idx" ON "core"."aml_block_holds" USING btree ("block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_blocklist_ref_key" ON "core"."aml_blocklist" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_blocklist_active_key" ON "core"."aml_blocklist" USING btree ("entry_type","value_hmac") WHERE "core"."aml_blocklist"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "aml_blocklist_active_idx" ON "core"."aml_blocklist" USING btree ("entry_type") WHERE "core"."aml_blocklist"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "aml_blocks_ref_key" ON "core"."aml_blocks" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_blocks_one_active_key" ON "core"."aml_blocks" USING btree ("merchant_id") WHERE "core"."aml_blocks"."status" = 'active';--> statement-breakpoint
CREATE INDEX "aml_blocks_merchant_idx" ON "core"."aml_blocks" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_case_notes_case_idx" ON "core"."aml_case_notes" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_cases_ref_key" ON "core"."aml_cases" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "aml_cases_merchant_idx" ON "core"."aml_cases" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_cases_open_idx" ON "core"."aml_cases" USING btree ("created_at" DESC NULLS LAST) WHERE "core"."aml_cases"."status" <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "aml_rule_versions_key" ON "core"."aml_rule_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_rules_code_key" ON "core"."aml_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "aml_rules_active_idx" ON "core"."aml_rules" USING btree ("rule_type") WHERE "core"."aml_rules"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "aml_screenings_ref_key" ON "core"."aml_screenings" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_screenings_dedupe_key" ON "core"."aml_screenings" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "aml_screenings_subject_idx" ON "core"."aml_screenings" USING btree ("subject_type","subject_id","screened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_screenings_merchant_idx" ON "core"."aml_screenings" USING btree ("merchant_id","screened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_screenings_open_idx" ON "core"."aml_screenings" USING btree ("screened_at") WHERE "core"."aml_screenings"."status" = 'potential_match';--> statement-breakpoint
CREATE UNIQUE INDEX "aml_str_packages_ref_key" ON "core"."aml_str_packages" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "aml_str_packages_file_key" ON "core"."aml_str_packages" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "aml_str_packages_case_idx" ON "core"."aml_str_packages" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_facts_merchant_idx" ON "core"."aml_transaction_facts" USING btree ("merchant_id","currency","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "aml_facts_counterparty_idx" ON "core"."aml_transaction_facts" USING btree ("counterparty_hmac","completed_at" DESC NULLS LAST) WHERE "core"."aml_transaction_facts"."counterparty_hmac" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_ref_key" ON "core"."disputes" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_one_unresolved_key" ON "core"."disputes" USING btree ("transaction_id") WHERE "core"."disputes"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "disputes_merchant_idx" ON "core"."disputes" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_queue_idx" ON "core"."disputes" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_due_idx" ON "core"."disputes" USING btree ("evidence_due_at") WHERE "core"."disputes"."status" = 'open' and "core"."disputes"."evidence_due_at" is not null;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Hand-written part of migration 0007 (Phase 7, compliance): state guards, append-only
-- rules, grants, seed data and permissions. The domain checks every rule first; these
-- triggers make the same rules hold for any other writer.
-- ---------------------------------------------------------------------------------------

-- A KYC profile moves along the allowed transitions only. The merchant never changes.
CREATE OR REPLACE FUNCTION core.guard_kyc_profile() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.created_at) THEN
    RAISE EXCEPTION 'core.kyc_profiles: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.submission_no < OLD.submission_no THEN
    RAISE EXCEPTION 'core.kyc_profiles: submission_no never decreases' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'not_started' AND NEW.status = 'pending')
    OR (OLD.status = 'pending'     AND NEW.status IN ('in_review', 'approved', 'rejected'))
    OR (OLD.status = 'in_review'   AND NEW.status IN ('pending', 'approved', 'rejected'))
    OR (OLD.status = 'approved'    AND NEW.status IN ('expired', 'pending'))
    OR (OLD.status = 'rejected'    AND NEW.status = 'pending')
    OR (OLD.status = 'expired'     AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'core.kyc_profiles: % -> % is not a legal transition', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER kyc_profiles_guard BEFORE UPDATE ON core.kyc_profiles FOR EACH ROW EXECUTE FUNCTION core.guard_kyc_profile();--> statement-breakpoint
-- A document's file never changes; a verified or rejected document is final; removal is final.
CREATE OR REPLACE FUNCTION core.guard_kyc_document() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.kyc_profile_id, NEW.type, NEW.file_key, NEW.file_hash,
      NEW.mime, NEW.size_bytes, NEW.uploaded_by, NEW.uploaded_at, NEW.submission_no, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.kyc_profile_id, OLD.type, OLD.file_key, OLD.file_hash,
      OLD.mime, OLD.size_bytes, OLD.uploaded_by, OLD.uploaded_at, OLD.submission_no, OLD.created_at) THEN
    RAISE EXCEPTION 'core.kyc_documents: the file and its owner never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'uploaded' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'core.kyc_documents: document % is % and its status is final', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'core.kyc_documents: a removed document stays removed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'uploaded' AND (NEW.verified_by, NEW.verified_at, NEW.rejection_reason, NEW.rejection_note, NEW.expires_at)
     IS DISTINCT FROM (OLD.verified_by, OLD.verified_at, OLD.rejection_reason, OLD.rejection_note, OLD.expires_at) THEN
    RAISE EXCEPTION 'core.kyc_documents: a reviewed document cannot be re-reviewed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER kyc_documents_guard BEFORE UPDATE ON core.kyc_documents FOR EACH ROW EXECUTE FUNCTION core.guard_kyc_document();--> statement-breakpoint
-- Screenings: the result never changes. Only a potential match can be decided, once.
CREATE OR REPLACE FUNCTION core.guard_aml_screening() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.subject_type, NEW.subject_id, NEW.dedupe_key, NEW.provider,
      NEW.lists, NEW.hit_count, NEW.highest_score, NEW.result, NEW.screened_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.subject_type, OLD.subject_id, OLD.dedupe_key, OLD.provider,
      OLD.lists, OLD.hit_count, OLD.highest_score, OLD.result, OLD.screened_at, OLD.created_at) THEN
    RAISE EXCEPTION 'core.aml_screenings: what was screened and what came back never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'potential_match' AND (NEW.status, NEW.reviewed_by, NEW.reviewed_at, NEW.review_note)
     IS DISTINCT FROM (OLD.status, OLD.reviewed_by, OLD.reviewed_at, OLD.review_note) THEN
    RAISE EXCEPTION 'core.aml_screenings: screening % is % and final', OLD.ref, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NEW.status NOT IN ('clear', 'confirmed_match') THEN
    RAISE EXCEPTION 'core.aml_screenings: a potential match is decided as clear or confirmed'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER aml_screenings_guard BEFORE UPDATE ON core.aml_screenings FOR EACH ROW EXECUTE FUNCTION core.guard_aml_screening();--> statement-breakpoint
-- Alerts: what fired never changes; a closed alert is final; `open` is only the start.
CREATE OR REPLACE FUNCTION core.guard_aml_alert() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.rule_code, NEW.rule_version, NEW.severity, NEW.merchant_id, NEW.transaction_id,
      NEW.action, NEW.due_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.rule_code, OLD.rule_version, OLD.severity, OLD.merchant_id, OLD.transaction_id,
      OLD.action, OLD.due_at, OLD.created_at) THEN
    RAISE EXCEPTION 'core.aml_alerts: what an alert is about never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('closed_false_positive', 'closed_confirmed') THEN
    RAISE EXCEPTION 'core.aml_alerts: alert % is % and final', OLD.ref, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'open' AND OLD.status <> 'open' THEN
    RAISE EXCEPTION 'core.aml_alerts: an alert that has been worked does not go back to open'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER aml_alerts_guard BEFORE UPDATE ON core.aml_alerts FOR EACH ROW EXECUTE FUNCTION core.guard_aml_alert();--> statement-breakpoint
-- Cases: a closed case is final, except that its STR filing can be recorded once.
CREATE OR REPLACE FUNCTION core.guard_aml_case() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.source, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.source, OLD.created_at) THEN
    RAISE EXCEPTION 'core.aml_cases: what a case is about never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'closed' THEN
    IF OLD.str_filed_at IS NOT NULL OR (NEW.status, NEW.outcome, NEW.closed_at, NEW.closed_by, NEW.title, NEW.summary, NEW.assigned_to, NEW.severity)
       IS DISTINCT FROM (OLD.status, OLD.outcome, OLD.closed_at, OLD.closed_by, OLD.title, OLD.summary, OLD.assigned_to, OLD.severity) THEN
      RAISE EXCEPTION 'core.aml_cases: case % is closed and final', OLD.ref USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.str_filed_at IS NOT NULL AND (NEW.str_filed_at, NEW.str_reference) IS DISTINCT FROM (OLD.str_filed_at, OLD.str_reference) THEN
    RAISE EXCEPTION 'core.aml_cases: the STR filing is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER aml_cases_guard BEFORE UPDATE ON core.aml_cases FOR EACH ROW EXECUTE FUNCTION core.guard_aml_case();--> statement-breakpoint
-- Blocklist entries are removed by timestamp, once. Blocks end by being lifted, once.
CREATE OR REPLACE FUNCTION core.guard_aml_blocklist() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.entry_type, NEW.value_hmac, NEW.value_hint, NEW.reason, NEW.source, NEW.added_by, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.entry_type, OLD.value_hmac, OLD.value_hint, OLD.reason, OLD.source, OLD.added_by, OLD.expires_at, OLD.created_at)
     OR (OLD.removed_at IS NOT NULL AND (NEW.removed_at, NEW.removed_by) IS DISTINCT FROM (OLD.removed_at, OLD.removed_by)) THEN
    RAISE EXCEPTION 'core.aml_blocklist: an entry is only ever removed, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER aml_blocklist_guard BEFORE UPDATE ON core.aml_blocklist FOR EACH ROW EXECUTE FUNCTION core.guard_aml_blocklist();--> statement-breakpoint
CREATE OR REPLACE FUNCTION core.guard_aml_block() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.reason, NEW.source, NEW.alert_id, NEW.case_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.reason, OLD.source, OLD.alert_id, OLD.case_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'core.aml_blocks: what a block is about never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'lifted' THEN
    RAISE EXCEPTION 'core.aml_blocks: block % is lifted and final', OLD.ref USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER aml_blocks_guard BEFORE UPDATE ON core.aml_blocks FOR EACH ROW EXECUTE FUNCTION core.guard_aml_block();--> statement-breakpoint
-- Disputes: what the dispute is about never changes; resolved is final; the allowed path is
-- open -> under_review -> resolved, or open -> resolved.
CREATE OR REPLACE FUNCTION core.guard_dispute() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.transaction_id, NEW.merchant_id, NEW.environment, NEW.kind, NEW.amount_minor,
      NEW.currency, NEW.hold_id, NEW.hold_minor, NEW.shortfall_minor, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.transaction_id, OLD.merchant_id, OLD.environment, OLD.kind, OLD.amount_minor,
      OLD.currency, OLD.hold_id, OLD.hold_minor, OLD.shortfall_minor, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'core.disputes: what a dispute is about never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'core.disputes: dispute % is resolved and final', OLD.ref USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('under_review', 'resolved'))
    OR (OLD.status = 'under_review' AND NEW.status = 'resolved')
  ) THEN
    RAISE EXCEPTION 'core.disputes: % -> % is not a legal transition', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER disputes_guard BEFORE UPDATE ON core.disputes FOR EACH ROW EXECUTE FUNCTION core.guard_dispute();--> statement-breakpoint
-- Limits cannot be removed, and the merchant of a row never changes.
CREATE TRIGGER merchant_limits_set_updated_at BEFORE UPDATE ON core.merchant_limits FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER merchant_profiles_set_updated_at BEFORE UPDATE ON core.merchant_profiles FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER kyc_requirements_set_updated_at BEFORE UPDATE ON core.kyc_requirements FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER kyc_level_limits_set_updated_at BEFORE UPDATE ON core.kyc_level_limits FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER kyc_parties_set_updated_at BEFORE UPDATE ON core.kyc_parties FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER aml_rules_set_updated_at BEFORE UPDATE ON core.aml_rules FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
-- Append-only: reviews, verifications, versions, notes, STR packages, facts and block holds.
CREATE TRIGGER kyc_reviews_append_only BEFORE UPDATE OR DELETE ON core.kyc_reviews FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER kyc_reviews_no_truncate BEFORE TRUNCATE ON core.kyc_reviews FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER kyc_verifications_append_only BEFORE UPDATE OR DELETE ON core.kyc_verifications FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER kyc_verifications_no_truncate BEFORE TRUNCATE ON core.kyc_verifications FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_rule_versions_append_only BEFORE UPDATE OR DELETE ON core.aml_rule_versions FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_rule_versions_no_truncate BEFORE TRUNCATE ON core.aml_rule_versions FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_case_notes_append_only BEFORE UPDATE OR DELETE ON core.aml_case_notes FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_case_notes_no_truncate BEFORE TRUNCATE ON core.aml_case_notes FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_str_packages_append_only BEFORE UPDATE OR DELETE ON core.aml_str_packages FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_str_packages_no_truncate BEFORE TRUNCATE ON core.aml_str_packages FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_transaction_facts_append_only BEFORE UPDATE OR DELETE ON core.aml_transaction_facts FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_transaction_facts_no_truncate BEFORE TRUNCATE ON core.aml_transaction_facts FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_block_holds_append_only BEFORE UPDATE OR DELETE ON core.aml_block_holds FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER aml_block_holds_no_truncate BEFORE TRUNCATE ON core.aml_block_holds FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.kyc_reviews FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.kyc_verifications FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.aml_rule_versions FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.aml_case_notes FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.aml_str_packages FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.aml_transaction_facts FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.aml_block_holds FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.merchant_profiles FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.merchant_limits FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.kyc_requirements FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.kyc_level_limits FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.kyc_profiles FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.kyc_documents FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.kyc_parties FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_screenings FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_rules FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_alerts FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_cases FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_blocklist FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.aml_blocks FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.disputes FROM mulapay_core_rw;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Seed: KYC requirements (spec 6.13). These are data: an administrator adds or changes rows
-- per country and business type without a deploy. A more specific row (country, then
-- business type) overrides a `*` row of the same requirement code, so a country or business
-- type can relax or add a requirement.
INSERT INTO core.kyc_requirements
  (id, level, country, business_type, requirement_code, kind, evidence_key, label, description, mandatory, sort_order)
VALUES
  (core.gen_uuid_v7(), 1, '*', '*', 'business_type', 'profile_field', 'business_type', 'Type of business', 'How the business is registered: sole proprietor, partnership, limited company, NGO or other.', true, 10),
  (core.gen_uuid_v7(), 1, '*', '*', 'identity_document', 'document', 'national_id', 'Identity document', 'A government-issued photo ID of the account owner (national ID, passport or driving licence).', true, 20),
  (core.gen_uuid_v7(), 1, '*', '*', 'contact_verification', 'verification', 'contact', 'Contact verification', 'The owner''s phone number and email are confirmed by our team.', true, 30),
  (core.gen_uuid_v7(), 2, '*', '*', 'registration_number', 'profile_field', 'registration_number', 'Business registration number', 'The number on the certificate of registration.', true, 40),
  (core.gen_uuid_v7(), 2, '*', '*', 'business_registration_certificate', 'document', 'business_registration_certificate', 'Business registration certificate', 'The certificate issued by the company registry.', true, 50),
  (core.gen_uuid_v7(), 2, '*', 'sole_proprietor', 'business_registration_certificate', 'document', 'business_registration_certificate', 'Business registration certificate', 'Optional for a sole proprietor.', false, 50),
  (core.gen_uuid_v7(), 2, '*', '*', 'tin', 'profile_field', 'tin', 'Tax identification number (TIN)', 'The tax identification number of the business.', true, 60),
  (core.gen_uuid_v7(), 2, 'UG', '*', 'tin_certificate', 'document', 'tin_certificate', 'TIN certificate', 'The URA TIN registration certificate.', true, 65),
  (core.gen_uuid_v7(), 2, '*', '*', 'proof_of_address', 'document', 'proof_of_address', 'Proof of business address', 'A utility bill or lease agreement dated in the last three months.', true, 70),
  (core.gen_uuid_v7(), 2, '*', '*', 'bank_account', 'verification', 'bank_account', 'Bank account', 'The settlement account is confirmed to belong to the business.', true, 80),
  (core.gen_uuid_v7(), 3, '*', '*', 'directors', 'party', 'director', 'Directors', 'Every director of the business, each screened against sanctions and PEP lists.', true, 90),
  (core.gen_uuid_v7(), 3, '*', '*', 'ubo', 'party', 'ubo', 'Ultimate beneficial owners', 'Everyone who owns 25% or more, each screened against sanctions and PEP lists.', true, 100),
  (core.gen_uuid_v7(), 3, '*', '*', 'source_of_funds', 'document', 'source_of_funds_statement', 'Source of funds', 'A statement of where the business money comes from, with supporting evidence.', true, 110);--> statement-breakpoint
-- Seed: limits per level and currency. PLACEHOLDER VALUES for review by Compliance (see
-- docs/ARCHITECTURE.md, "Phase 7 decisions to confirm"): the caps below are in US dollars
-- (level 1: 300 per transaction, 1,000 a day, 5,000 a month; level 2: 3,000, 20,000,
-- 200,000; level 3: 30,000, 200,000, 2,000,000), converted at rounded indicative rates
-- into each currency's minor units. Payout limits equal the collection limits.
WITH fx(code, units_per_usd) AS (VALUES
  ('UGX', 3700), ('RWF', 1400), ('KRW', 1350), ('JPY', 150), ('VND', 25000), ('KES', 130),
  ('TZS', 2600), ('NGN', 1500), ('GHS', 15), ('ZAR', 18), ('ZMW', 27), ('MWK', 1750),
  ('USD', 1), ('EUR', 1), ('GBP', 1), ('XOF', 600), ('XAF', 600)
), lv(level, per_txn, daily, monthly) AS (VALUES
  (1, 300, 1000, 5000), (2, 3000, 20000, 200000), (3, 30000, 200000, 2000000)
), scaled AS (
  SELECT lv.level, c.code,
         (lv.per_txn::numeric * fx.units_per_usd * power(10::numeric, c.exponent))::bigint AS per_txn,
         (lv.daily::numeric * fx.units_per_usd * power(10::numeric, c.exponent))::bigint AS daily,
         (lv.monthly::numeric * fx.units_per_usd * power(10::numeric, c.exponent))::bigint AS monthly
    FROM lv CROSS JOIN fx JOIN core.currencies c ON c.code = fx.code
)
INSERT INTO core.kyc_level_limits
  (level, currency, applies_when, per_txn_max_minor, daily_volume_max_minor, monthly_volume_max_minor,
   payout_per_txn_max_minor, daily_payout_max_minor)
SELECT level, code, 'approved', per_txn, daily, monthly, per_txn, daily FROM scaled;--> statement-breakpoint
-- Seed: one monitoring rule per type, DISABLED and in UGX. The thresholds are starting
-- points for Compliance to review and enable per currency (docs/OPERATIONS.md).
INSERT INTO core.aml_rules (id, code, name, description, rule_type, params, severity, action, enabled, effective_from) VALUES
  (core.gen_uuid_v7(), 'velocity.count.hourly', 'Payment count velocity', 'More payments in an hour than a merchant of this size should see.', 'velocity',
   '{"measure":"count","currency":"UGX","windowSeconds":3600,"max":100,"statuses":["succeeded"]}', 'medium', 'flag', false, now()),
  (core.gen_uuid_v7(), 'velocity.value.daily', 'Payment value velocity', 'More value in a day than a merchant of this size should see.', 'velocity',
   '{"measure":"value","currency":"UGX","windowSeconds":86400,"maxMinor":"500000000","statuses":["succeeded"]}', 'high', 'flag', false, now()),
  (core.gen_uuid_v7(), 'threshold.single_payment', 'Large single payment', 'A single payment at or above the reporting threshold.', 'amount_threshold',
   '{"currency":"UGX","thresholdMinor":"20000000","statuses":["succeeded"]}', 'medium', 'flag', false, now()),
  (core.gen_uuid_v7(), 'structuring.below_threshold', 'Structuring', 'Repeated payments just under the reporting threshold.', 'structuring',
   '{"currency":"UGX","thresholdMinor":"20000000","bandBps":1000,"windowSeconds":86400,"minCount":3,"statuses":["succeeded"]}', 'high', 'flag', false, now()),
  (core.gen_uuid_v7(), 'geography.flagged_prefix', 'Flagged geography', 'Payers whose phone number starts with a flagged calling code.', 'geography',
   '{"currency":"UGX","flaggedPrefixes":[],"statuses":["succeeded"]}', 'medium', 'flag', false, now()),
  (core.gen_uuid_v7(), 'new_account.burst', 'New account burst', 'A new merchant taking many payments quickly.', 'new_account',
   '{"currency":"UGX","accountAgeDays":30,"windowSeconds":3600,"measure":"count","max":20,"statuses":["succeeded"]}', 'medium', 'flag', false, now()),
  (core.gen_uuid_v7(), 'round_amount.repeated', 'Repeated round amounts', 'Many large payments in exact round amounts.', 'round_amount',
   '{"currency":"UGX","roundUnitMinor":"1000000","minAmountMinor":"5000000","windowSeconds":86400,"minCount":5,"statuses":["succeeded"]}', 'low', 'flag', false, now()),
  (core.gen_uuid_v7(), 'counterparty.reuse', 'Counterparty reuse', 'The same payer paying one merchant many times.', 'counterparty_reuse',
   '{"currency":"UGX","scope":"merchant","windowSeconds":86400,"minCount":10,"statuses":["succeeded"]}', 'medium', 'flag', false, now());--> statement-breakpoint
INSERT INTO core.aml_rule_versions (id, rule_id, version, snapshot, reason)
SELECT core.gen_uuid_v7(), id, 1,
       jsonb_build_object('code', code, 'ruleType', rule_type, 'params', params, 'severity', severity,
                          'action', action, 'enabled', enabled),
       'seeded by migration 0007'
  FROM core.aml_rules;--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Permissions (spec 7.2, 7.3, 11). Keep in step with src/common/authz/permissions.ts. A key
-- cannot belong to both a staff and a merchant role, so the merchant KYC permissions are
-- `kyc:view` and `kyc:submit`, and staff use `kyc:read`.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('kyc:read', 'staff', 'Read the KYC queue, profiles, requirements and verification history'),
  ('kyc:review', 'staff', 'Verify or reject documents, record verifications, request information and reject KYC'),
  ('kyc:approve', 'staff', 'Approve KYC (never someone who verified that submission''s documents)'),
  ('kyc:view_documents', 'staff', 'Open a KYC document (every view is audited)'),
  ('kyc:requirements', 'staff', 'Create, change and deactivate KYC requirements'),
  ('aml:read', 'staff', 'Read AML alerts, cases, rules, screenings, blocks and the blocklist'),
  ('aml:work', 'staff', 'Work alerts and cases, run and decide screenings'),
  ('aml:rules', 'staff', 'Create and change AML monitoring rules'),
  ('aml:blocklist', 'staff', 'Add to and remove from the blocklist'),
  ('aml:block', 'staff', 'Block and unblock a merchant'),
  ('aml:str', 'staff', 'Generate STR packages and record STR filing'),
  ('chargebacks:read', 'staff', 'Read disputes and chargebacks'),
  ('chargebacks:work', 'staff', 'Record and investigate disputes'),
  ('chargebacks:resolve', 'staff', 'Resolve a dispute, which releases or captures its hold'),
  ('kyc:view', 'merchant', 'See the KYC status, requirements and uploaded documents'),
  ('kyc:submit', 'merchant', 'Provide KYC details and documents, and submit for review'),
  ('disputes:read', 'merchant', 'See disputes and chargebacks against the business'),
  ('disputes:write', 'merchant', 'Respond to a dispute with evidence');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('super_admin', 'kyc:read'), ('super_admin', 'kyc:review'), ('super_admin', 'kyc:approve'),
  ('super_admin', 'kyc:view_documents'), ('super_admin', 'kyc:requirements'),
  ('super_admin', 'aml:read'), ('super_admin', 'aml:work'), ('super_admin', 'aml:rules'),
  ('super_admin', 'aml:blocklist'), ('super_admin', 'aml:block'), ('super_admin', 'aml:str'),
  ('super_admin', 'chargebacks:read'), ('super_admin', 'chargebacks:work'), ('super_admin', 'chargebacks:resolve'),
  ('compliance', 'kyc:read'), ('compliance', 'kyc:review'), ('compliance', 'kyc:approve'),
  ('compliance', 'kyc:view_documents'), ('compliance', 'kyc:requirements'),
  ('compliance', 'aml:read'), ('compliance', 'aml:work'), ('compliance', 'aml:rules'),
  ('compliance', 'aml:blocklist'), ('compliance', 'aml:block'), ('compliance', 'aml:str'),
  ('compliance', 'chargebacks:read'), ('compliance', 'chargebacks:work'), ('compliance', 'chargebacks:resolve'),
  ('operations', 'kyc:read'), ('operations', 'aml:read'), ('operations', 'chargebacks:read'), ('operations', 'chargebacks:work'),
  ('support_agent', 'kyc:read'), ('support_agent', 'chargebacks:read'),
  ('auditor', 'kyc:read'), ('auditor', 'aml:read'), ('auditor', 'chargebacks:read'),
  ('owner', 'kyc:view'), ('owner', 'kyc:submit'), ('owner', 'disputes:read'), ('owner', 'disputes:write'),
  ('admin', 'kyc:view'), ('admin', 'kyc:submit'), ('admin', 'disputes:read'), ('admin', 'disputes:write'),
  ('finance', 'kyc:view'), ('finance', 'disputes:read'), ('finance', 'disputes:write'),
  ('support', 'kyc:view'), ('support', 'disputes:read'),
  ('viewer', 'kyc:view'), ('viewer', 'disputes:read');
