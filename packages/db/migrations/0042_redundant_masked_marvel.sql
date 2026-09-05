CREATE TABLE "yahoo_draft_poll_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"draft_id" uuid,
	"provider_league_key" text NOT NULL,
	"season" integer NOT NULL,
	"format" text NOT NULL,
	"application_mode" text NOT NULL,
	"release_artifact_checksum" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"poll_generation" integer DEFAULT 0 NOT NULL,
	"poll_lease_expires_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checksum" text,
	"last_provider_status" text,
	"last_declared_count" integer,
	"last_observed_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_material_event_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"unresolved_teams" integer DEFAULT 0 NOT NULL,
	"unresolved_players" integer DEFAULT 0 NOT NULL,
	"verification" text DEFAULT 'pending' NOT NULL,
	"last_issue_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yahoo_draft_poll_feeds_key_check" CHECK ("yahoo_draft_poll_feeds"."provider_league_key" ~ '^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$'),
	CONSTRAINT "yahoo_draft_poll_feeds_season_check" CHECK ("yahoo_draft_poll_feeds"."season" between 2019 and 2100),
	CONSTRAINT "yahoo_draft_poll_feeds_format_check" CHECK ("yahoo_draft_poll_feeds"."format" in ('snake', 'auction')),
	CONSTRAINT "yahoo_draft_poll_feeds_mode_check" CHECK ("yahoo_draft_poll_feeds"."application_mode" in ('shadow', 'append')),
	CONSTRAINT "yahoo_draft_poll_feeds_state_check" CHECK ("yahoo_draft_poll_feeds"."state" in ('waiting', 'drafting', 'complete', 'delayed', 'attention', 'disabled')),
	CONSTRAINT "yahoo_draft_poll_feeds_verification_check" CHECK ("yahoo_draft_poll_feeds"."verification" in ('pending', 'verified', 'mismatched')),
	CONSTRAINT "yahoo_draft_poll_feeds_counts_check" CHECK ("yahoo_draft_poll_feeds"."poll_generation" >= 0 and "yahoo_draft_poll_feeds"."last_observed_count" >= 0 and "yahoo_draft_poll_feeds"."consecutive_failures" >= 0 and "yahoo_draft_poll_feeds"."unresolved_teams" >= 0 and "yahoo_draft_poll_feeds"."unresolved_players" >= 0 and ("yahoo_draft_poll_feeds"."last_declared_count" is null or "yahoo_draft_poll_feeds"."last_declared_count" >= 0)),
	CONSTRAINT "yahoo_draft_poll_feeds_checksum_check" CHECK ("yahoo_draft_poll_feeds"."release_artifact_checksum" ~ '^[a-f0-9]{64}$' and ("yahoo_draft_poll_feeds"."last_checksum" is null or "yahoo_draft_poll_feeds"."last_checksum" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "yahoo_draft_poll_feeds_append_room_check" CHECK ("yahoo_draft_poll_feeds"."application_mode" <> 'append' or "yahoo_draft_poll_feeds"."draft_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "yahoo_draft_poll_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"connection_id" uuid,
	"poll_generation" integer NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"provider_status" text NOT NULL,
	"declared_count" integer,
	"observed_count" integer NOT NULL,
	"checksum" text NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"result" text NOT NULL,
	"issue_code" text,
	"applied_events" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yahoo_draft_poll_observations_result_check" CHECK ("yahoo_draft_poll_observations"."result" in ('appended', 'confirmed', 'idempotent', 'shadow', 'held', 'failed')),
	CONSTRAINT "yahoo_draft_poll_observations_counts_check" CHECK ("yahoo_draft_poll_observations"."poll_generation" > 0 and "yahoo_draft_poll_observations"."observed_count" >= 0 and "yahoo_draft_poll_observations"."applied_events" >= 0 and ("yahoo_draft_poll_observations"."declared_count" is null or "yahoo_draft_poll_observations"."declared_count" >= 0)),
	CONSTRAINT "yahoo_draft_poll_observations_checksum_check" CHECK ("yahoo_draft_poll_observations"."checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "yahoo_draft_poll_observations_shape_check" CHECK (jsonb_typeof("yahoo_draft_poll_observations"."normalized_payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "draft_events" DROP CONSTRAINT "draft_events_source_check";--> statement-breakpoint
ALTER TABLE "yahoo_draft_poll_feeds" ADD CONSTRAINT "yahoo_draft_poll_feeds_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yahoo_draft_poll_feeds" ADD CONSTRAINT "yahoo_draft_poll_feeds_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yahoo_draft_poll_observations" ADD CONSTRAINT "yahoo_draft_poll_observations_feed_id_yahoo_draft_poll_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."yahoo_draft_poll_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yahoo_draft_poll_observations" ADD CONSTRAINT "yahoo_draft_poll_observations_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "yahoo_draft_poll_feeds_season_unique" ON "yahoo_draft_poll_feeds" USING btree ("league_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "yahoo_draft_poll_feeds_draft_unique" ON "yahoo_draft_poll_feeds" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "yahoo_draft_poll_feeds_due_idx" ON "yahoo_draft_poll_feeds" USING btree ("state","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "yahoo_draft_poll_observations_generation_unique" ON "yahoo_draft_poll_observations" USING btree ("feed_id","poll_generation");--> statement-breakpoint
CREATE INDEX "yahoo_draft_poll_observations_feed_idx" ON "yahoo_draft_poll_observations" USING btree ("feed_id","checked_at");--> statement-breakpoint
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_source_check" CHECK ("draft_events"."source" in ('manual', 'espn', 'yahoo'));