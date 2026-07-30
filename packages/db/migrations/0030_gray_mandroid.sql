CREATE TABLE "recap_generation_guards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recap_generation_guards_week_check" CHECK ("recap_generation_guards"."week" between 1 and 30),
	CONSTRAINT "recap_generation_guards_lease_pair_check" CHECK (("recap_generation_guards"."lease_token" is null) = ("recap_generation_guards"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "recap_persona_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"fantasy_team_id" uuid NOT NULL,
	"body" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recap_persona_cards_body_check" CHECK (char_length(btrim("recap_persona_cards"."body")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "weekly_recaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_season_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"body" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"spice_level" text NOT NULL,
	"generated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_recaps_week_check" CHECK ("weekly_recaps"."week" between 1 and 30),
	CONSTRAINT "weekly_recaps_body_check" CHECK (char_length("weekly_recaps"."body") between 1 and 30000),
	CONSTRAINT "weekly_recaps_provider_check" CHECK ("weekly_recaps"."provider" in ('openai', 'anthropic', 'gemini', 'deepseek', 'grok', 'openrouter')),
	CONSTRAINT "weekly_recaps_spice_level_check" CHECK ("weekly_recaps"."spice_level" in ('mild', 'medium', 'scorched'))
);
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "recap_spice_level" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "recap_generation_guards" ADD CONSTRAINT "recap_generation_guards_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recap_persona_cards" ADD CONSTRAINT "recap_persona_cards_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recap_persona_cards" ADD CONSTRAINT "recap_persona_cards_fantasy_team_id_fantasy_teams_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recap_persona_cards" ADD CONSTRAINT "recap_persona_cards_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_recaps" ADD CONSTRAINT "weekly_recaps_league_season_id_league_seasons_id_fk" FOREIGN KEY ("league_season_id") REFERENCES "public"."league_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_recaps" ADD CONSTRAINT "weekly_recaps_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recap_generation_guards_season_week_unique" ON "recap_generation_guards" USING btree ("league_season_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "recap_persona_cards_team_unique" ON "recap_persona_cards" USING btree ("fantasy_team_id");--> statement-breakpoint
CREATE INDEX "recap_persona_cards_season_idx" ON "recap_persona_cards" USING btree ("league_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_recaps_season_week_unique" ON "weekly_recaps" USING btree ("league_season_id","week");--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_recap_spice_level_check" CHECK ("leagues"."recap_spice_level" in ('mild', 'medium', 'scorched'));