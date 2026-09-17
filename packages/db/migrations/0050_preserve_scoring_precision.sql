ALTER TABLE "scoring_rules" ALTER COLUMN "points" SET DATA TYPE numeric;
--> statement-breakpoint
-- The canonical imported settings retained the provider decimal before the old column rounded
-- it. Recover only unambiguous matches whose current value equals that exact old rounding;
-- preserve manual edits and unknown/duplicate provider rules.
WITH imported_rules AS (
  SELECT season.id AS league_season_id, rule->>'statId' AS provider_stat_id,
    CASE WHEN jsonb_typeof(rule->'points') = 'number'
      THEN (rule->>'points')::numeric END AS points
  FROM league_seasons season
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(season.settings->'scoringRules') = 'array'
      THEN season.settings->'scoringRules' ELSE '[]'::jsonb END
  ) AS rule
), unique_rules AS (
  SELECT league_season_id, provider_stat_id, min(points) AS points
  FROM imported_rules
  GROUP BY league_season_id, provider_stat_id
  HAVING count(*) = 1 AND count(points) = 1
)
UPDATE scoring_rules stored
SET points = imported.points
FROM unique_rules imported
WHERE stored.league_season_id = imported.league_season_id
  AND stored.provider_stat_id = imported.provider_stat_id
  AND stored.points = round(imported.points, 4)
  AND stored.points <> imported.points;
