ALTER TABLE "provider_league_links" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "last_error_detail" text;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "provider_league_links_sync_circuit_idx" ON "provider_league_links" USING btree ("connection_id","circuit_open_until");--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_failures_check" CHECK ("provider_league_links"."consecutive_failures" >= 0);--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_error_bounds_check" CHECK (("provider_league_links"."last_error_code" is null or char_length("provider_league_links"."last_error_code") <= 64) and ("provider_league_links"."last_error_detail" is null or char_length("provider_league_links"."last_error_detail") <= 500));
--> statement-breakpoint
-- Older workers placed every ESPN league failure on the shared account connection. Once the
-- circuit is league-scoped, release those legacy cooldowns so healthy sibling leagues retry now.
UPDATE "provider_connections"
SET
  "health" = 'healthy',
  "last_error_code" = NULL,
  "last_error_at" = NULL,
  "last_error_detail" = NULL,
  "consecutive_failures" = 0,
  "circuit_open_until" = NULL,
  "updated_at" = now()
WHERE
  "provider" = 'espn'
  AND "health" = 'degraded'
  AND "encrypted_credential" IS NOT NULL;
