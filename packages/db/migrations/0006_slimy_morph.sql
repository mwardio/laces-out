ALTER TABLE "bridge_device_leagues" DROP CONSTRAINT "bridge_device_leagues_league_id_leagues_id_fk";
--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" DROP CONSTRAINT "bridge_device_leagues_bridge_device_id_league_id_pk";--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ALTER COLUMN "league_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD COLUMN "external_league_id" text;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD COLUMN "season" integer;--> statement-breakpoint

-- The bridge allowlist originally depended on an internal league. Backfill when that league has
-- a numeric ESPN season and stop for operator intervention rather than inventing authorization.
UPDATE "bridge_device_leagues" bdl
SET ("external_league_id", "season") = (
	SELECT ls."external_key", ls."season"
	FROM "league_seasons" ls
	WHERE ls."league_id" = bdl."league_id"
		AND ls."provider" = 'espn'
		AND ls."external_key" ~ '^[0-9]+$'
	ORDER BY ls."season" DESC
	LIMIT 1
);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "bridge_device_leagues" WHERE "external_league_id" IS NULL
	) THEN
		RAISE EXCEPTION 'bridge allowlist migration requires a numeric ESPN league mapping';
	END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ALTER COLUMN "external_league_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD CONSTRAINT "bridge_device_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_device_leagues_season_unique" ON "bridge_device_leagues" USING btree ("bridge_device_id","external_league_id","season") WHERE "bridge_device_leagues"."season" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_device_leagues_all_seasons_unique" ON "bridge_device_leagues" USING btree ("bridge_device_id","external_league_id") WHERE "bridge_device_leagues"."season" is null;--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD CONSTRAINT "bridge_device_leagues_external_id_check" CHECK ("bridge_device_leagues"."external_league_id" ~ '^[0-9]+$');--> statement-breakpoint
ALTER TABLE "bridge_device_leagues" ADD CONSTRAINT "bridge_device_leagues_season_check" CHECK ("bridge_device_leagues"."season" is null or ("bridge_device_leagues"."season" >= 2000 and "bridge_device_leagues"."season" <= 2200));--> statement-breakpoint

CREATE FUNCTION "enforce_bridge_device_league_grant"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	device_user_id uuid;
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "bridge_device_leagues" existing
		WHERE existing."bridge_device_id" = NEW."bridge_device_id"
			AND existing."external_league_id" = NEW."external_league_id"
			AND existing."id" <> NEW."id"
			AND (
				existing."season" IS NULL
				OR NEW."season" IS NULL
				OR existing."season" = NEW."season"
			)
	) THEN
		RAISE EXCEPTION 'bridge league grant overlaps an existing season scope';
	END IF;

	IF NEW."league_id" IS NOT NULL THEN
		SELECT "user_id" INTO device_user_id
		FROM "bridge_devices"
		WHERE "id" = NEW."bridge_device_id";

		IF NOT EXISTS (
			SELECT 1 FROM "league_memberships"
			WHERE "league_id" = NEW."league_id" AND "user_id" = device_user_id
		) THEN
			RAISE EXCEPTION 'bridge device owner must be a member of the linked league';
		END IF;

		IF NOT EXISTS (
			SELECT 1 FROM "league_seasons"
			WHERE "league_id" = NEW."league_id"
				AND "provider" = 'espn'
				AND "external_key" = NEW."external_league_id"
				AND (NEW."season" IS NULL OR "season" = NEW."season")
		) THEN
			RAISE EXCEPTION 'internal league link must match the authorized ESPN league and season';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "bridge_device_leagues_grant_trigger"
BEFORE INSERT OR UPDATE ON "bridge_device_leagues"
FOR EACH ROW EXECUTE FUNCTION "enforce_bridge_device_league_grant"();
