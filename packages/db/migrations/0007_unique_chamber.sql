CREATE TABLE "matchup_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"as_of_week" integer,
	"effective_at" timestamp with time zone NOT NULL,
	"source_sync_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matchup_snapshots_week_check" CHECK ("matchup_snapshots"."as_of_week" is null or "matchup_snapshots"."as_of_week" between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "standings_entries" (
	"snapshot_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"provider_team_id" text NOT NULL,
	"rank" integer NOT NULL,
	"playoff_seed" integer,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	"ties" integer NOT NULL,
	"points_for" numeric(14, 4) NOT NULL,
	"points_against" numeric(14, 4) NOT NULL,
	"streak_type" text NOT NULL,
	"streak_length" integer NOT NULL,
	CONSTRAINT "standings_entries_snapshot_id_team_id_pk" PRIMARY KEY("snapshot_id","team_id"),
	CONSTRAINT "standings_entries_provider_team_check" CHECK (char_length(btrim("standings_entries"."provider_team_id")) > 0),
	CONSTRAINT "standings_entries_rank_check" CHECK ("standings_entries"."rank" > 0),
	CONSTRAINT "standings_entries_playoff_seed_check" CHECK ("standings_entries"."playoff_seed" is null or "standings_entries"."playoff_seed" > 0),
	CONSTRAINT "standings_entries_record_check" CHECK ("standings_entries"."wins" >= 0 and "standings_entries"."losses" >= 0 and "standings_entries"."ties" >= 0),
	CONSTRAINT "standings_entries_streak_type_check" CHECK ("standings_entries"."streak_type" in ('win', 'loss', 'tie', 'none')),
	CONSTRAINT "standings_entries_streak_length_check" CHECK ("standings_entries"."streak_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "standings_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"as_of_week" integer,
	"effective_at" timestamp with time zone NOT NULL,
	"source_sync_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standings_snapshots_week_check" CHECK ("standings_snapshots"."as_of_week" is null or "standings_snapshots"."as_of_week" between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "weekly_matchups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"provider_matchup_id" text NOT NULL,
	"week" integer NOT NULL,
	"status" text NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"home_provider_team_id" text NOT NULL,
	"away_provider_team_id" text NOT NULL,
	"home_score" numeric(14, 4),
	"away_score" numeric(14, 4),
	"winner_team_id" uuid,
	"tied" boolean DEFAULT false NOT NULL,
	CONSTRAINT "weekly_matchups_week_check" CHECK ("weekly_matchups"."week" between 1 and 30),
	CONSTRAINT "weekly_matchups_status_check" CHECK ("weekly_matchups"."status" in ('scheduled', 'in-progress', 'final')),
	CONSTRAINT "weekly_matchups_external_key_check" CHECK (char_length(btrim("weekly_matchups"."external_key")) > 0 and char_length(btrim("weekly_matchups"."provider_matchup_id")) > 0),
	CONSTRAINT "weekly_matchups_provider_team_check" CHECK (char_length(btrim("weekly_matchups"."home_provider_team_id")) > 0 and char_length(btrim("weekly_matchups"."away_provider_team_id")) > 0),
	CONSTRAINT "weekly_matchups_distinct_teams_check" CHECK ("weekly_matchups"."home_team_id" <> "weekly_matchups"."away_team_id"),
	CONSTRAINT "weekly_matchups_winner_team_check" CHECK ("weekly_matchups"."winner_team_id" is null or "weekly_matchups"."winner_team_id" in ("weekly_matchups"."home_team_id", "weekly_matchups"."away_team_id")),
	CONSTRAINT "weekly_matchups_scores_check" CHECK (("weekly_matchups"."status" = 'scheduled' and "weekly_matchups"."home_score" is null and "weekly_matchups"."away_score" is null) or ("weekly_matchups"."status" <> 'scheduled' and "weekly_matchups"."home_score" is not null and "weekly_matchups"."away_score" is not null)),
	CONSTRAINT "weekly_matchups_outcome_check" CHECK (("weekly_matchups"."status" = 'final' and (("weekly_matchups"."tied" = true and "weekly_matchups"."winner_team_id" is null) or ("weekly_matchups"."tied" = false and "weekly_matchups"."winner_team_id" is not null))) or ("weekly_matchups"."status" <> 'final' and "weekly_matchups"."tied" = false and "weekly_matchups"."winner_team_id" is null))
);
--> statement-breakpoint
ALTER TABLE "matchup_snapshots" ADD CONSTRAINT "matchup_snapshots_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchup_snapshots" ADD CONSTRAINT "matchup_snapshots_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_entries" ADD CONSTRAINT "standings_entries_snapshot_id_standings_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."standings_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_entries" ADD CONSTRAINT "standings_entries_team_id_fantasy_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_matchups" ADD CONSTRAINT "weekly_matchups_snapshot_id_matchup_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."matchup_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_matchups" ADD CONSTRAINT "weekly_matchups_home_team_id_fantasy_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_matchups" ADD CONSTRAINT "weekly_matchups_away_team_id_fantasy_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_matchups" ADD CONSTRAINT "weekly_matchups_winner_team_id_fantasy_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matchup_snapshots_league_effective_idx" ON "matchup_snapshots" USING btree ("league_season_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matchup_snapshots_source_sync_unique" ON "matchup_snapshots" USING btree ("source_sync_run_id") WHERE "matchup_snapshots"."source_sync_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "standings_entries_provider_team_unique" ON "standings_entries" USING btree ("snapshot_id","provider_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standings_entries_rank_unique" ON "standings_entries" USING btree ("snapshot_id","rank");--> statement-breakpoint
CREATE INDEX "standings_snapshots_league_effective_idx" ON "standings_snapshots" USING btree ("league_season_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "standings_snapshots_source_sync_unique" ON "standings_snapshots" USING btree ("source_sync_run_id") WHERE "standings_snapshots"."source_sync_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_matchups_snapshot_external_unique" ON "weekly_matchups" USING btree ("snapshot_id","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_matchups_snapshot_provider_unique" ON "weekly_matchups" USING btree ("snapshot_id","provider_matchup_id");--> statement-breakpoint
CREATE INDEX "weekly_matchups_snapshot_week_idx" ON "weekly_matchups" USING btree ("snapshot_id","week");