CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sends_kind_check" CHECK ("email_sends"."kind" in ('league-sync-nudge')),
	CONSTRAINT "email_sends_key_check" CHECK (char_length(btrim("email_sends"."idempotency_key")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_tokens_hash_check" CHECK ("email_verification_tokens"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "email_verification_tokens_lifetime_check" CHECK ("email_verification_tokens"."expires_at" > "email_verification_tokens"."created_at" and "email_verification_tokens"."expires_at" <= "email_verification_tokens"."created_at" + interval '24 hours'),
	CONSTRAINT "email_verification_tokens_used_check" CHECK ("email_verification_tokens"."used_at" is null or "email_verification_tokens"."used_at" >= "email_verification_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_hash_check" CHECK ("password_reset_tokens"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "password_reset_tokens_lifetime_check" CHECK ("password_reset_tokens"."expires_at" > "password_reset_tokens"."created_at" and "password_reset_tokens"."expires_at" <= "password_reset_tokens"."created_at" + interval '60 minutes'),
	CONSTRAINT "password_reset_tokens_used_check" CHECK ("password_reset_tokens"."used_at" is null or "password_reset_tokens"."used_at" >= "password_reset_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_key_unique" ON "email_sends" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "email_sends_user_idx" ON "email_sends" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_unique" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_expires_idx" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
-- Null email_verified_at must only ever mean "created pending confirmation". Every account that
-- exists before this feature was created live, so it is stamped verified as of its creation.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
