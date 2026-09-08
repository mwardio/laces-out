ALTER TABLE "scoring_rules" ADD COLUMN "position_types" text[];--> statement-breakpoint

-- Yahoo's normalized season settings have retained the provider-declared O/K/DT scope since the
-- connector began parsing it, even though scoring_rules did not yet have a column for it. Backfill
-- existing leagues so the first projection refresh after deployment can recover without waiting
-- for another provider sync.
WITH "yahoo_scopes" AS (
	SELECT DISTINCT ON ("league_seasons"."id", "rule"->>'statId')
		"league_seasons"."id" AS "league_season_id",
		"rule"->>'statId' AS "provider_stat_id",
		ARRAY(
			SELECT DISTINCT upper(btrim("position_type")) AS "position_type"
			FROM jsonb_array_elements_text("rule"->'positionTypes') AS "positions"("position_type")
			WHERE btrim("position_type") <> ''
			ORDER BY "position_type"
		) AS "position_types"
	FROM "league_seasons"
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE
			WHEN jsonb_typeof("league_seasons"."settings"->'scoringRules') = 'array'
				THEN "league_seasons"."settings"->'scoringRules'
			ELSE '[]'::jsonb
		END
	) AS "rules"("rule")
	WHERE "league_seasons"."provider" = 'yahoo'
		AND jsonb_typeof("rule"->'positionTypes') = 'array'
	ORDER BY "league_seasons"."id", "rule"->>'statId'
)
UPDATE "scoring_rules"
SET "position_types" = "yahoo_scopes"."position_types"
FROM "yahoo_scopes"
WHERE "scoring_rules"."league_season_id" = "yahoo_scopes"."league_season_id"
	AND "scoring_rules"."provider_stat_id" = "yahoo_scopes"."provider_stat_id"
	AND cardinality("yahoo_scopes"."position_types") > 0;
