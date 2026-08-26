ALTER TABLE "league_memberships" ADD COLUMN "explicit_commissioner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Accepted commissioner invitations are durable explicit evidence. Preserve that evidence even
-- when the accepted user is the canonical owner, whose stored role remains owner.
UPDATE "league_memberships" AS membership
SET "role" = CASE WHEN membership."role" = 'owner' THEN 'owner' ELSE 'commissioner' END,
    "explicit_commissioner" = true
WHERE EXISTS (
  SELECT 1
  FROM "invitations" AS accepted_invitation
  WHERE accepted_invitation."league_id" = membership."league_id"
    AND accepted_invitation."accepted_by_user_id" = membership."user_id"
    AND accepted_invitation."league_role" = 'commissioner'
    AND accepted_invitation."accepted_at" IS NOT NULL
);--> statement-breakpoint
-- The former ESPN path recorded this exact promotion audit in the same transaction as its role
-- mutation. Later membership timestamps do not turn provider-derived authority into an explicit
-- grant. Demote every exactly classified legacy promotion unless an accepted commissioner
-- invitation above proves explicit authority; malformed, unrelated, and unclassified rows remain
-- conservative.
UPDATE "league_memberships" AS membership
SET "role" = 'member'
WHERE membership."role" = 'commissioner'
  AND membership."explicit_commissioner" = false
  AND EXISTS (
    SELECT 1
    FROM "audit_events" AS promotion
    WHERE promotion."action" = 'espn.membership.commissioner_promoted'
      AND promotion."target_type" = 'league_membership'
      AND promotion."target_id" = membership."id"::text
      AND promotion."user_id" = membership."user_id"
      AND promotion."metadata" ->> 'provider' = 'espn'
      AND promotion."metadata" ->> 'signal' = 'league-manager'
      AND promotion."metadata" ->> 'previousRole' = 'member'
      AND promotion."metadata" ->> 'role' = 'commissioner'
  );--> statement-breakpoint
-- Remaining commissioner rows are durable Laces Out authority. Owners stay false unless the exact
-- accepted-invitation evidence above marked them explicit; ownership alone is not commissioner
-- evidence.
UPDATE "league_memberships"
SET "explicit_commissioner" = true
WHERE "role" = 'commissioner';--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_explicit_commissioner_role_check" CHECK ("league_memberships"."role" = 'owner' or "league_memberships"."explicit_commissioner" = ("league_memberships"."role" = 'commissioner'));--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "provider_commissioner" boolean;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD COLUMN "provider_commissioner_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_commissioner_observation_check" CHECK (("provider_league_links"."provider_commissioner" is null) = ("provider_league_links"."provider_commissioner_observed_at" is null));--> statement-breakpoint
ALTER TABLE "provider_league_links" ADD CONSTRAINT "provider_league_links_commissioner_identity_check" CHECK ("provider_league_links"."provider_commissioner" is null or "provider_league_links"."current_user_team_external_key" is not null);--> statement-breakpoint

-- Ownership transfer keeps its existing database invariants, but an old canonical owner becomes
-- a product commissioner only when an explicit grant was already retained on that membership.
CREATE OR REPLACE FUNCTION "sync_league_owner_membership"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
		UPDATE "league_memberships"
		SET "role" = CASE
				WHEN "explicit_commissioner" THEN 'commissioner'
				ELSE 'member'
			END,
			"updated_at" = now()
		WHERE "league_id" = NEW."id" AND "user_id" = OLD."user_id" AND "role" = 'owner';
	END IF;

	IF TG_OP = 'INSERT' OR NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
		INSERT INTO "league_memberships" ("league_id", "user_id", "role")
		VALUES (NEW."id", NEW."user_id", 'owner')
		ON CONFLICT ("league_id", "user_id") DO UPDATE
		SET "role" = 'owner', "updated_at" = now();
	END IF;

	RETURN NEW;
END;
$$;
