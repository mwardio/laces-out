CREATE TABLE "player_injury_report_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"external_player_id" text NOT NULL,
	"player_id" uuid,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"season_type" text NOT NULL,
	"game_type" text NOT NULL,
	"team" text NOT NULL,
	"position" text NOT NULL,
	"report_primary_injury" text,
	"report_secondary_injury" text,
	"report_status" text,
	"practice_primary_injury" text,
	"practice_secondary_injury" text,
	"practice_status" text,
	"source_modified_at" timestamp with time zone,
	"state_key" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_injury_reports_external_id_check" CHECK ("player_injury_report_observations"."external_player_id" ~ '^00-[0-9]{7}$'),
	CONSTRAINT "player_injury_reports_season_check" CHECK ("player_injury_report_observations"."season" between 2009 and 2200),
	CONSTRAINT "player_injury_reports_week_check" CHECK ("player_injury_report_observations"."week" between 1 and 25),
	CONSTRAINT "player_injury_reports_season_type_check" CHECK ("player_injury_report_observations"."season_type" in ('REG', 'POST')),
	CONSTRAINT "player_injury_reports_game_type_check" CHECK ("player_injury_report_observations"."game_type" in ('REG', 'WC', 'DIV', 'CON', 'SB')),
	CONSTRAINT "player_injury_reports_context_check" CHECK ("player_injury_report_observations"."team" ~ '^[A-Z]{2,4}$' and char_length(btrim("player_injury_report_observations"."position")) between 1 and 16),
	CONSTRAINT "player_injury_reports_report_status_check" CHECK ("player_injury_report_observations"."report_status" is null or "player_injury_report_observations"."report_status" in ('out', 'doubtful', 'questionable', 'probable', 'note')),
	CONSTRAINT "player_injury_reports_practice_status_check" CHECK ("player_injury_report_observations"."practice_status" is null or "player_injury_report_observations"."practice_status" in ('did-not-participate', 'limited', 'full', 'out', 'note')),
	CONSTRAINT "player_injury_reports_payload_check" CHECK ("player_injury_report_observations"."report_primary_injury" is not null or "player_injury_report_observations"."report_status" is not null or "player_injury_report_observations"."practice_primary_injury" is not null or "player_injury_report_observations"."practice_status" is not null),
	CONSTRAINT "player_injury_reports_state_key_check" CHECK ("player_injury_report_observations"."state_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "player_injury_reports_checksum_check" CHECK ("player_injury_report_observations"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "player_injury_report_observations" ADD CONSTRAINT "player_injury_report_observations_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_injury_report_observations" ADD CONSTRAINT "player_injury_report_observations_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_injury_report_observations" ADD CONSTRAINT "player_injury_report_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_injury_reports_source_state_unique" ON "player_injury_report_observations" USING btree ("source_id","season","week","external_player_id","state_key","input_checksum");--> statement-breakpoint
CREATE INDEX "player_injury_reports_player_week_idx" ON "player_injury_report_observations" USING btree ("player_id","season","week");--> statement-breakpoint
CREATE INDEX "player_injury_reports_source_week_idx" ON "player_injury_report_observations" USING btree ("source_id","season","week");--> statement-breakpoint
CREATE INDEX "player_injury_reports_sync_run_idx" ON "player_injury_report_observations" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "player_injury_reports_unmatched_idx" ON "player_injury_report_observations" USING btree ("source_id","season","week") WHERE "player_injury_report_observations"."player_id" is null;
--> statement-breakpoint
CREATE TRIGGER "player_injury_reports_append_only_trigger"
BEFORE UPDATE OR DELETE ON "player_injury_report_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_automated_observations_append_only"();
