-- Phase 1 (identity): email_verified flag on users, plus the email_tokens table used for
-- password-reset and email-verification flows.
--
-- A token is a single-use 32-byte URL-safe random string stored as its SHA-256 hash.
-- Expired or consumed tokens (used_at IS NOT NULL) are safe to prune by a background job.

ALTER TABLE "core"."users"
  ADD COLUMN "email_verified" boolean NOT NULL DEFAULT false;

CREATE TABLE "core"."email_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "core"."users"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"used_at" timestamptz,
	"expires_at" timestamptz NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_kind_check" CHECK (kind IN ('password_reset', 'email_verification')),
	CONSTRAINT "email_tokens_token_hash_key" UNIQUE ("token_hash")
);

CREATE INDEX "email_tokens_user_kind_idx" ON "core"."email_tokens" ("user_id", "kind");
