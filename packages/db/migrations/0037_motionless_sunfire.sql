CREATE TABLE "league_sync_exclusions" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_key" text NOT NULL,
	"season" integer NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_sync_exclusions_user_id_provider_external_key_season_pk" PRIMARY KEY("user_id","provider","external_key","season"),
	CONSTRAINT "league_sync_exclusions_provider_check" CHECK ("league_sync_exclusions"."provider" in ('yahoo', 'espn')),
	CONSTRAINT "league_sync_exclusions_external_key_check" CHECK (char_length(btrim("league_sync_exclusions"."external_key")) > 0),
	CONSTRAINT "league_sync_exclusions_season_check" CHECK ("league_sync_exclusions"."season" between 2000 and 2200)
);
--> statement-breakpoint
ALTER TABLE "league_sync_exclusions" ADD CONSTRAINT "league_sync_exclusions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "league_sync_exclusions_user_idx" ON "league_sync_exclusions" USING btree ("user_id","removed_at");
