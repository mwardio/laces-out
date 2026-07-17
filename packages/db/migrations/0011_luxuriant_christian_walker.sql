ALTER TABLE "ai_provider_credentials" DROP CONSTRAINT "ai_provider_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT "ai_usage_ledger_provider_check";--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD COLUMN "daily_request_limit" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD COLUMN "max_output_tokens" integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_credentials_user_provider_unique" ON "ai_provider_credentials" USING btree ("user_id","provider");--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_model_check" CHECK ("ai_provider_credentials"."model" is null or char_length("ai_provider_credentials"."model") between 1 and 160);--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_daily_limit_check" CHECK ("ai_provider_credentials"."daily_request_limit" between 1 and 500);--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_output_limit_check" CHECK ("ai_provider_credentials"."max_output_tokens" between 64 and 8192);--> statement-breakpoint
ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_provider_check" CHECK ("ai_provider_credentials"."provider" in ('openai', 'anthropic', 'gemini', 'openrouter'));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_provider_check" CHECK ("ai_usage_ledger"."provider" in ('openai', 'anthropic', 'gemini', 'openrouter'));