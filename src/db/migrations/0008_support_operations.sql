-- Hand edits to what drizzle-kit generated (marked in docs/DATABASE.md):
--   * core.notification_deliveries is declared PARTITION BY RANGE (created_at) (spec 5.1).
--   * Everything after "Hand-written" below: updated_at triggers, partitions, state guards,
--     append-only rules, revokes, seed data and permissions.
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
) PARTITION BY RANGE ("created_at");
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
ALTER TABLE "core"."incidents" DROP CONSTRAINT "incidents_source_check";--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD COLUMN "due_soon_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."disputes" ADD COLUMN "overdue_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."incident_postmortems" ADD CONSTRAINT "incident_postmortems_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_postmortems" ADD CONSTRAINT "incident_postmortems_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_updates" ADD CONSTRAINT "incident_updates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."incident_updates" ADD CONSTRAINT "incident_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "incident_postmortems_incident_key" ON "core"."incident_postmortems" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incident_updates_incident_idx" ON "core"."incident_updates" USING btree ("incident_id","created_at","id");--> statement-breakpoint
CREATE INDEX "incident_updates_public_idx" ON "core"."incident_updates" USING btree ("incident_id","created_at") WHERE "core"."incident_updates"."public";--> statement-breakpoint
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
ALTER TABLE "core"."disputes" ADD CONSTRAINT "disputes_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_public_idx" ON "core"."incidents" USING btree ("detected_at" DESC NULLS LAST) WHERE "core"."incidents"."public";--> statement-breakpoint
CREATE INDEX "disputes_deadline_idx" ON "core"."disputes" USING btree ("evidence_due_at") WHERE "core"."disputes"."status" <> 'resolved' and "core"."disputes"."evidence_due_at" is not null;--> statement-breakpoint
CREATE INDEX "disputes_assignee_idx" ON "core"."disputes" USING btree ("assigned_to","status") WHERE "core"."disputes"."assigned_to" is not null;--> statement-breakpoint
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_public_message_check" CHECK (not "core"."incidents"."public" or "core"."incidents"."public_message" is not null);--> statement-breakpoint
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_source_check" CHECK ("core"."incidents"."source" in ('manual', 'reconciliation', 'consumer', 'monitor'));
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------
-- Hand-written (Phase 8, support and operations).

-- updated_at.
CREATE TRIGGER complaint_categories_set_updated_at BEFORE UPDATE ON core.complaint_categories FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER incident_postmortems_set_updated_at BEFORE UPDATE ON core.incident_postmortems FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER notification_templates_set_updated_at BEFORE UPDATE ON core.notification_templates FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER notification_preferences_set_updated_at BEFORE UPDATE ON core.notification_preferences FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER notification_destinations_set_updated_at BEFORE UPDATE ON core.notification_destinations FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER notification_deliveries_set_updated_at BEFORE UPDATE ON core.notification_deliveries FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER report_schedules_set_updated_at BEFORE UPDATE ON core.report_schedules FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON core.feature_flags FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER routing_rules_set_updated_at BEFORE UPDATE ON core.routing_rules FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER provider_status_set_updated_at BEFORE UPDATE ON core.provider_status FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER consumer_cursors_set_updated_at BEFORE UPDATE ON core.consumer_cursors FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER maintenance_state_set_updated_at BEFORE UPDATE ON core.maintenance_state FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint
CREATE TRIGGER ops_signals_set_updated_at BEFORE UPDATE ON core.ops_signals FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();--> statement-breakpoint

-- Partitions for the delivery log: the current month and three ahead, plus a default
-- partition as a safety net. Retention (180 days, spec 11) drops partitions, so DELETE and
-- TRUNCATE are revoked.
DO $$
BEGIN
  PERFORM core.create_monthly_partitions('notification_deliveries', (now() AT TIME ZONE 'UTC')::date, 4, false);
