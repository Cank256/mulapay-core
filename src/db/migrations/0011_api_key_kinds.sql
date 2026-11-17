-- P5-D9: Stripe-style API keys. A publishable key (`pk_...`) has no secret, so `secret_hash` becomes
-- nullable, exactly when `kind = 'publishable'`. Existing rows are secret keys (default). The
-- application refuses to issue a publishable key until P5-K4 decides what one may do.
ALTER TABLE "core"."api_keys" ALTER COLUMN "secret_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD COLUMN "allowed_origins" text[];--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("core"."api_keys"."kind" in ('secret', 'publishable'));--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_secret_presence_check" CHECK (("core"."api_keys"."kind" = 'secret') = ("core"."api_keys"."secret_hash" is not null));--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_publishable_unsigned_check" CHECK ("core"."api_keys"."kind" = 'secret' or ("core"."api_keys"."signing_secret_enc" is null and not "core"."api_keys"."signing_required"));--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_allowed_origins_check" CHECK ("core"."api_keys"."kind" = 'publishable' or "core"."api_keys"."allowed_origins" is null);