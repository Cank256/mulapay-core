CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"merchant_id" uuid,
	"surface" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device" text,
	"ip" text,
	"user_agent" text,
	"amr" text[] NOT NULL,
	"mfa" boolean NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_surface_check" CHECK ("core"."sessions"."surface" in ('dashboard', 'admin')),
	CONSTRAINT "sessions_revoked_reason_check" CHECK ("core"."sessions"."revoked_reason" is null or "core"."sessions"."revoked_reason" in ('rotated', 'logout', 'revoked_by_user', 'reuse_detected', 'user_disabled', 'access_removed'))
);
--> statement-breakpoint
CREATE TABLE "core"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"type" text NOT NULL,
	"email" "core.citext" NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mfa_secret_enc" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_last_used_step" bigint,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_type_check" CHECK ("core"."users"."type" in ('staff', 'merchant_user')),
	CONSTRAINT "users_status_check" CHECK ("core"."users"."status" in ('active', 'disabled')),
	CONSTRAINT "users_failed_login_count_check" CHECK ("core"."users"."failed_login_count" >= 0),
	CONSTRAINT "users_mfa_enabled_secret_check" CHECK (not "core"."users"."mfa_enabled" or "core"."users"."mfa_secret_enc" is not null)
);
--> statement-breakpoint
CREATE TABLE "core"."permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_actor_type_check" CHECK ("core"."permissions"."actor_type" in ('staff', 'merchant')),
	CONSTRAINT "permissions_key_format_check" CHECK ("core"."permissions"."key" ~ '^[a-z_]+:[a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "core"."role_permissions" (
	"role_key" text NOT NULL,
	"permission_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_key_permission_key_pk" PRIMARY KEY("role_key","permission_key")
);
--> statement-breakpoint
CREATE TABLE "core"."roles" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_actor_type_check" CHECK ("core"."roles"."actor_type" in ('staff', 'merchant'))
);
--> statement-breakpoint
CREATE TABLE "core"."staff_role_assignments" (
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_role_assignments_user_id_role_key_pk" PRIMARY KEY("user_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "core"."invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" "core.citext" NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_check" CHECK ("core"."invitations"."role" in ('owner', 'admin', 'developer', 'finance', 'support', 'viewer')),
	CONSTRAINT "invitations_single_outcome_check" CHECK ("core"."invitations"."accepted_at" is null or "core"."invitations"."revoked_at" is null)
);
--> statement-breakpoint
CREATE TABLE "core"."merchant_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_members_role_check" CHECK ("core"."merchant_members"."role" in ('owner', 'admin', 'developer', 'finance', 'support', 'viewer')),
	CONSTRAINT "merchant_members_status_check" CHECK ("core"."merchant_members"."status" in ('active', 'removed')),
	CONSTRAINT "merchant_members_removed_at_check" CHECK (("core"."merchant_members"."status" = 'removed') = ("core"."merchant_members"."removed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "core"."merchants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text,
	"country" char(2) NOT NULL,
	"default_currency" char(3) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"kyc_level" smallint DEFAULT 0 NOT NULL,
	"risk_rating" text,
	"fee_plan_id" uuid,
	"settlement_cycle_id" uuid,
	"mcc" char(4),
	"website" text,
	"support_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_status_check" CHECK ("core"."merchants"."status" in ('draft', 'pending_kyc', 'active', 'suspended', 'closed')),
	CONSTRAINT "merchants_kyc_level_check" CHECK ("core"."merchants"."kyc_level" between 0 and 3),
	CONSTRAINT "merchants_risk_rating_check" CHECK ("core"."merchants"."risk_rating" is null or "core"."merchants"."risk_rating" in ('low', 'medium', 'high')),
	CONSTRAINT "merchants_country_check" CHECK ("core"."merchants"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "merchants_default_currency_check" CHECK ("core"."merchants"."default_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "merchants_mcc_check" CHECK ("core"."merchants"."mcc" is null or "core"."merchants"."mcc" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "core"."api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"key_id" text NOT NULL,
	"kind" text DEFAULT 'secret' NOT NULL,
	"secret_hash" text,
	"allowed_origins" text[],
	"name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"ip_allowlist" "cidr"[],
	"rate_limit_rpm" integer,
	"signing_secret_enc" text,
	"signing_required" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"rolled_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_environment_check" CHECK ("core"."api_keys"."environment" in ('test', 'live')),
	CONSTRAINT "api_keys_key_id_format_check" CHECK ("core"."api_keys"."key_id" ~ '^[a-z0-9]{16}$'),
	CONSTRAINT "api_keys_secret_hash_format_check" CHECK ("core"."api_keys"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_kind_check" CHECK ("core"."api_keys"."kind" in ('secret', 'publishable')),
	CONSTRAINT "api_keys_secret_presence_check" CHECK (("core"."api_keys"."kind" = 'secret') = ("core"."api_keys"."secret_hash" is not null)),
	CONSTRAINT "api_keys_publishable_unsigned_check" CHECK ("core"."api_keys"."kind" = 'secret' or ("core"."api_keys"."signing_secret_enc" is null and not "core"."api_keys"."signing_required")),
	CONSTRAINT "api_keys_allowed_origins_check" CHECK ("core"."api_keys"."kind" = 'publishable' or "core"."api_keys"."allowed_origins" is null),
	CONSTRAINT "api_keys_scopes_nonempty_check" CHECK (cardinality("core"."api_keys"."scopes") > 0),
	CONSTRAINT "api_keys_signing_check" CHECK (not "core"."api_keys"."signing_required" or "core"."api_keys"."signing_secret_enc" is not null),
	CONSTRAINT "api_keys_rate_limit_check" CHECK ("core"."api_keys"."rate_limit_rpm" is null or "core"."api_keys"."rate_limit_rpm" between 1 and 100000)
);
--> statement-breakpoint
CREATE TABLE "core"."audit_chain_head" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" text NOT NULL,
	CONSTRAINT "audit_chain_head_singleton_check" CHECK ("core"."audit_chain_head"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "core"."audit_logs" (
	"seq" bigint NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"merchant_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"changed_fields" text[] NOT NULL,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"trace_id" text,
	"surface" text,
	"outcome" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_logs_seq_created_at_pk" PRIMARY KEY("seq","created_at"),
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("core"."audit_logs"."actor_type" in ('user', 'api_key', 'system', 'job')),
	CONSTRAINT "audit_logs_outcome_check" CHECK ("core"."audit_logs"."outcome" in ('success', 'denied', 'error')),
	CONSTRAINT "audit_logs_hash_format_check" CHECK ("core"."audit_logs"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "core"."account_balances" (
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"posted_debits_minor" bigint DEFAULT 0 NOT NULL,
	"posted_credits_minor" bigint DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_balances_account_id_currency_pk" PRIMARY KEY("account_id","currency"),
	CONSTRAINT "account_balances_debits_check" CHECK ("core"."account_balances"."posted_debits_minor" >= 0),
	CONSTRAINT "account_balances_credits_check" CHECK ("core"."account_balances"."posted_credits_minor" >= 0),
	CONSTRAINT "account_balances_version_check" CHECK ("core"."account_balances"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"environment" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"normal_balance" text NOT NULL,
	"currency" char(3),
	"merchant_id" uuid,
	"provider" text,
	"purpose" text NOT NULL,
	"is_system" boolean NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_environment_check" CHECK ("core"."accounts"."environment" in ('test', 'live')),
	CONSTRAINT "accounts_ref_format_check" CHECK ("core"."accounts"."ref" ~ '^acct_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "accounts_code_format_check" CHECK ("core"."accounts"."code" ~ '^[0-9]{4}:[a-z_]+(:[A-Za-z0-9_]+)?$'),
	CONSTRAINT "accounts_type_check" CHECK ("core"."accounts"."type" in ('asset', 'liability', 'equity', 'revenue', 'expense')),
	CONSTRAINT "accounts_normal_balance_check" CHECK ("core"."accounts"."normal_balance" = case when "core"."accounts"."type" in ('asset', 'expense') then 'debit' else 'credit' end),
	CONSTRAINT "accounts_purpose_check" CHECK (split_part("core"."accounts"."code", ':', 2) = "core"."accounts"."purpose" and split_part("core"."accounts"."code", ':', 1) || ':' || "core"."accounts"."type" = case "core"."accounts"."purpose"
        when 'provider_clearing' then '1000:asset'
        when 'provider_float' then '1010:asset'
        when 'bank' then '1100:asset'
        when 'settlement_in_transit' then '1200:asset'
        when 'fx_clearing' then '1900:asset'
        when 'merchant_payable' then '2000:liability'
        when 'merchant_reserve' then '2010:liability'
        when 'refund_payable' then '2100:liability'
        when 'tax_payable' then '2200:liability'
        when 'fee_revenue' then '4000:revenue'
        when 'fx_revenue' then '4100:revenue'
        when 'provider_fee_expense' then '5000:expense'
        when 'loss_writeoff' then '5100:expense'
        when 'suspense' then '9000:asset'
      end),
	CONSTRAINT "accounts_scope_check" CHECK (case
        when "core"."accounts"."purpose" in ('merchant_payable', 'merchant_reserve')
          then "core"."accounts"."merchant_id" is not null and "core"."accounts"."provider" is null and split_part("core"."accounts"."code", ':', 3) ~ '^mch_[0-9A-HJKMNP-TV-Z]{26}$'
        when "core"."accounts"."purpose" in ('provider_clearing', 'provider_float')
          then "core"."accounts"."merchant_id" is null and "core"."accounts"."provider" is not null and split_part("core"."accounts"."code", ':', 3) = "core"."accounts"."provider"
        when "core"."accounts"."purpose" = 'bank'
          then "core"."accounts"."merchant_id" is null and "core"."accounts"."provider" is null and split_part("core"."accounts"."code", ':', 3) ~ '^[a-z0-9_]{2,40}$'
        else "core"."accounts"."merchant_id" is null and "core"."accounts"."provider" is null and split_part("core"."accounts"."code", ':', 3) = ''
      end),
	CONSTRAINT "accounts_provider_check" CHECK ("core"."accounts"."provider" is null or "core"."accounts"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "accounts_is_system_check" CHECK ("core"."accounts"."is_system" = ("core"."accounts"."merchant_id" is null)),
	CONSTRAINT "accounts_name_check" CHECK (char_length("core"."accounts"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "core"."currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"exponent" smallint NOT NULL,
	"name" text NOT NULL,
	"is_zero_decimal" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_code_check" CHECK ("core"."currencies"."code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "currencies_exponent_check" CHECK ("core"."currencies"."exponent" between 0 and 4),
	CONSTRAINT "currencies_zero_decimal_check" CHECK ("core"."currencies"."is_zero_decimal" = ("core"."currencies"."exponent" = 0))
);
--> statement-breakpoint
CREATE TABLE "core"."journal_entries" (
	"id" uuid NOT NULL,
	"ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"environment" text NOT NULL,
	"merchant_id" uuid,
	"currency" char(3) NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"transaction_id" uuid,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"reverses_entry_id" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "journal_entries_environment_check" CHECK ("core"."journal_entries"."environment" in ('test', 'live')),
	CONSTRAINT "journal_entries_ref_format_check" CHECK ("core"."journal_entries"."ref" ~ '^je_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "journal_entries_idempotency_key_check" CHECK ("core"."journal_entries"."idempotency_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "journal_entries_fingerprint_check" CHECK ("core"."journal_entries"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "journal_entries_source_check" CHECK ("core"."journal_entries"."source" in ('payment', 'payout', 'refund', 'fee', 'settlement', 'adjustment', 'reversal')),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("core"."journal_entries"."source" = 'reversal') = ("core"."journal_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "journal_entries_kind_check" CHECK ("core"."journal_entries"."kind" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "journal_entries_description_check" CHECK (char_length("core"."journal_entries"."description") between 1 and 500),
	CONSTRAINT "journal_entries_source_id_check" CHECK (char_length("core"."journal_entries"."source_id") between 1 and 128),
	CONSTRAINT "journal_entries_created_by_check" CHECK ("core"."journal_entries"."created_by" ~ '^(user|api_key|system|job):[A-Za-z0-9._:-]{1,128}$')
);
--> statement-breakpoint
CREATE TABLE "core"."journal_entry_keys" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"entry_ref" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"request_fingerprint" text NOT NULL,
	"reverses_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entry_keys_entry_id_key" UNIQUE("entry_id"),
	CONSTRAINT "journal_entry_keys_entry_ref_key" UNIQUE("entry_ref"),
	CONSTRAINT "journal_entry_keys_reverses_entry_id_key" UNIQUE("reverses_entry_id")
);
--> statement-breakpoint
CREATE TABLE "core"."journal_lines" (
	"entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"merchant_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_entry_id_line_no_created_at_pk" PRIMARY KEY("entry_id","line_no","created_at"),
	CONSTRAINT "journal_lines_direction_check" CHECK ("core"."journal_lines"."direction" in ('debit', 'credit')),
	CONSTRAINT "journal_lines_amount_positive_check" CHECK ("core"."journal_lines"."amount_minor" > 0),
	CONSTRAINT "journal_lines_line_no_check" CHECK ("core"."journal_lines"."line_no" between 1 and 100)
);
--> statement-breakpoint
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
);
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
);
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
);
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
CREATE TABLE "core"."incident_postmortems" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"root_cause" text NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_postmortems_summary_check" CHECK (char_length("core"."incident_postmortems"."summary") between 1 and 8000)
);
--> statement-breakpoint
CREATE TABLE "core"."incident_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_updates_status_check" CHECK ("core"."incident_updates"."status" in ('investigating', 'identified', 'monitoring', 'resolved')),
	CONSTRAINT "incident_updates_body_check" CHECK (char_length("core"."incident_updates"."body") between 1 and 4000)
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
	CONSTRAINT "incidents_source_check" CHECK ("core"."incidents"."source" in ('manual', 'reconciliation', 'consumer', 'monitor')),
	CONSTRAINT "incidents_public_message_check" CHECK (not "core"."incidents"."public" or "core"."incidents"."public_message" is not null)
);
--> statement-breakpoint
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
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"due_soon_notified_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
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
CREATE TABLE "core"."complaint_categories" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"sla_hours" integer NOT NULL,
	"default_priority" text DEFAULT 'normal' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaint_categories_code_check" CHECK ("core"."complaint_categories"."code" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "complaint_categories_sla_check" CHECK ("core"."complaint_categories"."sla_hours" between 1 and 2160),
	CONSTRAINT "complaint_categories_priority_check" CHECK ("core"."complaint_categories"."default_priority" in ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "core"."complaint_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"complaint_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaint_messages_author_type_check" CHECK ("core"."complaint_messages"."author_type" in ('merchant', 'admin', 'system', 'customer')),
	CONSTRAINT "complaint_messages_body_check" CHECK (char_length("core"."complaint_messages"."body") between 1 and 5000),
	CONSTRAINT "complaint_messages_internal_check" CHECK (not "core"."complaint_messages"."internal" or "core"."complaint_messages"."author_type" in ('admin', 'system'))
);
--> statement-breakpoint
CREATE TABLE "core"."complaints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"transaction_id" uuid,
	"customer_contact_enc" text,
	"priority" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"breached" boolean DEFAULT false NOT NULL,
	"breached_at" timestamp with time zone,
	"breach_notified_at" timestamp with time zone,
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"closed_at" timestamp with time zone,
	"satisfaction_score" smallint,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_ref_check" CHECK ("core"."complaints"."ref" ~ '^cmp_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "complaints_source_check" CHECK ("core"."complaints"."source" in ('merchant', 'customer', 'admin')),
	CONSTRAINT "complaints_priority_check" CHECK ("core"."complaints"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "complaints_status_check" CHECK ("core"."complaints"."status" in ('open', 'in_progress', 'awaiting_customer', 'escalated', 'resolved', 'closed')),
	CONSTRAINT "complaints_subject_check" CHECK (char_length("core"."complaints"."subject") between 1 and 200),
	CONSTRAINT "complaints_description_check" CHECK (char_length("core"."complaints"."description") between 1 and 5000),
	CONSTRAINT "complaints_merchant_source_check" CHECK ("core"."complaints"."source" <> 'merchant' or "core"."complaints"."merchant_id" is not null),
	CONSTRAINT "complaints_resolved_check" CHECK (("core"."complaints"."status" in ('resolved', 'closed')) = ("core"."complaints"."resolved_at" is not null or "core"."complaints"."closed_at" is not null)),
	CONSTRAINT "complaints_breach_check" CHECK ("core"."complaints"."breached" = ("core"."complaints"."breached_at" is not null)),
	CONSTRAINT "complaints_satisfaction_check" CHECK ("core"."complaints"."satisfaction_score" is null or "core"."complaints"."satisfaction_score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "core"."dispute_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispute_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_notes_body_check" CHECK (char_length("core"."dispute_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "core"."notification_deliveries" (
	"id" uuid NOT NULL,
	"ref" text NOT NULL,
	"notification_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"channel" text NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("core"."notification_deliveries"."channel" in ('email', 'sms', 'push', 'in_app')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("core"."notification_deliveries"."status" in ('pending', 'sent', 'delivered', 'failed')),
	CONSTRAINT "notification_deliveries_attempts_check" CHECK ("core"."notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."notification_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address_enc" text NOT NULL,
	"address_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_destinations_channel_check" CHECK ("core"."notification_destinations"."channel" in ('sms', 'push'))
);
--> statement-breakpoint
CREATE TABLE "core"."notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_channel_check" CHECK ("core"."notification_preferences"."channel" in ('email', 'sms', 'push', 'in_app'))
);
--> statement-breakpoint
CREATE TABLE "core"."notification_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"audience" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_code_check" CHECK ("core"."notification_templates"."code" ~ '^[a-z][a-z0-9_.]{2,80}$'),
	CONSTRAINT "notification_templates_channel_check" CHECK ("core"."notification_templates"."channel" in ('email', 'sms', 'push', 'in_app')),
	CONSTRAINT "notification_templates_audience_check" CHECK ("core"."notification_templates"."audience" in ('staff', 'merchant', 'any')),
	CONSTRAINT "notification_templates_body_check" CHECK (char_length("core"."notification_templates"."body") between 1 and 5000),
	CONSTRAINT "notification_templates_subject_check" CHECK ("core"."notification_templates"."subject" is null or char_length("core"."notification_templates"."subject") between 1 and 200),
	CONSTRAINT "notification_templates_subject_channel_check" CHECK ("core"."notification_templates"."channel" not in ('email', 'push', 'in_app') or "core"."notification_templates"."subject" is not null)
);
--> statement-breakpoint
CREATE TABLE "core"."notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"recipient_type" text DEFAULT 'user' NOT NULL,
	"recipient_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template_code" text NOT NULL,
	"resource_key" text NOT NULL,
	"source_key" text,
	"title" text,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_ref_check" CHECK ("core"."notifications"."ref" ~ '^ntf_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "notifications_channel_check" CHECK ("core"."notifications"."channel" in ('email', 'sms', 'push', 'in_app')),
	CONSTRAINT "notifications_recipient_type_check" CHECK ("core"."notifications"."recipient_type" in ('user', 'merchant', 'admin_group')),
	CONSTRAINT "notifications_read_check" CHECK ("core"."notifications"."read_at" is null or "core"."notifications"."channel" = 'in_app')
);
--> statement-breakpoint
CREATE TABLE "core"."daily_merchant_rollups" (
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"payment_minor" bigint DEFAULT 0 NOT NULL,
	"refund_count" integer DEFAULT 0 NOT NULL,
	"refund_minor" bigint DEFAULT 0 NOT NULL,
	"payout_count" integer DEFAULT 0 NOT NULL,
	"payout_minor" bigint DEFAULT 0 NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_merchant_rollups_merchant_id_environment_date_currency_channel_provider_pk" PRIMARY KEY("merchant_id","environment","date","currency","channel","provider"),
	CONSTRAINT "daily_merchant_rollups_environment_check" CHECK ("core"."daily_merchant_rollups"."environment" in ('test', 'live')),
	CONSTRAINT "daily_merchant_rollups_counts_check" CHECK ("core"."daily_merchant_rollups"."payment_count" >= 0 and "core"."daily_merchant_rollups"."refund_count" >= 0 and "core"."daily_merchant_rollups"."payout_count" >= 0
        and "core"."daily_merchant_rollups"."success_count" >= 0 and "core"."daily_merchant_rollups"."failure_count" >= 0
        and "core"."daily_merchant_rollups"."payment_minor" >= 0 and "core"."daily_merchant_rollups"."refund_minor" >= 0 and "core"."daily_merchant_rollups"."payout_minor" >= 0 and "core"."daily_merchant_rollups"."fee_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."report_schedule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"report_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_schedule_runs_status_check" CHECK ("core"."report_schedule_runs"."status" in ('queued', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "core"."report_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid,
	"environment" text,
	"report_type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"period" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_status" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_ref_check" CHECK ("core"."report_schedules"."ref" ~ '^rsc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "report_schedules_type_check" CHECK ("core"."report_schedules"."report_type" in ('transactions', 'payments', 'payouts', 'refunds', 'fees', 'balance_statement', 'ledger_account_statement', 'settlement_statement', 'reconciliation_exceptions', 'aml_alerts', 'kyc_status', 'audit_trail', 'merchant_performance')),
	CONSTRAINT "report_schedules_format_check" CHECK ("core"."report_schedules"."format" in ('csv', 'json')),
	CONSTRAINT "report_schedules_period_check" CHECK ("core"."report_schedules"."period" in ('previous_day', 'previous_week', 'previous_month')),
	CONSTRAINT "report_schedules_recipients_check" CHECK (cardinality("core"."report_schedules"."recipients") between 1 and 10),
	CONSTRAINT "report_schedules_environment_check" CHECK ("core"."report_schedules"."environment" is null or "core"."report_schedules"."environment" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "core"."reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"merchant_id" uuid,
	"environment" text,
	"type" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"row_count" bigint,
	"file_key" text,
	"file_size" bigint,
	"sha256" text,
	"requested_by" uuid,
	"schedule_id" uuid,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_ref_check" CHECK ("core"."reports"."ref" ~ '^rpt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "reports_type_check" CHECK ("core"."reports"."type" in ('transactions', 'payments', 'payouts', 'refunds', 'fees', 'balance_statement', 'ledger_account_statement', 'settlement_statement', 'reconciliation_exceptions', 'aml_alerts', 'kyc_status', 'audit_trail', 'merchant_performance')),
	CONSTRAINT "reports_format_check" CHECK ("core"."reports"."format" in ('csv', 'json')),
	CONSTRAINT "reports_status_check" CHECK ("core"."reports"."status" in ('queued', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "reports_environment_check" CHECK ("core"."reports"."environment" is null or "core"."reports"."environment" in ('test', 'live')),
	CONSTRAINT "reports_ready_check" CHECK (("core"."reports"."status" in ('ready', 'expired')) = ("core"."reports"."file_key" is not null and "core"."reports"."row_count" is not null and "core"."reports"."file_size" is not null)),
	CONSTRAINT "reports_attempts_check" CHECK ("core"."reports"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."approval_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_decisions_decision_check" CHECK ("core"."approval_decisions"."decision" in ('approve', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "core"."approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"required_approvals" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_ref_check" CHECK ("core"."approvals"."ref" ~ '^apr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "approvals_kind_check" CHECK ("core"."approvals"."kind" in ('consumer_cursor.rewind', 'feature_flag.change', 'provider.disable', 'routing_rule.remove')),
	CONSTRAINT "approvals_status_check" CHECK ("core"."approvals"."status" in ('pending', 'approved', 'rejected', 'expired')),
	CONSTRAINT "approvals_required_check" CHECK ("core"."approvals"."required_approvals" between 1 and 5),
	CONSTRAINT "approvals_reason_check" CHECK (char_length("core"."approvals"."reason") between 1 and 1000),
	CONSTRAINT "approvals_decided_check" CHECK (("core"."approvals"."status" in ('approved', 'rejected')) = ("core"."approvals"."decided_at" is not null)),
	CONSTRAINT "approvals_executed_check" CHECK ("core"."approvals"."executed_at" is null or "core"."approvals"."status" = 'approved')
);
--> statement-breakpoint
CREATE TABLE "core"."consumer_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"holder" text,
	"heartbeat_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_cursors_position_check" CHECK ("core"."consumer_cursors"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percent" smallint DEFAULT 100 NOT NULL,
	"merchant_allowlist" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_check" CHECK ("core"."feature_flags"."key" ~ '^[a-z][a-z0-9_.]{2,60}$'),
	CONSTRAINT "feature_flags_rollout_check" CHECK ("core"."feature_flags"."rollout_percent" between 0 and 100),
	CONSTRAINT "feature_flags_allowlist_check" CHECK (cardinality("core"."feature_flags"."merchant_allowlist") <= 500)
);
--> statement-breakpoint
CREATE TABLE "core"."maintenance_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"message" text,
	"retry_after_seconds" integer DEFAULT 60 NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_state_singleton_check" CHECK ("core"."maintenance_state"."id"),
	CONSTRAINT "maintenance_state_retry_check" CHECK ("core"."maintenance_state"."retry_after_seconds" between 1 and 86400)
);
--> statement-breakpoint
CREATE TABLE "core"."ops_signals" (
	"signal_key" text PRIMARY KEY NOT NULL,
	"active_since" timestamp with time zone,
	"last_observed_at" timestamp with time zone NOT NULL,
	"last_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."provider_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" text DEFAULT 'healthy' NOT NULL,
	"note" text,
	"success_rate_5m" numeric(5, 4),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_status_provider_check" CHECK ("core"."provider_status"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "provider_status_health_check" CHECK ("core"."provider_status"."health" in ('healthy', 'degraded', 'down')),
	CONSTRAINT "provider_status_note_check" CHECK ("core"."provider_status"."note" is null or char_length("core"."provider_status"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "core"."routing_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"priority" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"country" text DEFAULT '*' NOT NULL,
	"channel" text DEFAULT '*' NOT NULL,
	"min_amount_minor" bigint,
	"max_amount_minor" bigint,
	"msisdn_prefix" text,
	"provider" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_rules_ref_check" CHECK ("core"."routing_rules"."ref" ~ '^rrl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "routing_rules_provider_check" CHECK ("core"."routing_rules"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "routing_rules_priority_check" CHECK ("core"."routing_rules"."priority" between 0 and 10000),
	CONSTRAINT "routing_rules_weight_check" CHECK ("core"."routing_rules"."weight" between 1 and 1000),
	CONSTRAINT "routing_rules_country_check" CHECK ("core"."routing_rules"."country" = '*' or "core"."routing_rules"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "routing_rules_channel_check" CHECK ("core"."routing_rules"."channel" in ('*', 'mobile_money', 'card', 'bank')),
	CONSTRAINT "routing_rules_amount_check" CHECK (("core"."routing_rules"."min_amount_minor" is null or "core"."routing_rules"."min_amount_minor" >= 0)
        and ("core"."routing_rules"."max_amount_minor" is null or "core"."routing_rules"."max_amount_minor" > 0)
        and ("core"."routing_rules"."min_amount_minor" is null or "core"."routing_rules"."max_amount_minor" is null or "core"."routing_rules"."min_amount_minor" <= "core"."routing_rules"."max_amount_minor")),
	CONSTRAINT "routing_rules_msisdn_check" CHECK ("core"."routing_rules"."msisdn_prefix" is null or "core"."routing_rules"."msisdn_prefix" ~ '^\+[0-9]{1,8}$')
);
--> statement-breakpoint
CREATE TABLE "gateway_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gateway_event_id" uuid NOT NULL,
	"gateway_id" bigint NOT NULL,
	"operation_id" text,
	"provider_id" text NOT NULL,
	"operation_type" text NOT NULL,
	"external_id" text NOT NULL,
	"reference_id" text,
	"provider_transaction_id" text,
	"status" text NOT NULL,
	"previous_status" text,
	"amount" numeric(15, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"apply_status" text DEFAULT 'pending' NOT NULL,
	"apply_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gateway_events_gateway_event_id_unique" UNIQUE("gateway_event_id"),
	CONSTRAINT "gateway_events_operation_type_check" CHECK ("gateway_events"."operation_type" IN ('collection', 'disbursement', 'refund')),
	CONSTRAINT "gateway_events_status_check" CHECK ("gateway_events"."status" IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "gateway_events_previous_status_check" CHECK ("gateway_events"."previous_status" IS NULL OR "gateway_events"."previous_status" IN ('pending', 'unknown', 'successful', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "gateway_events_source_check" CHECK ("gateway_events"."source" IN ('provider_response', 'callback', 'reconciliation')),
	CONSTRAINT "gateway_events_apply_status_check" CHECK ("gateway_events"."apply_status" IN ('pending', 'applied', 'skipped', 'failed')),
	CONSTRAINT "gateway_events_attempts_check" CHECK ("gateway_events"."attempts" >= 0),
	CONSTRAINT "gateway_events_gateway_id_check" CHECK ("gateway_events"."gateway_id" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gateway_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" bigint,
	"provider" text NOT NULL,
	"operation_type" text NOT NULL,
	"external_id" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error_code" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_requests_operation_type_check" CHECK ("gateway_requests"."operation_type" IN ('collection', 'disbursement', 'refund', 'query', 'balance')),
	CONSTRAINT "gateway_requests_attempt_check" CHECK ("gateway_requests"."attempt" >= 0),
	CONSTRAINT "gateway_requests_latency_check" CHECK ("gateway_requests"."latency_ms" IS NULL OR "gateway_requests"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
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
	CONSTRAINT "payouts_ref_unique" UNIQUE("ref"),
	CONSTRAINT "payouts_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "payouts_environment_check" CHECK ("payouts"."environment" in ('test', 'live')),
	CONSTRAINT "payouts_ref_format_check" CHECK ("payouts"."ref" ~ '^pyt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "payouts_amount_check" CHECK ("payouts"."amount_minor" > 0),
	CONSTRAINT "payouts_channel_check" CHECK ("payouts"."channel" in ('mobile_money', 'bank')),
	CONSTRAINT "payouts_idempotency_key_check" CHECK (char_length("payouts"."idempotency_key") between 1 and 255),
	CONSTRAINT "payouts_currency_check" CHECK ("payouts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "refunds" (
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
	CONSTRAINT "refunds_ref_unique" UNIQUE("ref"),
	CONSTRAINT "refunds_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "refunds_environment_check" CHECK ("refunds"."environment" in ('test', 'live')),
	CONSTRAINT "refunds_ref_format_check" CHECK ("refunds"."ref" ~ '^rfd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_idempotency_key_check" CHECK (char_length("refunds"."idempotency_key") between 1 and 255),
	CONSTRAINT "refunds_currency_check" CHECK ("refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_reason_check" CHECK ("refunds"."reason" is null or char_length("refunds"."reason") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "core"."fee_plan_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fee_plan_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"provider" text,
	"currency" text,
	"channel" text,
	"percent_bps" smallint DEFAULT 0 NOT NULL,
	"fixed_minor" bigint DEFAULT 0 NOT NULL,
	"min_minor" bigint DEFAULT 0 NOT NULL,
	"max_minor" bigint DEFAULT 0 NOT NULL,
	"tier_from_minor" bigint DEFAULT 0 NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_plan_rules_operation_type_check" CHECK ("core"."fee_plan_rules"."operation_type" in ('payment', 'payout', 'refund')),
	CONSTRAINT "fee_plan_rules_provider_check" CHECK ("core"."fee_plan_rules"."provider" is null or "core"."fee_plan_rules"."provider" in ('mtn', 'airtel', 'flutterwave')),
	CONSTRAINT "fee_plan_rules_currency_check" CHECK ("core"."fee_plan_rules"."currency" is null or "core"."fee_plan_rules"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fee_plan_rules_channel_check" CHECK ("core"."fee_plan_rules"."channel" is null or "core"."fee_plan_rules"."channel" in ('mobile_money', 'card', 'bank')),
	CONSTRAINT "fee_plan_rules_percent_bps_check" CHECK ("core"."fee_plan_rules"."percent_bps" >= 0 and "core"."fee_plan_rules"."percent_bps" <= 10000),
	CONSTRAINT "fee_plan_rules_fixed_minor_check" CHECK ("core"."fee_plan_rules"."fixed_minor" >= 0),
	CONSTRAINT "fee_plan_rules_min_minor_check" CHECK ("core"."fee_plan_rules"."min_minor" >= 0),
	CONSTRAINT "fee_plan_rules_max_minor_check" CHECK ("core"."fee_plan_rules"."max_minor" >= 0 and ("core"."fee_plan_rules"."max_minor" = 0 or "core"."fee_plan_rules"."max_minor" >= "core"."fee_plan_rules"."min_minor")),
	CONSTRAINT "fee_plan_rules_tier_from_minor_check" CHECK ("core"."fee_plan_rules"."tier_from_minor" >= 0),
	CONSTRAINT "fee_plan_rules_priority_check" CHECK ("core"."fee_plan_rules"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."fee_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"merchant_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_plans_ref_format_check" CHECK ("core"."fee_plans"."ref" ~ '^fp_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "fee_plans_name_check" CHECK (char_length("core"."fee_plans"."name") between 1 and 200),
	CONSTRAINT "fee_plans_version_check" CHECK ("core"."fee_plans"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "core"."roles"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "core"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "core"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_members" ADD CONSTRAINT "merchant_members_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_members" ADD CONSTRAINT "merchant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_members" ADD CONSTRAINT "merchant_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."account_balances" ADD CONSTRAINT "account_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."account_balances" ADD CONSTRAINT "account_balances_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."accounts" ADD CONSTRAINT "accounts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_registry_fk" FOREIGN KEY ("id") REFERENCES "core"."journal_entry_keys"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_entry_keys" ADD CONSTRAINT "journal_entry_keys_reverses_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "core"."journal_entry_keys"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_lines" ADD CONSTRAINT "journal_lines_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("entry_id","created_at") REFERENCES "core"."journal_entries"("id","created_at") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_request_logs" ADD CONSTRAINT "api_request_logs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."api_request_logs" ADD CONSTRAINT "api_request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "core"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."merchant_events" ADD CONSTRAINT "merchant_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "core"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_merchant_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."merchant_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "core"."incident_postmortems" ADD CONSTRAINT "incident_postmortems_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_postmortems" ADD CONSTRAINT "incident_postmortems_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_updates" ADD CONSTRAINT "incident_updates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_updates" ADD CONSTRAINT "incident_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaint_messages" ADD CONSTRAINT "complaint_messages_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "core"."complaints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaint_messages" ADD CONSTRAINT "complaint_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaints" ADD CONSTRAINT "complaints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaints" ADD CONSTRAINT "complaints_category_complaint_categories_code_fk" FOREIGN KEY ("category") REFERENCES "core"."complaint_categories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaints" ADD CONSTRAINT "complaints_transaction_id_transaction_keys_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transaction_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaints" ADD CONSTRAINT "complaints_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."complaints" ADD CONSTRAINT "complaints_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dispute_notes" ADD CONSTRAINT "dispute_notes_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "core"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dispute_notes" ADD CONSTRAINT "dispute_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "core"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_destinations" ADD CONSTRAINT "notification_destinations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."daily_merchant_rollups" ADD CONSTRAINT "daily_merchant_rollups_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."daily_merchant_rollups" ADD CONSTRAINT "daily_merchant_rollups_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."report_schedule_runs" ADD CONSTRAINT "report_schedule_runs_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "core"."report_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."report_schedule_runs" ADD CONSTRAINT "report_schedule_runs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "core"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."report_schedules" ADD CONSTRAINT "report_schedules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."report_schedules" ADD CONSTRAINT "report_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reports" ADD CONSTRAINT "reports_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reports" ADD CONSTRAINT "reports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."approval_decisions" ADD CONSTRAINT "approval_decisions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "core"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."approval_decisions" ADD CONSTRAINT "approval_decisions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."feature_flags" ADD CONSTRAINT "feature_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."maintenance_state" ADD CONSTRAINT "maintenance_state_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."provider_status" ADD CONSTRAINT "provider_status_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."routing_rules" ADD CONSTRAINT "routing_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_requests" ADD CONSTRAINT "gateway_requests_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "core"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "core"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fee_plan_rules" ADD CONSTRAINT "fee_plan_rules_fee_plan_id_fee_plans_id_fk" FOREIGN KEY ("fee_plan_id") REFERENCES "core"."fee_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fee_plans" ADD CONSTRAINT "fee_plans_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "core"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "core"."sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "core"."sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "core"."sessions" USING btree ("user_id","expires_at") WHERE "core"."sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_ref_key" ON "core"."users" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "core"."users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "staff_role_assignments_role_idx" ON "core"."staff_role_assignments" USING btree ("role_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_ref_key" ON "core"."invitations" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "core"."invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending_key" ON "core"."invitations" USING btree ("merchant_id","email") WHERE "core"."invitations"."accepted_at" is null and "core"."invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_merchant_created_idx" ON "core"."invitations" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_members_merchant_user_key" ON "core"."merchant_members" USING btree ("merchant_id","user_id");--> statement-breakpoint
CREATE INDEX "merchant_members_user_idx" ON "core"."merchant_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_members_one_owner_key" ON "core"."merchant_members" USING btree ("merchant_id") WHERE "core"."merchant_members"."role" = 'owner' and "core"."merchant_members"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_ref_key" ON "core"."merchants" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "merchants_created_idx" ON "core"."merchants" USING btree ("created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchants_status_created_idx" ON "core"."merchants" USING btree ("status","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_ref_key" ON "core"."api_keys" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_id_key" ON "core"."api_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "api_keys_merchant_revoked_idx" ON "core"."api_keys" USING btree ("merchant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "core"."audit_logs" USING btree ("created_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_merchant_created_idx" ON "core"."audit_logs" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "core"."audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_ref_key" ON "core"."accounts" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_environment_code_key" ON "core"."accounts" USING btree ("environment","code");--> statement-breakpoint
CREATE INDEX "accounts_merchant_idx" ON "core"."accounts" USING btree ("merchant_id") WHERE "core"."accounts"."merchant_id" is not null;--> statement-breakpoint
CREATE INDEX "accounts_purpose_idx" ON "core"."accounts" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "journal_entries_created_idx" ON "core"."journal_entries" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entries_merchant_created_idx" ON "core"."journal_entries" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "core"."journal_entries" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_transaction_idx" ON "core"."journal_entries" USING btree ("transaction_id") WHERE "core"."journal_entries"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_account_created_idx" ON "core"."journal_lines" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_lines_merchant_created_idx" ON "core"."journal_lines" USING btree ("merchant_id","created_at" DESC NULLS LAST) WHERE "core"."journal_lines"."merchant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_events_key_idx" ON "core"."transaction_events" USING btree ("transaction_id","event_key");--> statement-breakpoint
CREATE INDEX "transaction_events_transaction_idx" ON "core"."transaction_events" USING btree ("transaction_id","created_at","id");--> statement-breakpoint
CREATE INDEX "transaction_events_rejected_idx" ON "core"."transaction_events" USING btree ("created_at") WHERE "core"."transaction_events"."outcome" = 'rejected';--> statement-breakpoint
CREATE INDEX "transaction_keys_merchant_idx" ON "core"."transaction_keys" USING btree ("merchant_id","environment");--> statement-breakpoint
CREATE INDEX "transactions_merchant_created_idx" ON "core"."transactions" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_merchant_status_created_idx" ON "core"."transactions" USING btree ("merchant_id","environment","status","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_processing_idx" ON "core"."transactions" USING btree ("created_at") WHERE "core"."transactions"."status" = 'processing';--> statement-breakpoint
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
CREATE UNIQUE INDEX "holds_ref_key" ON "core"."holds" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_idempotency_key_key" ON "core"."holds" USING btree ("environment","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_capture_key_key" ON "core"."holds" USING btree ("environment","capture_key") WHERE "core"."holds"."capture_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "holds_release_key_key" ON "core"."holds" USING btree ("environment","release_key") WHERE "core"."holds"."release_key" is not null;--> statement-breakpoint
CREATE INDEX "holds_merchant_active_idx" ON "core"."holds" USING btree ("merchant_id","environment","currency") WHERE "core"."holds"."state" = 'active';--> statement-breakpoint
CREATE INDEX "holds_expiry_idx" ON "core"."holds" USING btree ("expires_at") WHERE "core"."holds"."state" = 'active' and "core"."holds"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "holds_transaction_idx" ON "core"."holds" USING btree ("transaction_id") WHERE "core"."holds"."transaction_id" is not null;--> statement-breakpoint
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
CREATE UNIQUE INDEX "incident_postmortems_incident_key" ON "core"."incident_postmortems" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incident_updates_incident_idx" ON "core"."incident_updates" USING btree ("incident_id","created_at","id");--> statement-breakpoint
CREATE INDEX "incident_updates_public_idx" ON "core"."incident_updates" USING btree ("incident_id","created_at") WHERE "core"."incident_updates"."public";--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_ref_key" ON "core"."incidents" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_open_dedupe_key" ON "core"."incidents" USING btree ("dedupe_key") WHERE "core"."incidents"."dedupe_key" is not null and "core"."incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "core"."incidents" USING btree ("status","severity","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_public_idx" ON "core"."incidents" USING btree ("detected_at" DESC NULLS LAST) WHERE "core"."incidents"."public";--> statement-breakpoint
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
CREATE INDEX "disputes_deadline_idx" ON "core"."disputes" USING btree ("evidence_due_at") WHERE "core"."disputes"."status" <> 'resolved' and "core"."disputes"."evidence_due_at" is not null;--> statement-breakpoint
CREATE INDEX "disputes_assignee_idx" ON "core"."disputes" USING btree ("assigned_to","status") WHERE "core"."disputes"."assigned_to" is not null;--> statement-breakpoint
CREATE INDEX "complaint_messages_thread_idx" ON "core"."complaint_messages" USING btree ("complaint_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "complaints_ref_key" ON "core"."complaints" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "complaints_merchant_idx" ON "core"."complaints" USING btree ("merchant_id","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "complaints_queue_idx" ON "core"."complaints" USING btree ("status","priority","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "complaints_sla_idx" ON "core"."complaints" USING btree ("sla_due_at") WHERE "core"."complaints"."status" not in ('resolved', 'closed') and not "core"."complaints"."breached";--> statement-breakpoint
CREATE INDEX "complaints_breached_idx" ON "core"."complaints" USING btree ("breached_at" DESC NULLS LAST) WHERE "core"."complaints"."breached" and "core"."complaints"."status" not in ('resolved', 'closed');--> statement-breakpoint
CREATE INDEX "complaints_assignee_idx" ON "core"."complaints" USING btree ("assigned_to","status") WHERE "core"."complaints"."assigned_to" is not null;--> statement-breakpoint
CREATE INDEX "complaints_transaction_idx" ON "core"."complaints" USING btree ("transaction_id") WHERE "core"."complaints"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "dispute_notes_dispute_idx" ON "core"."dispute_notes" USING btree ("dispute_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_ref_key" ON "core"."notification_deliveries" USING btree ("ref","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_notification_key" ON "core"."notification_deliveries" USING btree ("notification_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "core"."notification_deliveries" USING btree ("status","next_attempt_at") WHERE "core"."notification_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notification_deliveries_log_idx" ON "core"."notification_deliveries" USING btree ("status","channel","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_recipient_idx" ON "core"."notification_deliveries" USING btree ("recipient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notification_destinations_key" ON "core"."notification_destinations" USING btree ("user_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_key" ON "core"."notification_preferences" USING btree ("user_id","template_code","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_key" ON "core"."notification_templates" USING btree ("code","channel","locale");--> statement-breakpoint
CREATE INDEX "notification_templates_code_idx" ON "core"."notification_templates" USING btree ("code") WHERE "core"."notification_templates"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_ref_key" ON "core"."notifications" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_source_key" ON "core"."notifications" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "core"."notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST) WHERE "core"."notifications"."channel" = 'in_app';--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "core"."notifications" USING btree ("recipient_id") WHERE "core"."notifications"."channel" = 'in_app' and "core"."notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_dedupe_idx" ON "core"."notifications" USING btree ("recipient_id","template_code","resource_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "daily_merchant_rollups_day_idx" ON "core"."daily_merchant_rollups" USING btree ("environment","date");--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedule_runs_due_key" ON "core"."report_schedule_runs" USING btree ("schedule_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedule_runs_report_key" ON "core"."report_schedule_runs" USING btree ("report_id") WHERE "core"."report_schedule_runs"."report_id" is not null;--> statement-breakpoint
CREATE INDEX "report_schedule_runs_history_idx" ON "core"."report_schedule_runs" USING btree ("schedule_id","due_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedules_ref_key" ON "core"."report_schedules" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "core"."report_schedules" USING btree ("next_run_at") WHERE "core"."report_schedules"."active" and "core"."report_schedules"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "report_schedules_merchant_idx" ON "core"."report_schedules" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST) WHERE "core"."report_schedules"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_ref_key" ON "core"."reports" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_file_key_key" ON "core"."reports" USING btree ("file_key") WHERE "core"."reports"."file_key" is not null;--> statement-breakpoint
CREATE INDEX "reports_merchant_idx" ON "core"."reports" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST,"ref" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_platform_idx" ON "core"."reports" USING btree ("created_at" DESC NULLS LAST,"ref" DESC NULLS LAST) WHERE "core"."reports"."merchant_id" is null;--> statement-breakpoint
CREATE INDEX "reports_active_idx" ON "core"."reports" USING btree ("merchant_id","status") WHERE "core"."reports"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "reports_expiry_idx" ON "core"."reports" USING btree ("expires_at") WHERE "core"."reports"."status" = 'ready';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_key" ON "core"."approval_decisions" USING btree ("approval_id","approver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_ref_key" ON "core"."approvals" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "approvals_inbox_idx" ON "core"."approvals" USING btree ("status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_key" ON "core"."approvals" USING btree ("kind","resource_type","resource_id") WHERE "core"."approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_key" ON "core"."feature_flags" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_rules_ref_key" ON "core"."routing_rules" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "routing_rules_lookup_idx" ON "core"."routing_rules" USING btree ("currency","priority") WHERE "core"."routing_rules"."enabled";--> statement-breakpoint
CREATE INDEX "gateway_events_gateway_id_idx" ON "gateway_events" USING btree ("gateway_id");--> statement-breakpoint
CREATE INDEX "gateway_events_external_id_idx" ON "gateway_events" USING btree ("external_id","operation_type");--> statement-breakpoint
CREATE INDEX "gateway_events_apply_status_idx" ON "gateway_events" USING btree ("apply_status") WHERE "gateway_events"."apply_status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "gateway_events_occurred_at_idx" ON "gateway_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "gateway_requests_transaction_id_idx" ON "gateway_requests" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "gateway_requests_external_id_idx" ON "gateway_requests" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "gateway_requests_created_at_idx" ON "gateway_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_merchant_idempotency_key_idx" ON "payouts" USING btree ("merchant_id","environment","idempotency_key");--> statement-breakpoint
CREATE INDEX "payouts_merchant_created_idx" ON "payouts" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status") WHERE "payouts"."status" in ('processing', 'pending_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_merchant_idempotency_key_idx" ON "refunds" USING btree ("merchant_id","environment","idempotency_key");--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_merchant_created_idx" ON "refunds" USING btree ("merchant_id","environment","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status") WHERE "refunds"."status" in ('processing', 'pending_approval');--> statement-breakpoint
CREATE INDEX "fee_plan_rules_plan_idx" ON "core"."fee_plan_rules" USING btree ("fee_plan_id","operation_type","active");--> statement-breakpoint
CREATE INDEX "fee_plan_rules_lookup_idx" ON "core"."fee_plan_rules" USING btree ("fee_plan_id","operation_type","currency","provider","channel","tier_from_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plans_ref_key" ON "core"."fee_plans" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plans_merchant_default_key" ON "core"."fee_plans" USING btree ("merchant_id") WHERE "core"."fee_plans"."is_default" = true;--> statement-breakpoint
CREATE INDEX "fee_plans_merchant_idx" ON "core"."fee_plans" USING btree ("merchant_id","active");