END
$$;--> statement-breakpoint
CREATE TABLE core.notification_deliveries_default PARTITION OF core.notification_deliveries DEFAULT;--> statement-breakpoint
SELECT core.revoke_on_partitions('notification_deliveries', 'DELETE, TRUNCATE');--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.notification_deliveries FROM mulapay_core_rw;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Complaints: what a complaint is about, and its SLA deadline, never change. Closed is final.
-- Legal moves: open and in_progress and awaiting_customer move among themselves and to
-- escalated, resolved or closed; escalated goes back to in_progress or on to resolved or
-- closed; resolved goes to closed only.
CREATE OR REPLACE FUNCTION core.guard_complaint() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.source, NEW.category, NEW.transaction_id, NEW.sla_due_at,
      NEW.created_by, NEW.created_at, NEW.subject, NEW.description, NEW.customer_contact_enc)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.source, OLD.category, OLD.transaction_id, OLD.sla_due_at,
      OLD.created_by, OLD.created_at, OLD.subject, OLD.description, OLD.customer_contact_enc) THEN
    RAISE EXCEPTION 'core.complaints: what a complaint is about and its deadline never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'core.complaints: complaint % is closed and final', OLD.ref USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.breached AND NOT NEW.breached THEN
    RAISE EXCEPTION 'core.complaints: a breach is not undone' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status IN ('open', 'in_progress', 'awaiting_customer')
          AND NEW.status IN ('open', 'in_progress', 'awaiting_customer', 'escalated', 'resolved', 'closed')
          AND NOT (NEW.status = 'open'))
    OR (OLD.status = 'escalated' AND NEW.status IN ('in_progress', 'resolved', 'closed'))
    OR (OLD.status = 'resolved' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'core.complaints: % -> % is not a legal transition', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER complaints_guard BEFORE UPDATE ON core.complaints FOR EACH ROW EXECUTE FUNCTION core.guard_complaint();--> statement-breakpoint

-- Reports: the identity and parameters never change. A report moves queued -> running ->
-- ready | failed, a worker whose lease lapsed may put it back to queued, ready -> expired.
CREATE OR REPLACE FUNCTION core.guard_report() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.merchant_id, NEW.environment, NEW.type, NEW.format, NEW.params,
      NEW.requested_by, NEW.schedule_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.merchant_id, OLD.environment, OLD.type, OLD.format, OLD.params,
      OLD.requested_by, OLD.schedule_id, OLD.created_at) THEN
    RAISE EXCEPTION 'core.reports: what a report is never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('failed', 'expired') THEN
    RAISE EXCEPTION 'core.reports: report % is % and final', OLD.ref, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ready' AND (NEW.status <> 'expired'
     OR (NEW.file_key, NEW.row_count, NEW.file_size, NEW.sha256) IS DISTINCT FROM (OLD.file_key, OLD.row_count, OLD.file_size, OLD.sha256)) THEN
    RAISE EXCEPTION 'core.reports: a ready report only expires' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('queued', 'ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'expired')
  ) THEN
    RAISE EXCEPTION 'core.reports: % -> % is not a legal transition', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'core.reports: attempts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER reports_guard BEFORE UPDATE ON core.reports FOR EACH ROW EXECUTE FUNCTION core.guard_report();--> statement-breakpoint

-- A schedule run is final once it leaves `queued`.
CREATE OR REPLACE FUNCTION core.guard_report_schedule_run() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.schedule_id, NEW.due_at, NEW.started_at) IS DISTINCT FROM (OLD.id, OLD.schedule_id, OLD.due_at, OLD.started_at) THEN
    RAISE EXCEPTION 'core.report_schedule_runs: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'queued' THEN
    RAISE EXCEPTION 'core.report_schedule_runs: run is % and final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER report_schedule_runs_guard BEFORE UPDATE ON core.report_schedule_runs FOR EACH ROW EXECUTE FUNCTION core.guard_report_schedule_run();--> statement-breakpoint

-- Approvals: what is requested never changes; a decided approval is final.
CREATE OR REPLACE FUNCTION core.guard_approval() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.kind, NEW.resource_type, NEW.resource_id, NEW.payload, NEW.reason,
      NEW.requested_by, NEW.requested_at, NEW.required_approvals, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.kind, OLD.resource_type, OLD.resource_id, OLD.payload, OLD.reason,
      OLD.requested_by, OLD.requested_at, OLD.required_approvals, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'core.approvals: what is requested never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'core.approvals: approval % is % and final', OLD.ref, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER approvals_guard BEFORE UPDATE ON core.approvals FOR EACH ROW EXECUTE FUNCTION core.guard_approval();--> statement-breakpoint

