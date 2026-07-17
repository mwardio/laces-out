ALTER TABLE "players" ADD COLUMN "rookie_season" integer;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "last_season" integer;--> statement-breakpoint
CREATE INDEX "players_last_season_idx" ON "players" USING btree ("last_season");--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_season_bounds_check" CHECK (("players"."rookie_season" is null or "players"."rookie_season" between 1900 and 2200) and ("players"."last_season" is null or "players"."last_season" between 1900 and 2200));--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_season_order_check" CHECK ("players"."rookie_season" is null or "players"."last_season" is null or "players"."last_season" >= "players"."rookie_season");