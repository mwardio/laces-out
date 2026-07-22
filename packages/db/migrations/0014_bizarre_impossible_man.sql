CREATE TABLE "player_weekly_roster_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"team" text NOT NULL,
	"position" text NOT NULL,
	"roster_status" text,
	"status_description" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_weekly_rosters_external_id_check" CHECK (char_length(btrim("player_weekly_roster_observations"."external_player_id")) between 1 and 64),
	CONSTRAINT "player_weekly_rosters_season_check" CHECK ("player_weekly_roster_observations"."season" between 2002 and 2200),
	CONSTRAINT "player_weekly_rosters_week_check" CHECK ("player_weekly_roster_observations"."week" between 1 and 25),
	CONSTRAINT "player_weekly_rosters_context_check" CHECK ("player_weekly_roster_observations"."team" ~ '^[A-Z]{2,4}$' and char_length(btrim("player_weekly_roster_observations"."position")) between 1 and 16),
	CONSTRAINT "player_weekly_rosters_status_check" CHECK (("player_weekly_roster_observations"."roster_status" is null or char_length("player_weekly_roster_observations"."roster_status") between 1 and 64) and ("player_weekly_roster_observations"."status_description" is null or char_length("player_weekly_roster_observations"."status_description") between 1 and 64)),
	CONSTRAINT "player_weekly_rosters_checksum_check" CHECK ("player_weekly_roster_observations"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "player_weekly_roster_observations" ADD CONSTRAINT "player_weekly_roster_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weekly_roster_observations" ADD CONSTRAINT "player_weekly_roster_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weekly_roster_observations" ADD CONSTRAINT "player_weekly_roster_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_weekly_rosters_source_week_player_unique" ON "player_weekly_roster_observations" USING btree ("source_id","season","week","team","external_player_id","roster_status","status_description","input_checksum");--> statement-breakpoint
CREATE INDEX "player_weekly_rosters_player_week_idx" ON "player_weekly_roster_observations" USING btree ("player_id","season","week");--> statement-breakpoint
CREATE INDEX "player_weekly_rosters_source_week_idx" ON "player_weekly_roster_observations" USING btree ("source_id","season","week");--> statement-breakpoint
CREATE INDEX "player_weekly_rosters_sync_run_idx" ON "player_weekly_roster_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "player_weekly_rosters_unmatched_idx" ON "player_weekly_roster_observations" USING btree ("source_id","season","week") WHERE "player_weekly_roster_observations"."player_id" is null;
--> statement-breakpoint
CREATE TRIGGER "player_weekly_rosters_append_only_trigger"
BEFORE UPDATE OR DELETE ON "player_weekly_roster_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
