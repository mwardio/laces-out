CREATE TABLE "provider_league_links" (
	"connection_id" uuid NOT NULL,
	"league_season_id" uuid NOT NULL,
	"current_user_team_external_key" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_league_links_connection_id_league_season_id_pk" PRIMARY KEY("connection_id","league_season_id"),
	CONSTRAINT "provider_league_links_current_team_check" CHECK ("provider_league_links"."current_user_team_external_key" is null or char_length(btrim("provider_league_links"."current_user_team_external_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_league_links_season_idx" ON "provider_league_links" USING btree ("league_season_id");