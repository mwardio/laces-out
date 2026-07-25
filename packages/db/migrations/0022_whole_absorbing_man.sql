CREATE TABLE "draft_provider_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"league_season_id" uuid NOT NULL,
	"provider" text DEFAULT 'espn' NOT NULL,
	"provider_league_id" text NOT NULL,
	"season" integer NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"active_device_id" uuid,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"active_page_session_id" uuid,
	"last_page_revision" integer,
	"last_checksum" text,
	"last_observed_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"last_material_event_at" timestamp with time zone,
	"last_pick_count" integer DEFAULT 0 NOT NULL,
	"current_auction_state" jsonb,
	"pending_destructive_checksum" text,
	"pending_destructive_seen_count" integer DEFAULT 0 NOT NULL,
	"manual_backup_active" boolean DEFAULT false NOT NULL,
	"verification" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_provider_feeds_provider_check" CHECK ("draft_provider_feeds"."provider" = 'espn'),
	CONSTRAINT "draft_provider_feeds_state_check" CHECK ("draft_provider_feeds"."state" in ('waiting', 'live', 'paused', 'stale', 'complete', 'degraded')),
	CONSTRAINT "draft_provider_feeds_verification_check" CHECK ("draft_provider_feeds"."verification" in ('pending', 'verified', 'mismatched')),
	CONSTRAINT "draft_provider_feeds_external_id_check" CHECK ("draft_provider_feeds"."provider_league_id" ~ '^[0-9]+$'),
	CONSTRAINT "draft_provider_feeds_season_check" CHECK ("draft_provider_feeds"."season" >= 2019 and "draft_provider_feeds"."season" <= 2100),
	CONSTRAINT "draft_provider_feeds_counts_check" CHECK ("draft_provider_feeds"."lease_generation" >= 0 and "draft_provider_feeds"."last_pick_count" >= 0 and "draft_provider_feeds"."pending_destructive_seen_count" >= 0 and ("draft_provider_feeds"."last_page_revision" is null or "draft_provider_feeds"."last_page_revision" >= 0)),
	CONSTRAINT "draft_provider_feeds_checksum_check" CHECK (("draft_provider_feeds"."last_checksum" is null or "draft_provider_feeds"."last_checksum" ~ '^[a-f0-9]{64}$') and ("draft_provider_feeds"."pending_destructive_checksum" is null or "draft_provider_feeds"."pending_destructive_checksum" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "draft_provider_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"device_id" uuid,
	"page_session_id" uuid NOT NULL,
	"page_revision" integer NOT NULL,
	"checksum" text NOT NULL,
	"provider_state" text NOT NULL,
	"pick_count" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"result" text NOT NULL,
	"issue_summary" jsonb,
	CONSTRAINT "draft_provider_observations_result_check" CHECK ("draft_provider_observations"."result" in ('accepted', 'idempotent', 'standby', 'held', 'rejected')),
	CONSTRAINT "draft_provider_observations_state_check" CHECK ("draft_provider_observations"."provider_state" in ('waiting', 'live', 'paused', 'complete')),
	CONSTRAINT "draft_provider_observations_checksum_check" CHECK ("draft_provider_observations"."checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "draft_provider_observations_counts_check" CHECK ("draft_provider_observations"."page_revision" >= 0 and "draft_provider_observations"."pick_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "draft_provider_feeds" ADD CONSTRAINT "draft_provider_feeds_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_provider_feeds" ADD CONSTRAINT "draft_provider_feeds_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_provider_feeds" ADD CONSTRAINT "draft_provider_feeds_active_device_id_bridge_devices_id_fk" FOREIGN KEY ("active_device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_provider_observations" ADD CONSTRAINT "draft_provider_observations_feed_id_draft_provider_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."draft_provider_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_provider_observations" ADD CONSTRAINT "draft_provider_observations_device_id_bridge_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."bridge_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_provider_feeds_draft_unique" ON "draft_provider_feeds" USING btree ("draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_provider_feeds_league_season_unique" ON "draft_provider_feeds" USING btree ("provider","provider_league_id","season");--> statement-breakpoint
CREATE INDEX "draft_provider_feeds_state_idx" ON "draft_provider_feeds" USING btree ("state","last_received_at");--> statement-breakpoint
CREATE INDEX "draft_provider_observations_feed_idx" ON "draft_provider_observations" USING btree ("feed_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_provider_observations_revision_unique" ON "draft_provider_observations" USING btree ("feed_id","page_session_id","page_revision");--> statement-breakpoint
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_source_check" CHECK ("draft_events"."source" in ('manual', 'espn'));