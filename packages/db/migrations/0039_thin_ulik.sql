ALTER TABLE "invitations" DROP CONSTRAINT "invitations_league_role_check";--> statement-breakpoint
ALTER TABLE "league_memberships" DROP CONSTRAINT "league_memberships_role_check";--> statement-breakpoint
UPDATE "invitations"
SET "league_role" = 'member'
WHERE "league_role" IN ('manager', 'viewer');--> statement-breakpoint
UPDATE "league_memberships"
SET "role" = 'member', "updated_at" = now()
WHERE "role" IN ('manager', 'viewer');--> statement-breakpoint
ALTER TABLE "league_memberships" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_league_role_check" CHECK ("invitations"."league_role" is null or "invitations"."league_role" in ('commissioner', 'member'));--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_role_check" CHECK ("league_memberships"."role" in ('owner', 'commissioner', 'member'));
