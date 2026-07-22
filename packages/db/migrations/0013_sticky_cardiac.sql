CREATE TABLE "adp_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"season" integer NOT NULL,
	"scoring_format" text NOT NULL,
	"team_count" integer NOT NULL,
	"roster_format" text DEFAULT 'unknown' NOT NULL,
	"position_filter" text,
	"overall_adp" numeric(8, 3) NOT NULL,
	"source_rank" integer,
	"position_rank" integer,
	"standard_deviation" numeric(8, 3),
	"sample_size" integer,
	"source_as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adp_observations_external_id_check" CHECK (char_length(btrim("adp_observations"."external_player_id")) between 1 and 64),
	CONSTRAINT "adp_observations_season_check" CHECK ("adp_observations"."season" between 2000 and 2200),
	CONSTRAINT "adp_observations_scoring_format_check" CHECK ("adp_observations"."scoring_format" in ('standard', 'half-ppr', 'ppr')),
	CONSTRAINT "adp_observations_team_count_check" CHECK ("adp_observations"."team_count" between 4 and 32),
	CONSTRAINT "adp_observations_roster_format_check" CHECK ("adp_observations"."roster_format" in ('one-qb', 'superflex', 'two-qb', 'unknown')),
	CONSTRAINT "adp_observations_position_filter_check" CHECK ("adp_observations"."position_filter" is null or char_length(btrim("adp_observations"."position_filter")) between 1 and 16),
	CONSTRAINT "adp_observations_value_check" CHECK ("adp_observations"."overall_adp" > 0 and "adp_observations"."overall_adp" <= 1000),
	CONSTRAINT "adp_observations_rank_check" CHECK (("adp_observations"."source_rank" is null or "adp_observations"."source_rank" between 1 and 1000) and ("adp_observations"."position_rank" is null or "adp_observations"."position_rank" between 1 and 1000)),
	CONSTRAINT "adp_observations_dispersion_check" CHECK ("adp_observations"."standard_deviation" is null or ("adp_observations"."standard_deviation" >= 0 and "adp_observations"."standard_deviation" <= 1000)),
	CONSTRAINT "adp_observations_sample_check" CHECK ("adp_observations"."sample_size" is null or "adp_observations"."sample_size" >= 0),
	CONSTRAINT "adp_observations_checksum_check" CHECK ("adp_observations"."input_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "adp_observations_time_check" CHECK ("adp_observations"."source_as_of" <= "adp_observations"."fetched_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "nfl_schedule_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_game_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"season_type" text NOT NULL,
	"game_date" text NOT NULL,
	"start_time_eastern" text,
	"time_tbd" boolean NOT NULL,
	"kickoff_at" timestamp with time zone,
	"away_team" text NOT NULL,
	"home_team" text NOT NULL,
	"status" text NOT NULL,
	"neutral_site" boolean DEFAULT false NOT NULL,
	"away_rest_days" integer,
	"home_rest_days" integer,
	"away_score" integer,
	"home_score" integer,
	"source_as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nfl_schedule_observations_game_id_check" CHECK (char_length(btrim("nfl_schedule_observations"."external_game_id")) between 1 and 64),
	CONSTRAINT "nfl_schedule_observations_season_check" CHECK ("nfl_schedule_observations"."season" between 1999 and 2200),
	CONSTRAINT "nfl_schedule_observations_week_check" CHECK ("nfl_schedule_observations"."week" between 1 and 25),
	CONSTRAINT "nfl_schedule_observations_season_type_check" CHECK ("nfl_schedule_observations"."season_type" in ('REG', 'POST')),
	CONSTRAINT "nfl_schedule_observations_teams_check" CHECK ("nfl_schedule_observations"."away_team" ~ '^[A-Z]{2,4}$' and "nfl_schedule_observations"."home_team" ~ '^[A-Z]{2,4}$' and "nfl_schedule_observations"."away_team" <> "nfl_schedule_observations"."home_team"),
	CONSTRAINT "nfl_schedule_observations_status_check" CHECK ("nfl_schedule_observations"."status" in ('scheduled', 'in-progress', 'final', 'postponed', 'cancelled')),
	CONSTRAINT "nfl_schedule_observations_timing_check" CHECK ("nfl_schedule_observations"."game_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and (("nfl_schedule_observations"."time_tbd" = true and "nfl_schedule_observations"."start_time_eastern" is null) or ("nfl_schedule_observations"."time_tbd" = false and "nfl_schedule_observations"."start_time_eastern" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))),
	CONSTRAINT "nfl_schedule_observations_rest_check" CHECK (("nfl_schedule_observations"."away_rest_days" is null or "nfl_schedule_observations"."away_rest_days" between 0 and 30) and ("nfl_schedule_observations"."home_rest_days" is null or "nfl_schedule_observations"."home_rest_days" between 0 and 30)),
	CONSTRAINT "nfl_schedule_observations_score_check" CHECK (("nfl_schedule_observations"."away_score" is null or "nfl_schedule_observations"."away_score" between 0 and 200) and ("nfl_schedule_observations"."home_score" is null or "nfl_schedule_observations"."home_score" between 0 and 200) and (("nfl_schedule_observations"."away_score" is null) = ("nfl_schedule_observations"."home_score" is null)) and ("nfl_schedule_observations"."status" <> 'final' or "nfl_schedule_observations"."away_score" is not null)),
	CONSTRAINT "nfl_schedule_observations_checksum_check" CHECK ("nfl_schedule_observations"."input_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "nfl_schedule_observations_time_check" CHECK ("nfl_schedule_observations"."source_as_of" <= "nfl_schedule_observations"."fetched_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "player_snap_count_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"season_type" text NOT NULL,
	"game_type" text NOT NULL,
	"game_id" text NOT NULL,
	"pfr_game_id" text NOT NULL,
	"team" text NOT NULL,
	"opponent_team" text NOT NULL,
	"offense_snaps" integer NOT NULL,
	"offense_share" numeric(6, 5) NOT NULL,
	"defense_snaps" integer NOT NULL,
	"defense_share" numeric(6, 5) NOT NULL,
	"special_teams_snaps" integer NOT NULL,
	"special_teams_share" numeric(6, 5) NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_snap_counts_external_id_check" CHECK ("player_snap_count_observations"."external_player_id" ~ '^[A-Za-z0-9.-]{1,20}$'),
	CONSTRAINT "player_snap_counts_season_check" CHECK ("player_snap_count_observations"."season" between 2012 and 2200),
	CONSTRAINT "player_snap_counts_week_check" CHECK ("player_snap_count_observations"."week" between 1 and 25),
	CONSTRAINT "player_snap_counts_season_type_check" CHECK ("player_snap_count_observations"."season_type" in ('REG', 'POST')),
	CONSTRAINT "player_snap_counts_game_type_check" CHECK ("player_snap_count_observations"."game_type" in ('REG', 'WC', 'DIV', 'CON', 'SB')),
	CONSTRAINT "player_snap_counts_context_check" CHECK (char_length(btrim("player_snap_count_observations"."game_id")) between 1 and 64 and char_length(btrim("player_snap_count_observations"."pfr_game_id")) between 1 and 32 and "player_snap_count_observations"."team" ~ '^[A-Z]{2,4}$' and "player_snap_count_observations"."opponent_team" ~ '^[A-Z]{2,4}$'),
	CONSTRAINT "player_snap_counts_bounds_check" CHECK ("player_snap_count_observations"."offense_snaps" between 0 and 250 and "player_snap_count_observations"."defense_snaps" between 0 and 250 and "player_snap_count_observations"."special_teams_snaps" between 0 and 250 and "player_snap_count_observations"."offense_share" between 0 and 1 and "player_snap_count_observations"."defense_share" between 0 and 1 and "player_snap_count_observations"."special_teams_share" between 0 and 1),
	CONSTRAINT "player_snap_counts_checksum_check" CHECK ("player_snap_count_observations"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "player_weekly_stat_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"season_type" text NOT NULL,
	"game_id" text NOT NULL,
	"team" text NOT NULL,
	"opponent_team" text NOT NULL,
	"components" jsonb NOT NULL,
	"advanced" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_fantasy_points" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_weekly_stats_external_id_check" CHECK ("player_weekly_stat_observations"."external_player_id" ~ '^00-[0-9]{7}$'),
	CONSTRAINT "player_weekly_stats_season_check" CHECK ("player_weekly_stat_observations"."season" between 1999 and 2200),
	CONSTRAINT "player_weekly_stats_week_check" CHECK ("player_weekly_stat_observations"."week" between 1 and 25),
	CONSTRAINT "player_weekly_stats_season_type_check" CHECK ("player_weekly_stat_observations"."season_type" in ('REG', 'POST')),
	CONSTRAINT "player_weekly_stats_context_check" CHECK (char_length(btrim("player_weekly_stat_observations"."game_id")) between 1 and 64 and "player_weekly_stat_observations"."team" ~ '^[A-Z]{2,4}$' and "player_weekly_stat_observations"."opponent_team" ~ '^[A-Z]{2,4}$'),
	CONSTRAINT "player_weekly_stats_payload_check" CHECK (jsonb_typeof("player_weekly_stat_observations"."components") = 'object' and "player_weekly_stat_observations"."components" <> '{}'::jsonb and jsonb_typeof("player_weekly_stat_observations"."advanced") = 'object' and jsonb_typeof("player_weekly_stat_observations"."source_fantasy_points") = 'object'),
	CONSTRAINT "player_weekly_stats_checksum_check" CHECK ("player_weekly_stat_observations"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projection_model_runs" (
	"source_sync_run_id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"target_week" integer NOT NULL,
	"model_version" text NOT NULL,
	"training_window_start_season" integer NOT NULL,
	"trained_through_season" integer NOT NULL,
	"trained_through_week" integer,
	"quality_state" text NOT NULL,
	"players_evaluated" integer NOT NULL,
	"players_published" integer NOT NULL,
	"input_checksum" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"calibration" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"source_as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projection_model_runs_season_check" CHECK ("projection_model_runs"."season" between 2000 and 2200),
	CONSTRAINT "projection_model_runs_week_check" CHECK ("projection_model_runs"."target_week" between 1 and 25),
	CONSTRAINT "projection_model_runs_training_window_check" CHECK ("projection_model_runs"."training_window_start_season" between 1999 and "projection_model_runs"."trained_through_season" and "projection_model_runs"."trained_through_season" <= "projection_model_runs"."season" and ("projection_model_runs"."trained_through_week" is null or "projection_model_runs"."trained_through_week" between 1 and 25)),
	CONSTRAINT "projection_model_runs_identity_check" CHECK (char_length(btrim("projection_model_runs"."model_version")) > 0),
	CONSTRAINT "projection_model_runs_quality_check" CHECK ("projection_model_runs"."quality_state" in ('publishable', 'degraded', 'rejected')),
	CONSTRAINT "projection_model_runs_counts_check" CHECK ("projection_model_runs"."players_evaluated" >= 0 and "projection_model_runs"."players_published" >= 0 and "projection_model_runs"."players_published" <= "projection_model_runs"."players_evaluated"),
	CONSTRAINT "projection_model_runs_payload_check" CHECK (jsonb_typeof("projection_model_runs"."configuration") = 'object' and jsonb_typeof("projection_model_runs"."calibration") = 'object' and jsonb_typeof("projection_model_runs"."metrics") = 'object'),
	CONSTRAINT "projection_model_runs_checksum_check" CHECK ("projection_model_runs"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projection_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"kind" text NOT NULL,
	"source_version" text NOT NULL,
	"independence_key" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer,
	"horizon" text NOT NULL,
	"scoring_profile" jsonb,
	"scoring_profile_key" text,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"floor_components" jsonb,
	"ceiling_components" jsonb,
	"mean_points" numeric(10, 3),
	"floor_points" numeric(10, 3),
	"ceiling_points" numeric(10, 3),
	"source_as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projection_observations_external_id_check" CHECK (char_length(btrim("projection_observations"."external_player_id")) between 1 and 128),
	CONSTRAINT "projection_observations_kind_check" CHECK ("projection_observations"."kind" in ('points', 'stat-components')),
	CONSTRAINT "projection_observations_identity_check" CHECK (char_length(btrim("projection_observations"."source_version")) > 0 and char_length(btrim("projection_observations"."independence_key")) > 0),
	CONSTRAINT "projection_observations_season_check" CHECK ("projection_observations"."season" between 2000 and 2200),
	CONSTRAINT "projection_observations_horizon_check" CHECK ("projection_observations"."horizon" in ('week', 'rest-of-season', 'full-season') and (("projection_observations"."horizon" = 'week' and "projection_observations"."week" between 1 and 25) or ("projection_observations"."horizon" <> 'week' and "projection_observations"."week" is null))),
	CONSTRAINT "projection_observations_payload_check" CHECK (("projection_observations"."kind" = 'points' and "projection_observations"."mean_points" is not null and "projection_observations"."scoring_profile" is not null and jsonb_typeof("projection_observations"."scoring_profile") = 'object' and "projection_observations"."scoring_profile_key" is not null and char_length("projection_observations"."scoring_profile_key") > 0) or ("projection_observations"."kind" = 'stat-components' and "projection_observations"."mean_points" is null and "projection_observations"."floor_points" is null and "projection_observations"."ceiling_points" is null and "projection_observations"."scoring_profile" is null and "projection_observations"."scoring_profile_key" is null and jsonb_typeof("projection_observations"."components") = 'object' and "projection_observations"."components" <> '{}'::jsonb)),
	CONSTRAINT "projection_observations_component_shape_check" CHECK (jsonb_typeof("projection_observations"."components") = 'object' and ("projection_observations"."floor_components" is null or jsonb_typeof("projection_observations"."floor_components") = 'object') and ("projection_observations"."ceiling_components" is null or jsonb_typeof("projection_observations"."ceiling_components") = 'object')),
	CONSTRAINT "projection_observations_interval_check" CHECK ("projection_observations"."floor_points" is null or "projection_observations"."ceiling_points" is null or "projection_observations"."floor_points" <= "projection_observations"."ceiling_points"),
	CONSTRAINT "projection_observations_checksum_check" CHECK ("projection_observations"."input_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "projection_observations_time_check" CHECK ("projection_observations"."source_as_of" <= "projection_observations"."fetched_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "team_weekly_stat_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_team_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"season_type" text NOT NULL,
	"game_id" text NOT NULL,
	"team" text NOT NULL,
	"opponent_team" text NOT NULL,
	"components" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_weekly_stats_external_id_check" CHECK (char_length(btrim("team_weekly_stat_observations"."external_team_id")) between 2 and 16),
	CONSTRAINT "team_weekly_stats_season_check" CHECK ("team_weekly_stat_observations"."season" between 1999 and 2200),
	CONSTRAINT "team_weekly_stats_week_check" CHECK ("team_weekly_stat_observations"."week" between 1 and 25),
	CONSTRAINT "team_weekly_stats_season_type_check" CHECK ("team_weekly_stat_observations"."season_type" in ('REG', 'POST')),
	CONSTRAINT "team_weekly_stats_context_check" CHECK (char_length(btrim("team_weekly_stat_observations"."game_id")) between 1 and 64 and "team_weekly_stat_observations"."team" ~ '^[A-Z]{2,4}$' and "team_weekly_stat_observations"."opponent_team" ~ '^[A-Z]{2,4}$' and "team_weekly_stat_observations"."team" <> "team_weekly_stat_observations"."opponent_team"),
	CONSTRAINT "team_weekly_stats_payload_check" CHECK (jsonb_typeof("team_weekly_stat_observations"."components") = 'object' and "team_weekly_stat_observations"."components" <> '{}'::jsonb),
	CONSTRAINT "team_weekly_stats_checksum_check" CHECK ("team_weekly_stat_observations"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "projection_sets" DROP CONSTRAINT "projection_sets_scope_check";--> statement-breakpoint
ALTER TABLE "adp_observations" ADD CONSTRAINT "adp_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adp_observations" ADD CONSTRAINT "adp_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adp_observations" ADD CONSTRAINT "adp_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_schedule_observations" ADD CONSTRAINT "nfl_schedule_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_schedule_observations" ADD CONSTRAINT "nfl_schedule_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_snap_count_observations" ADD CONSTRAINT "player_snap_count_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_snap_count_observations" ADD CONSTRAINT "player_snap_count_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_snap_count_observations" ADD CONSTRAINT "player_snap_count_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weekly_stat_observations" ADD CONSTRAINT "player_weekly_stat_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weekly_stat_observations" ADD CONSTRAINT "player_weekly_stat_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weekly_stat_observations" ADD CONSTRAINT "player_weekly_stat_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_observations" ADD CONSTRAINT "projection_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_observations" ADD CONSTRAINT "projection_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_observations" ADD CONSTRAINT "projection_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_weekly_stat_observations" ADD CONSTRAINT "team_weekly_stat_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_weekly_stat_observations" ADD CONSTRAINT "team_weekly_stat_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adp_observations_source_context_player_unique" ON "adp_observations" USING btree ("source_id","season","scoring_format","team_count","roster_format","source_as_of","external_player_id");--> statement-breakpoint
CREATE INDEX "adp_observations_player_context_idx" ON "adp_observations" USING btree ("player_id","season","scoring_format","team_count","source_as_of");--> statement-breakpoint
CREATE INDEX "adp_observations_source_freshness_idx" ON "adp_observations" USING btree ("source_id","source_as_of");--> statement-breakpoint
CREATE INDEX "adp_observations_sync_run_idx" ON "adp_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nfl_schedule_observations_source_game_unique" ON "nfl_schedule_observations" USING btree ("source_id","external_game_id","input_checksum");--> statement-breakpoint
CREATE INDEX "nfl_schedule_observations_season_week_idx" ON "nfl_schedule_observations" USING btree ("season","week","season_type","source_as_of");--> statement-breakpoint
CREATE INDEX "nfl_schedule_observations_away_team_idx" ON "nfl_schedule_observations" USING btree ("away_team","season","week");--> statement-breakpoint
CREATE INDEX "nfl_schedule_observations_home_team_idx" ON "nfl_schedule_observations" USING btree ("home_team","season","week");--> statement-breakpoint
CREATE INDEX "nfl_schedule_observations_sync_run_idx" ON "nfl_schedule_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_snap_counts_source_game_player_unique" ON "player_snap_count_observations" USING btree ("source_id","game_id","external_player_id","input_checksum");--> statement-breakpoint
CREATE INDEX "player_snap_counts_player_week_idx" ON "player_snap_count_observations" USING btree ("player_id","season","week","season_type");--> statement-breakpoint
CREATE INDEX "player_snap_counts_source_week_idx" ON "player_snap_count_observations" USING btree ("source_id","season","week");--> statement-breakpoint
CREATE INDEX "player_snap_counts_sync_run_idx" ON "player_snap_count_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "player_snap_counts_unmatched_idx" ON "player_snap_count_observations" USING btree ("source_id","season","week") WHERE "player_snap_count_observations"."player_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "player_weekly_stats_source_game_player_unique" ON "player_weekly_stat_observations" USING btree ("source_id","game_id","external_player_id","input_checksum");--> statement-breakpoint
CREATE INDEX "player_weekly_stats_player_week_idx" ON "player_weekly_stat_observations" USING btree ("player_id","season","week","season_type");--> statement-breakpoint
CREATE INDEX "player_weekly_stats_source_week_idx" ON "player_weekly_stat_observations" USING btree ("source_id","season","week");--> statement-breakpoint
CREATE INDEX "player_weekly_stats_sync_run_idx" ON "player_weekly_stat_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "player_weekly_stats_unmatched_idx" ON "player_weekly_stat_observations" USING btree ("source_id","season","week") WHERE "player_weekly_stat_observations"."player_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projection_model_runs_target_checksum_unique" ON "projection_model_runs" USING btree ("source_id","season","target_week","model_version","input_checksum");--> statement-breakpoint
CREATE INDEX "projection_model_runs_target_created_idx" ON "projection_model_runs" USING btree ("season","target_week","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_observations_source_version_player_unique" ON "projection_observations" USING btree ("source_id","source_version","season","week","horizon","external_player_id","input_checksum");--> statement-breakpoint
CREATE INDEX "projection_observations_player_horizon_idx" ON "projection_observations" USING btree ("player_id","season","week","horizon","source_as_of");--> statement-breakpoint
CREATE INDEX "projection_observations_source_freshness_idx" ON "projection_observations" USING btree ("source_id","source_as_of");--> statement-breakpoint
CREATE INDEX "projection_observations_sync_run_idx" ON "projection_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "projection_observations_unmatched_idx" ON "projection_observations" USING btree ("source_id","source_as_of") WHERE "projection_observations"."player_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "team_weekly_stats_source_game_team_unique" ON "team_weekly_stat_observations" USING btree ("source_id","game_id","external_team_id","input_checksum");--> statement-breakpoint
CREATE INDEX "team_weekly_stats_team_week_idx" ON "team_weekly_stat_observations" USING btree ("team","season","week","season_type");--> statement-breakpoint
CREATE INDEX "team_weekly_stats_opponent_week_idx" ON "team_weekly_stat_observations" USING btree ("opponent_team","season","week","season_type");--> statement-breakpoint
CREATE INDEX "team_weekly_stats_source_week_idx" ON "team_weekly_stat_observations" USING btree ("source_id","season","week");--> statement-breakpoint
CREATE INDEX "team_weekly_stats_sync_run_idx" ON "team_weekly_stat_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
ALTER TABLE "projection_sets" ADD CONSTRAINT "projection_sets_scope_check" CHECK (("projection_sets"."visibility" = 'global' and "projection_sets"."league_season_id" is null and "projection_sets"."created_by_user_id" is null) or ("projection_sets"."visibility" = 'private' and "projection_sets"."league_season_id" is not null and "projection_sets"."created_by_user_id" is not null) or ("projection_sets"."visibility" = 'league' and "projection_sets"."league_season_id" is not null));
--> statement-breakpoint
CREATE FUNCTION "enforce_automated_observations_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "adp_observations_append_only_trigger"
BEFORE UPDATE OR DELETE ON "adp_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "projection_observations_append_only_trigger"
BEFORE UPDATE OR DELETE ON "projection_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "player_weekly_stats_append_only_trigger"
BEFORE UPDATE OR DELETE ON "player_weekly_stat_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "player_snap_counts_append_only_trigger"
BEFORE UPDATE OR DELETE ON "player_snap_count_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "nfl_schedule_observations_append_only_trigger"
BEFORE UPDATE OR DELETE ON "nfl_schedule_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "team_weekly_stats_append_only_trigger"
BEFORE UPDATE OR DELETE ON "team_weekly_stat_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
--> statement-breakpoint
CREATE TRIGGER "projection_model_runs_append_only_trigger"
BEFORE UPDATE OR DELETE ON "projection_model_runs"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