-- A decision is never made by the person who asked (the service refuses first; this is the floor).
CREATE OR REPLACE FUNCTION core.guard_approval_decision() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.approver_id = (SELECT a.requested_by FROM core.approvals a WHERE a.id = NEW.approval_id) THEN
    RAISE EXCEPTION 'core.approval_decisions: the requester cannot decide their own request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER approval_decisions_guard BEFORE INSERT ON core.approval_decisions FOR EACH ROW EXECUTE FUNCTION core.guard_approval_decision();--> statement-breakpoint

-- Notifications: only the read time is ever written, and only once.
CREATE OR REPLACE FUNCTION core.guard_notification() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.recipient_type, NEW.recipient_id, NEW.channel, NEW.template_code, NEW.resource_key,
      NEW.source_key, NEW.title, NEW.body, NEW.data, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.recipient_type, OLD.recipient_id, OLD.channel, OLD.template_code, OLD.resource_key,
      OLD.source_key, OLD.title, OLD.body, OLD.data, OLD.created_at) THEN
    RAISE EXCEPTION 'core.notifications: a notification is only ever marked read' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'core.notifications: read once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER notifications_guard BEFORE UPDATE ON core.notifications FOR EACH ROW EXECUTE FUNCTION core.guard_notification();--> statement-breakpoint

-- A delivery leaves `pending` once and is then final, except that `sent` may become
-- `delivered`. Its identity never changes and its attempts never decrease.
CREATE OR REPLACE FUNCTION core.guard_notification_delivery() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.ref, NEW.notification_id, NEW.recipient_id, NEW.template_code, NEW.channel, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.ref, OLD.notification_id, OLD.recipient_id, OLD.template_code, OLD.channel, OLD.created_at) THEN
    RAISE EXCEPTION 'core.notification_deliveries: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'failed' OR OLD.status = 'delivered' THEN
    RAISE EXCEPTION 'core.notification_deliveries: delivery is % and final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' AND NEW.status NOT IN ('sent', 'delivered') THEN
    RAISE EXCEPTION 'core.notification_deliveries: a sent message is not retried' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'core.notification_deliveries: attempts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER notification_deliveries_guard BEFORE UPDATE ON core.notification_deliveries FOR EACH ROW EXECUTE FUNCTION core.guard_notification_delivery();--> statement-breakpoint

-- A published postmortem is final.
CREATE OR REPLACE FUNCTION core.guard_incident_postmortem() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.incident_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.incident_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'core.incident_postmortems: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'core.incident_postmortems: a published postmortem is final' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER incident_postmortems_guard BEFORE UPDATE ON core.incident_postmortems FOR EACH ROW EXECUTE FUNCTION core.guard_incident_postmortem();--> statement-breakpoint

