ALTER TABLE "drafts" ADD CONSTRAINT "drafts_type_check" CHECK ("drafts"."type" in ('snake', 'auction'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_budget_check" CHECK ("drafts"."budget_per_team" is null or "drafts"."budget_per_team" > 0);--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_minimum_bid_check" CHECK ("drafts"."minimum_bid" is null or "drafts"."minimum_bid" > 0);--> statement-breakpoint
ALTER TABLE "league_seasons" ADD CONSTRAINT "league_seasons_provider_check" CHECK ("league_seasons"."provider" in ('yahoo', 'espn', 'manual'));--> statement-breakpoint
ALTER TABLE "league_seasons" ADD CONSTRAINT "league_seasons_team_count_check" CHECK ("league_seasons"."team_count" > 1);--> statement-breakpoint
ALTER TABLE "player_external_ids" ADD CONSTRAINT "player_external_ids_confidence_check" CHECK ("player_external_ids"."confidence" >= 0 and "player_external_ids"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_provider_check" CHECK ("provider_connections"."provider" in ('yahoo', 'espn', 'manual'));--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_health_check" CHECK ("provider_connections"."health" in ('pending', 'healthy', 'degraded', 'reauthorize', 'disabled'));--> statement-breakpoint
ALTER TABLE "roster_slot_rules" ADD CONSTRAINT "roster_slot_rules_count_check" CHECK ("roster_slot_rules"."count" >= 0);