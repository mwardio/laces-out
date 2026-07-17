CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"correlation_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_events" (
	"draft_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reverts_sequence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_events_draft_id_sequence_pk" PRIMARY KEY("draft_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"budget_per_team" integer,
	"minimum_bid" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fantasy_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text,
	"is_user_team" boolean DEFAULT false NOT NULL,
	"manager_display_name" text,
	"faab_remaining" integer,
	"waiver_priority" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"external_key" text NOT NULL,
	"season" integer NOT NULL,
	"status" text DEFAULT 'preseason' NOT NULL,
	"team_count" integer NOT NULL,
	"draft_type" text NOT NULL,
	"waiver_type" text,
	"current_week" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_external_ids" (
	"player_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"season" integer,
	"confidence" numeric(5, 4) DEFAULT '1' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "player_external_ids_source_external_id_pk" PRIMARY KEY("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "player_projections" (
	"projection_set_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"mean_points" numeric(10, 3) NOT NULL,
	"floor_points" numeric(10, 3),
	"ceiling_points" numeric(10, 3),
	"confidence" numeric(5, 4),
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "player_projections_projection_set_id_player_id_pk" PRIMARY KEY("projection_set_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gsis_id" text,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"nfl_team" text,
	"primary_position" text NOT NULL,
	"eligible_positions" text[] NOT NULL,
	"status" text,
	"birth_date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projection_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer,
	"horizon" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"encrypted_credential" jsonb,
	"credential_expires_at" timestamp with time zone,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health" text DEFAULT 'pending' NOT NULL,
	"last_successful_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"random_seed" text,
	"inputs" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"action" jsonb NOT NULL,
	"expected_value_delta" numeric(10, 4),
	"confidence" numeric(5, 4),
	"explanation" text NOT NULL,
	"warnings" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"snapshot_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"slot_code" text NOT NULL,
	"is_starter" boolean NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "roster_entries_snapshot_id_player_id_pk" PRIMARY KEY("snapshot_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "roster_slot_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"slot_code" text NOT NULL,
	"count" integer NOT NULL,
	"eligible_positions" text[] NOT NULL,
	"is_starter" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"week" integer,
	"effective_at" timestamp with time zone NOT NULL,
	"source_sync_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"stat_key" text NOT NULL,
	"operation" text NOT NULL,
	"points" numeric(10, 4) NOT NULL,
	"threshold_low" numeric(10, 2),
	"threshold_high" numeric(10, 2),
	"provider_stat_id" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"league_season_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"records_read" integer DEFAULT 0 NOT NULL,
	"records_written" integer DEFAULT 0 NOT NULL,
	"artifact_checksum" text,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_teams" ADD CONSTRAINT "fantasy_teams_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_seasons" ADD CONSTRAINT "league_seasons_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_seasons" ADD CONSTRAINT "league_seasons_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_external_ids" ADD CONSTRAINT "player_external_ids_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_projection_set_id_projection_sets_id_fk" FOREIGN KEY ("projection_set_id") REFERENCES "public"."projection_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_projections" ADD CONSTRAINT "player_projections_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_run_id_recommendation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recommendation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_snapshot_id_roster_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."roster_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_slot_rules" ADD CONSTRAINT "roster_slot_rules_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshots" ADD CONSTRAINT "roster_snapshots_team_id_fantasy_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_user_time_idx" ON "audit_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_events_idempotency_unique" ON "draft_events" USING btree ("draft_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "drafts_league_idx" ON "drafts" USING btree ("league_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fantasy_teams_external_unique" ON "fantasy_teams" USING btree ("league_season_id","external_key");--> statement-breakpoint
CREATE INDEX "fantasy_teams_league_idx" ON "fantasy_teams" USING btree ("league_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_seasons_provider_key_unique" ON "league_seasons" USING btree ("provider","external_key","season");--> statement-breakpoint
CREATE INDEX "league_seasons_league_idx" ON "league_seasons" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "leagues_user_idx" ON "leagues" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "player_external_ids_player_idx" ON "player_external_ids" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_gsis_unique" ON "players" USING btree ("gsis_id");--> statement-breakpoint
CREATE INDEX "players_name_idx" ON "players" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_sets_source_version_unique" ON "projection_sets" USING btree ("source","version");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_account_unique" ON "provider_connections" USING btree ("user_id","provider","external_account_id");--> statement-breakpoint
CREATE INDEX "provider_connections_user_idx" ON "provider_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recommendation_runs_league_kind_idx" ON "recommendation_runs" USING btree ("league_season_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_run_rank_unique" ON "recommendations" USING btree ("run_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_slot_rules_unique" ON "roster_slot_rules" USING btree ("league_season_id","slot_code");--> statement-breakpoint
CREATE INDEX "roster_snapshots_team_effective_idx" ON "roster_snapshots" USING btree ("team_id","effective_at");--> statement-breakpoint
CREATE INDEX "scoring_rules_league_idx" ON "scoring_rules" USING btree ("league_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_idempotency_unique" ON "sync_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_runs_league_created_idx" ON "sync_runs" USING btree ("league_season_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));