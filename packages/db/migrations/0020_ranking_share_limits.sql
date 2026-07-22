UPDATE "share_links"
SET
	"expires_at" = "created_at" + interval '30 days',
	"max_uses" = greatest("use_count", 100)
WHERE "ranking_list_id" IS NOT NULL
	AND "expires_at" IS NULL
	AND "max_uses" IS NULL;
--> statement-breakpoint
UPDATE "share_links"
SET "expires_at" = "created_at" + interval '30 days'
WHERE "ranking_list_id" IS NOT NULL
	AND "expires_at" IS NULL;
--> statement-breakpoint
UPDATE "share_links"
SET "max_uses" = greatest("use_count", 100)
WHERE "ranking_list_id" IS NOT NULL
	AND "max_uses" IS NULL;