-- Append-only: messages, notes, incident updates and approval decisions.
CREATE TRIGGER complaint_messages_append_only BEFORE UPDATE OR DELETE ON core.complaint_messages FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER complaint_messages_no_truncate BEFORE TRUNCATE ON core.complaint_messages FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER dispute_notes_append_only BEFORE UPDATE OR DELETE ON core.dispute_notes FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER dispute_notes_no_truncate BEFORE TRUNCATE ON core.dispute_notes FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER incident_updates_append_only BEFORE UPDATE OR DELETE ON core.incident_updates FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER incident_updates_no_truncate BEFORE TRUNCATE ON core.incident_updates FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON core.approval_decisions FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER approval_decisions_no_truncate BEFORE TRUNCATE ON core.approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.complaint_messages FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.dispute_notes FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.incident_updates FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.approval_decisions FROM mulapay_core_rw;--> statement-breakpoint
-- Support and operations records are kept: nothing here is deleted by the application.
REVOKE DELETE, TRUNCATE ON core.complaints FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.complaint_categories FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.incident_postmortems FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.approvals FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.notifications FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.reports FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.report_schedules FROM mulapay_core_rw;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON core.report_schedule_runs FROM mulapay_core_rw;--> statement-breakpoint
GRANT UPDATE (status, report_id, error, finished_at) ON core.report_schedule_runs TO mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.feature_flags FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.provider_status FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.consumer_cursors FROM mulapay_core_rw;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON core.maintenance_state FROM mulapay_core_rw;--> statement-breakpoint
REVOKE TRUNCATE ON core.routing_rules FROM mulapay_core_rw;--> statement-breakpoint
-- The in-app inbox lets a user mark a notification read, nothing else.
REVOKE UPDATE ON core.notifications FROM mulapay_core_rw;--> statement-breakpoint
GRANT UPDATE (read_at) ON core.notifications TO mulapay_core_rw;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Seed: complaint categories. PLACEHOLDER SLA HOURS for Support to review (see
-- docs/ARCHITECTURE.md, "Phase 8 decisions to confirm"). The SLA is calendar time.
INSERT INTO core.complaint_categories (code, name, description, sla_hours, default_priority) VALUES
  ('payment_issue', 'Payment issue', 'A payment failed, is stuck or was charged wrongly.', 24, 'high'),
  ('settlement_delay', 'Settlement delay', 'A settlement is late or the amount is wrong.', 48, 'high'),
  ('refund_issue', 'Refund issue', 'A refund is missing, late or the wrong amount.', 72, 'normal'),
  ('fees_billing', 'Fees and billing', 'A question about fees charged.', 72, 'normal'),
  ('account_access', 'Account access', 'Cannot sign in, locked out or lost MFA.', 24, 'high'),
  ('integration_support', 'Integration support', 'Help with the API, webhooks or the sandbox.', 48, 'normal'),
  ('unauthorized_transaction', 'Unauthorised transaction', 'A transaction the merchant or customer did not make.', 8, 'urgent'),
  ('service_quality', 'Service quality', 'Feedback about the service.', 96, 'low'),
  ('other', 'Other', 'Anything else.', 96, 'normal');--> statement-breakpoint

-- Seed: providers (spec 6.2) and the gateway event consumer's cursor (spec 8.7).
INSERT INTO core.provider_status (provider, enabled, health) VALUES
  ('mtn', true, 'healthy'), ('airtel', true, 'healthy'), ('flutterwave', true, 'healthy');--> statement-breakpoint
INSERT INTO core.consumer_cursors (name, position) VALUES ('gateway', 0);--> statement-breakpoint
INSERT INTO core.maintenance_state (id, enabled, retry_after_seconds) VALUES (true, false, 60);--> statement-breakpoint

