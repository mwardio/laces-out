-- Connection-scoped circuit breaker and recommendation-run identity (WP4).
--
-- Two independent gaps this migration closes, both forward-only and additive. No existing row is
-- rewritten, no column is dropped, and every row that satisfied the old schema still satisfies the
-- new one.
--
-- 1. `provider_connections` could not hold circuit state. `ENHANCEMENT_PLAN.md` §2.4 requires
--    repeated failure to open a circuit "without taking down unrelated analysis", but the only
--    failure state on the table was `health`, whose sole writer flipped it to 'degraded' on the
--    first error and never escalated, and which gates nothing. `data_sources` already carries the
--    right shape for this (`consecutive_failures`, `last_error_at`, `last_error_code`,
--    `last_error_detail`) but has no user, connection, or provider column, so it is structurally
--    incapable of per-connection state. The three columns below mirror the `data_sources` naming on
--    the table that is already at the right grain. Because nothing outside league sync reads them,
--    an open circuit for one connection cannot affect another connection, another provider, another
--    league's analysis, or the `recommendation-recompute` queue.
--
-- 2. `recommendation_runs` could not enforce idempotent replay. It carried only the non-unique
--    `recommendation_runs_league_kind_idx`, so a replayed recompute with identical inputs would
--    have written a second row. It also had no `fantasy_team_id`, while lineup, waiver, and trade
--    decisions are all per claimed team. The unique index below is the ledger's second line of
--    defense; the recompute checks for an existing run first.
--
-- `NULLS NOT DISTINCT` requires PostgreSQL 15+. The deployed image is postgres:17-alpine
-- (`docker-compose.yml`). It matters because a future league-wide run with a null `fantasy_team_id`
-- must still deduplicate rather than insert without limit.
ALTER TABLE "provider_connections" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "last_error_detail" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_failures_check" CHECK ("provider_connections"."consecutive_failures" >= 0);--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD COLUMN "fantasy_team_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_fantasy_team_id_fantasy_teams_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_kind_check" CHECK ("recommendation_runs"."kind" in ('draft', 'lineup', 'waiver', 'trade'));--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_runs_identity_unique" ON "recommendation_runs" USING btree ("league_season_id","fantasy_team_id","kind","algorithm_version","input_hash") NULLS NOT DISTINCT;
