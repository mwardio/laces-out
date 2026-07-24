CREATE TABLE "league_supplemental_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"as_of_week" integer,
	"availability" text,
	"effective_at" timestamp with time zone NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"bridge_device_id" uuid,
	"endpoint" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_supplemental_kind_check" CHECK ("league_supplemental_snapshots"."kind" in ('available-players', 'weekly-box-scores', 'transactions', 'completed-draft')),
	CONSTRAINT "league_supplemental_week_check" CHECK ("league_supplemental_snapshots"."as_of_week" is null or "league_supplemental_snapshots"."as_of_week" between 0 and 30),
	CONSTRAINT "league_supplemental_availability_check" CHECK (("league_supplemental_snapshots"."kind" = 'available-players' and "league_supplemental_snapshots"."availability" in ('free-agent', 'waivers')) or ("league_supplemental_snapshots"."kind" <> 'available-players' and "league_supplemental_snapshots"."availability" is null)),
	CONSTRAINT "league_supplemental_endpoint_check" CHECK (char_length(btrim("league_supplemental_snapshots"."endpoint")) between 1 and 2048),
	CONSTRAINT "league_supplemental_checksum_check" CHECK ("league_supplemental_snapshots"."artifact_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "league_supplemental_artifact_shape_check" CHECK (jsonb_typeof("league_supplemental_snapshots"."artifact") = 'object' and jsonb_typeof("league_supplemental_snapshots"."warnings") = 'array')
);
--> statement-breakpoint
ALTER TABLE "league_supplemental_snapshots" ADD CONSTRAINT "league_supplemental_snapshots_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_supplemental_snapshots" ADD CONSTRAINT "league_supplemental_snapshots_source_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_supplemental_snapshots" ADD CONSTRAINT "league_supplemental_snapshots_bridge_device_id_bridge_devices_id_fk" FOREIGN KEY ("bridge_device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "league_supplemental_source_sync_unique" ON "league_supplemental_snapshots" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_supplemental_artifact_unique" ON "league_supplemental_snapshots" USING btree ("league_season_id","kind","artifact_checksum");--> statement-breakpoint
CREATE INDEX "league_supplemental_latest_idx" ON "league_supplemental_snapshots" USING btree ("league_season_id","kind","as_of_week","effective_at");