-- Seed: notification templates. `{{name}}` placeholders; every one is listed in `variables`.
INSERT INTO core.notification_templates (id, code, channel, locale, subject, body, variables, mandatory, audience) VALUES
  (core.gen_uuid_v7(), 'complaint.message_received', 'in_app', 'en', 'New reply on {{complaint_ref}}', 'MulaPay support replied to your complaint {{complaint_ref}} ({{subject}}).', '["complaint_ref","subject"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'complaint.message_received', 'email', 'en', 'New reply on {{complaint_ref}}', 'MulaPay support replied to your complaint {{complaint_ref}} ({{subject}}). Sign in to the dashboard to read it.', '["complaint_ref","subject"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'complaint.resolved', 'in_app', 'en', 'Complaint {{complaint_ref}} resolved', 'Your complaint {{complaint_ref}} ({{subject}}) was resolved.', '["complaint_ref","subject"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'complaint.resolved', 'email', 'en', 'Complaint {{complaint_ref}} resolved', 'Your complaint {{complaint_ref}} ({{subject}}) was resolved. Sign in to the dashboard for the resolution.', '["complaint_ref","subject"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'dispute.created', 'in_app', 'en', 'Dispute {{dispute_ref}} opened', 'A dispute of {{amount_minor}} {{currency}} was opened against you. Evidence is due {{evidence_due}}.', '["dispute_ref","amount_minor","currency","evidence_due"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'dispute.created', 'email', 'en', 'Dispute {{dispute_ref}} opened', 'A dispute of {{amount_minor}} {{currency}} was opened against you and the amount is held on your balance. Evidence is due {{evidence_due}}.', '["dispute_ref","amount_minor","currency","evidence_due"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'dispute.resolved', 'in_app', 'en', 'Dispute {{dispute_ref}} resolved', 'Dispute {{dispute_ref}} was resolved: {{outcome}}.', '["dispute_ref","outcome"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'dispute.resolved', 'email', 'en', 'Dispute {{dispute_ref}} resolved', 'Dispute {{dispute_ref}} was resolved: {{outcome}}.', '["dispute_ref","outcome"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.approved', 'in_app', 'en', 'Verification approved', 'Your business was verified. Your limits were raised.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.approved', 'email', 'en', 'Verification approved', 'Your business was verified and your limits were raised.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.rejected', 'in_app', 'en', 'Verification needs attention', 'Your verification was not approved. Open the dashboard to see what to fix.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.rejected', 'email', 'en', 'Verification needs attention', 'Your verification was not approved. Sign in to the dashboard to see what to fix and resubmit.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.info_requested', 'in_app', 'en', 'More information needed', 'We need more information to finish verifying your business.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.info_requested', 'email', 'en', 'More information needed', 'We need more information to finish verifying your business. Sign in to the dashboard to provide it.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.reverification_due', 'in_app', 'en', 'Re-verification due', 'Your verification expires soon. Renew it to keep your limits.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'kyc.reverification_due', 'email', 'en', 'Re-verification due', 'Your verification expires soon. Sign in to the dashboard to renew it and keep your limits.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'merchant.suspended', 'in_app', 'en', 'Account suspended', 'Your account was suspended. Contact support.', '[]', true, 'merchant'),
  (core.gen_uuid_v7(), 'merchant.suspended', 'email', 'en', 'Account suspended', 'Your MulaPay account was suspended. Contact support to find out why and what happens next.', '[]', true, 'merchant'),
  (core.gen_uuid_v7(), 'merchant.activated', 'in_app', 'en', 'Account active', 'Your account is active.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'merchant.activated', 'email', 'en', 'Account active', 'Your MulaPay account is active.', '[]', false, 'merchant'),
  (core.gen_uuid_v7(), 'webhook_endpoint.auto_disabled', 'in_app', 'en', 'Webhook endpoint disabled', 'Endpoint {{endpoint_ref}} failed 50 times in a row and was disabled.', '["endpoint_ref"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'webhook_endpoint.auto_disabled', 'email', 'en', 'Webhook endpoint disabled', 'Endpoint {{endpoint_ref}} failed 50 times in a row and was disabled. Fix it and re-enable it in the dashboard.', '["endpoint_ref"]', true, 'merchant'),
  (core.gen_uuid_v7(), 'settlement.paid', 'in_app', 'en', 'Settlement paid', 'Settlement {{settlement_ref}} was paid.', '["settlement_ref"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'settlement.paid', 'email', 'en', 'Settlement paid', 'Settlement {{settlement_ref}} was paid. The statement is in the dashboard.', '["settlement_ref"]', false, 'merchant'),
  (core.gen_uuid_v7(), 'report.ready', 'in_app', 'en', 'Report ready', 'Your {{report_type}} report {{report_ref}} is ready to download for 7 days.', '["report_ref","report_type"]', false, 'any'),
  (core.gen_uuid_v7(), 'report.ready', 'email', 'en', 'Report ready', 'Your {{report_type}} report {{report_ref}} is ready. Sign in to download it within 7 days.', '["report_ref","report_type"]', false, 'any'),
  (core.gen_uuid_v7(), 'report.failed', 'in_app', 'en', 'Report failed', 'Your {{report_type}} report {{report_ref}} could not be generated.', '["report_ref","report_type"]', false, 'any'),
  (core.gen_uuid_v7(), 'report.failed', 'email', 'en', 'Report failed', 'Your {{report_type}} report {{report_ref}} could not be generated. Request it again, or contact support if it keeps failing.', '["report_ref","report_type"]', false, 'any'),
  (core.gen_uuid_v7(), 'report_schedule.disabled', 'in_app', 'en', 'Scheduled report stopped', 'Schedule {{schedule_ref}} was turned off after repeated failures.', '["schedule_ref"]', false, 'any'),
  (core.gen_uuid_v7(), 'report_schedule.disabled', 'email', 'en', 'Scheduled report stopped', 'Schedule {{schedule_ref}} was turned off after repeated failures. Fix the cause and turn it back on.', '["schedule_ref"]', false, 'any'),
  (core.gen_uuid_v7(), 'broadcast.announcement', 'in_app', 'en', '{{headline}}', '{{message}}', '["headline","message"]', false, 'any'),
  (core.gen_uuid_v7(), 'broadcast.announcement', 'email', 'en', '{{headline}}', '{{message}}', '["headline","message"]', false, 'any'),
  (core.gen_uuid_v7(), 'complaint.created', 'in_app', 'en', 'New complaint {{complaint_ref}}', '{{category}} complaint, {{priority}} priority, due {{due_at}}.', '["complaint_ref","category","priority","due_at"]', false, 'staff'),
  (core.gen_uuid_v7(), 'complaint.assigned', 'in_app', 'en', 'Complaint {{complaint_ref}} assigned to you', 'You are now responsible for complaint {{complaint_ref}}.', '["complaint_ref"]', false, 'staff'),
  (core.gen_uuid_v7(), 'complaint.escalated', 'in_app', 'en', 'Complaint {{complaint_ref}} escalated', 'Escalated: {{reason}}', '["complaint_ref","reason"]', true, 'staff'),
  (core.gen_uuid_v7(), 'complaint.escalated', 'email', 'en', 'Complaint {{complaint_ref}} escalated', 'Complaint {{complaint_ref}} was escalated: {{reason}}', '["complaint_ref","reason"]', true, 'staff'),
  (core.gen_uuid_v7(), 'complaint.sla_breached', 'in_app', 'en', 'SLA breached: {{complaint_ref}}', '{{category}} complaint {{complaint_ref}} passed its deadline ({{due_at}}).', '["complaint_ref","category","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'complaint.sla_breached', 'email', 'en', 'SLA breached: {{complaint_ref}}', '{{category}} complaint {{complaint_ref}} passed its deadline ({{due_at}}).', '["complaint_ref","category","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'dispute.assigned', 'in_app', 'en', 'Dispute {{dispute_ref}} assigned to you', 'You are now investigating dispute {{dispute_ref}}.', '["dispute_ref"]', false, 'staff'),
  (core.gen_uuid_v7(), 'dispute.deadline_due_soon', 'in_app', 'en', 'Dispute {{dispute_ref}} evidence due soon', 'The evidence deadline for dispute {{dispute_ref}} is {{due_at}}.', '["dispute_ref","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'dispute.deadline_due_soon', 'email', 'en', 'Dispute {{dispute_ref}} evidence due soon', 'The evidence deadline for dispute {{dispute_ref}} is {{due_at}}.', '["dispute_ref","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'dispute.deadline_overdue', 'in_app', 'en', 'Dispute {{dispute_ref}} deadline passed', 'The evidence deadline for dispute {{dispute_ref}} passed at {{due_at}}.', '["dispute_ref","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'dispute.deadline_overdue', 'email', 'en', 'Dispute {{dispute_ref}} deadline passed', 'The evidence deadline for dispute {{dispute_ref}} passed at {{due_at}}.', '["dispute_ref","due_at"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.opened', 'in_app', 'en', '{{severity}} incident {{incident_ref}}', '{{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.opened', 'email', 'en', '{{severity}} incident {{incident_ref}}', '{{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.opened', 'sms', 'en', NULL, 'MulaPay {{severity}} {{incident_ref}}: {{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.escalated', 'in_app', 'en', 'Incident {{incident_ref}} is now {{severity}}', '{{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.escalated', 'email', 'en', 'Incident {{incident_ref}} is now {{severity}}', '{{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'incident.escalated', 'sms', 'en', NULL, 'MulaPay {{incident_ref}} is now {{severity}}: {{title}}', '["incident_ref","severity","title"]', true, 'staff'),
  (core.gen_uuid_v7(), 'approval.requested', 'in_app', 'en', 'Approval needed: {{kind}}', 'Request {{approval_ref}} is waiting for a second person.', '["approval_ref","kind"]', false, 'staff'),
  (core.gen_uuid_v7(), 'approval.decided', 'in_app', 'en', 'Request {{approval_ref}} {{decision}}', 'Your request {{approval_ref}} was {{decision}}.', '["approval_ref","decision"]', false, 'staff'),
  (core.gen_uuid_v7(), 'maintenance.changed', 'in_app', 'en', 'Maintenance mode {{state}}', 'Maintenance mode was turned {{state}}.', '["state"]', true, 'staff'),
  (core.gen_uuid_v7(), 'maintenance.changed', 'email', 'en', 'Maintenance mode {{state}}', 'Maintenance mode was turned {{state}}.', '["state"]', true, 'staff');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Permissions (spec 7.2, 7.3, 11). Keep in step with src/common/authz/permissions.ts.
INSERT INTO core.permissions (key, actor_type, description) VALUES
  ('support:read', 'staff', 'Read complaints, the SLA breach queue and their messages'),
  ('support:work', 'staff', 'Record, assign, answer and escalate complaints'),
  ('support:resolve', 'staff', 'Resolve complaints'),
  ('incidents:read', 'staff', 'Read incidents, their timeline and postmortems'),
  ('incidents:manage', 'staff', 'Open, update and resolve incidents; write postmortems'),
  ('ops:read', 'staff', 'Read queues, cursors, stuck transactions, flags, providers and approvals'),
  ('ops:manage', 'staff', 'Operate queues, feature flags, providers, routing rules and maintenance mode'),
  ('ops:approve', 'staff', 'Approve or reject operational approvals (never one''s own request)'),
  ('reports:platform', 'staff', 'Request and download platform reports'),
  ('notification_templates:manage', 'staff', 'Edit notification templates and send broadcasts'),
  ('complaints:read', 'merchant', 'See the business''s complaints'),
  ('complaints:write', 'merchant', 'File and answer complaints'),
  ('reports:read', 'merchant', 'List and download reports'),
  ('reports:create', 'merchant', 'Request reports and manage report schedules'),
  ('analytics:read', 'merchant', 'See dashboard analytics');--> statement-breakpoint
INSERT INTO core.role_permissions (role_key, permission_key) VALUES
  ('super_admin', 'support:read'), ('super_admin', 'support:work'), ('super_admin', 'support:resolve'),
  ('super_admin', 'incidents:read'), ('super_admin', 'incidents:manage'),
  ('super_admin', 'ops:read'), ('super_admin', 'ops:manage'), ('super_admin', 'ops:approve'),
  ('super_admin', 'reports:platform'), ('super_admin', 'notification_templates:manage'),
  ('operations', 'support:read'), ('operations', 'support:work'),
  ('operations', 'incidents:read'), ('operations', 'incidents:manage'),
  ('operations', 'ops:read'), ('operations', 'ops:manage'), ('operations', 'ops:approve'),
  ('operations', 'reports:platform'),
  ('compliance', 'support:read'), ('compliance', 'incidents:read'), ('compliance', 'reports:platform'),
  ('support_agent', 'support:read'), ('support_agent', 'support:work'), ('support_agent', 'support:resolve'),
  ('support_agent', 'incidents:read'),
  ('auditor', 'support:read'), ('auditor', 'incidents:read'), ('auditor', 'ops:read'), ('auditor', 'reports:platform'),
  ('owner', 'complaints:read'), ('owner', 'complaints:write'), ('owner', 'reports:read'), ('owner', 'reports:create'), ('owner', 'analytics:read'),
  ('admin', 'complaints:read'), ('admin', 'complaints:write'), ('admin', 'reports:read'), ('admin', 'reports:create'), ('admin', 'analytics:read'),
  ('finance', 'complaints:read'), ('finance', 'complaints:write'), ('finance', 'reports:read'), ('finance', 'reports:create'), ('finance', 'analytics:read'),
  ('developer', 'reports:read'), ('developer', 'analytics:read'),
  ('support', 'complaints:read'), ('support', 'complaints:write'),
  ('viewer', 'complaints:read'), ('viewer', 'reports:read'), ('viewer', 'analytics:read');
