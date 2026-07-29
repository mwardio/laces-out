-- Live ROS scenario-count contract (WP9 Task 9.0).
--
-- The engine's standard release projection simulates FIRST_PARTY_ROS_DEFAULT_SCENARIOS = 12288
-- paths and its deterministic convergence reference simulates
-- FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS = 16384, but this table, its BEFORE INSERT scope
-- trigger, and the worker's persistence-row builder all capped a live summary at 4096. The first
-- otherwise-releasable league projection would therefore have failed during persistence.
--
-- This migration widens the persisted contract to exactly the engine's admissible path range
-- (FIRST_PARTY_ROS_MINIMUM_SCENARIOS = 128 .. FIRST_PARTY_ROS_MAXIMUM_SCENARIOS = 16384) so a
-- 12288-path release persists with its 16384-path reference. It is forward-only and widening only:
-- no retained summary, model run, evaluation snapshot, or historical fact is rewritten or dropped,
-- and every row that satisfied the old bound still satisfies the new one. An out-of-contract count
-- (below 128, above 16384, a reference below its own release count, or a summary whose
-- scenario_count falls outside its own recorded diagnostic window) still fails closed.
--
-- `packages/db/src/schema.ts` derives the same bounds by importing the engine constants, and
-- `apps/worker/src/first-party-ros-scenario-contract.test.ts` asserts the literals below still
-- equal those constants, so this SQL cannot silently drift from the model.
ALTER TABLE "player_ros_projection_summaries" DROP CONSTRAINT "player_ros_projection_summaries_scenarios_check";--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD CONSTRAINT "player_ros_projection_summaries_scenarios_check" CHECK ("player_ros_projection_summaries"."scenario_count" between 128 and 16384);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_player_ros_projection_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  projection_set_record record;
  model_run_record record;
  player_projection_record record;
  interval_calibration jsonb;
  convergence_diagnostic jsonb;
  availability_week jsonb;
  availability_week_count integer;
  availability_unique_week_count integer;
  availability_scheduled_game_count integer;
  availability_expected_games numeric;
BEGIN
  SELECT
    "season", "horizon", "identity_state", "window_start_week", "window_end_week",
    "as_of_week", "as_of_at", "input_checksum"
  INTO projection_set_record
  FROM "projection_sets"
  WHERE "id" = NEW.projection_set_id;

  IF NOT FOUND OR projection_set_record.horizon <> 'rest-of-season'
    OR projection_set_record.identity_state <> 'explicit' THEN
    RAISE EXCEPTION 'ROS summary requires an explicit rest-of-season projection set';
  END IF;

  SELECT
    "season", "horizon", "window_start_week", "window_end_week", "as_of_week", "as_of_at",
    "quality_state", "model_version", "input_checksum", "source_as_of", "configuration",
    "calibration", "metrics"
  INTO model_run_record
  FROM "projection_model_runs"
  WHERE "source_sync_run_id" = NEW.source_sync_run_id;

  IF NOT FOUND OR model_run_record.horizon <> 'rest-of-season' THEN
    RAISE EXCEPTION 'ROS summary requires a rest-of-season model run';
  END IF;
  IF model_run_record.quality_state <> 'publishable' THEN
    RAISE EXCEPTION 'ROS summary requires a publishable model run';
  END IF;
  IF projection_set_record.season IS DISTINCT FROM model_run_record.season
    OR projection_set_record.window_start_week IS DISTINCT FROM model_run_record.window_start_week
    OR projection_set_record.window_end_week IS DISTINCT FROM model_run_record.window_end_week
    OR projection_set_record.as_of_week IS DISTINCT FROM model_run_record.as_of_week
    OR projection_set_record.as_of_at IS DISTINCT FROM model_run_record.as_of_at THEN
    RAISE EXCEPTION 'ROS projection set and model run identities do not match';
  END IF;
  IF projection_set_record.input_checksum IS DISTINCT FROM model_run_record.input_checksum
    OR NEW.input_checksum IS DISTINCT FROM model_run_record.input_checksum THEN
    RAISE EXCEPTION 'ROS summary, projection set, and model run checksums do not match';
  END IF;
  IF NEW.method_version IS DISTINCT FROM model_run_record.model_version THEN
    RAISE EXCEPTION 'ROS summary method version does not match its model run';
  END IF;
  IF model_run_record.configuration->>'simulationModelVersion'
      IS DISTINCT FROM model_run_record.model_version
    OR nullif(btrim(model_run_record.configuration->>'orchestrationVersion'), '') IS NULL THEN
    RAISE EXCEPTION 'ROS model run must separate its pure simulation and orchestration versions';
  END IF;
  IF model_run_record.source_as_of > model_run_record.as_of_at THEN
    RAISE EXCEPTION 'ROS model source timestamp is newer than its as-of identity';
  END IF;

  interval_calibration := model_run_record.calibration->'rosIntervals';
  IF jsonb_typeof(interval_calibration) IS DISTINCT FROM 'object'
    OR interval_calibration - 'schemaVersion' - 'state' - 'method' - 'evidenceChecksum'
      - 'heldOutSeasons' - 'batches' - 'samples' - 'nominalCoverage'
      - 'empiricalCoverage' - 'maximumAllowedCoverageError' <> '{}'::jsonb
    OR interval_calibration->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR interval_calibration->>'state' IS DISTINCT FROM 'calibrated'
    OR jsonb_typeof(interval_calibration->'method') IS DISTINCT FROM 'string'
    OR char_length(btrim(interval_calibration->>'method')) NOT BETWEEN 1 AND 128
    OR jsonb_typeof(interval_calibration->'evidenceChecksum') IS DISTINCT FROM 'string'
    OR interval_calibration->>'evidenceChecksum' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(interval_calibration->'heldOutSeasons') IS DISTINCT FROM 'number'
    OR jsonb_typeof(interval_calibration->'batches') IS DISTINCT FROM 'number'
    OR jsonb_typeof(interval_calibration->'samples') IS DISTINCT FROM 'number'
    OR interval_calibration->>'heldOutSeasons' !~ '^[0-9]+$'
    OR interval_calibration->>'batches' !~ '^[0-9]+$'
    OR interval_calibration->>'samples' !~ '^[0-9]+$'
    OR (interval_calibration->>'heldOutSeasons')::integer < 3
    OR (interval_calibration->>'batches')::integer < 30
    OR (interval_calibration->>'samples')::integer < 300
    OR jsonb_typeof(interval_calibration->'nominalCoverage') IS DISTINCT FROM 'number'
    OR jsonb_typeof(interval_calibration->'empiricalCoverage') IS DISTINCT FROM 'number'
    OR jsonb_typeof(interval_calibration->'maximumAllowedCoverageError') IS DISTINCT FROM 'number'
    OR (interval_calibration->>'nominalCoverage')::numeric NOT BETWEEN 0 AND 1
    OR (interval_calibration->>'empiricalCoverage')::numeric NOT BETWEEN 0 AND 1
    OR (interval_calibration->>'maximumAllowedCoverageError')::numeric NOT BETWEEN 0 AND 1
    OR abs(
      (interval_calibration->>'empiricalCoverage')::numeric
      - (interval_calibration->>'nominalCoverage')::numeric
    ) > (interval_calibration->>'maximumAllowedCoverageError')::numeric THEN
    RAISE EXCEPTION 'ROS summary requires derived held-out interval calibration evidence';
  END IF;

  convergence_diagnostic := model_run_record.metrics->'rosConvergence';
  IF jsonb_typeof(convergence_diagnostic) IS DISTINCT FROM 'object'
    OR convergence_diagnostic - 'schemaVersion' - 'state' - 'method' - 'evidenceChecksum'
      - 'lowerScenarioCount' - 'referenceScenarioCount' - 'maxToleranceRatio' <> '{}'::jsonb
    OR convergence_diagnostic->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR convergence_diagnostic->>'state' IS DISTINCT FROM 'converged'
    OR jsonb_typeof(convergence_diagnostic->'method') IS DISTINCT FROM 'string'
    OR char_length(btrim(convergence_diagnostic->>'method')) NOT BETWEEN 1 AND 128
    OR jsonb_typeof(convergence_diagnostic->'evidenceChecksum') IS DISTINCT FROM 'string'
    OR convergence_diagnostic->>'evidenceChecksum' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(convergence_diagnostic->'lowerScenarioCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(convergence_diagnostic->'referenceScenarioCount') IS DISTINCT FROM 'number'
    OR convergence_diagnostic->>'lowerScenarioCount' !~ '^[0-9]+$'
    OR convergence_diagnostic->>'referenceScenarioCount' !~ '^[0-9]+$'
    OR (convergence_diagnostic->>'lowerScenarioCount')::integer < 128
    OR (convergence_diagnostic->>'referenceScenarioCount')::integer
      < (convergence_diagnostic->>'lowerScenarioCount')::integer
    OR (convergence_diagnostic->>'referenceScenarioCount')::integer > 16384
    OR NEW.scenario_count NOT BETWEEN
      (convergence_diagnostic->>'lowerScenarioCount')::integer
      AND (convergence_diagnostic->>'referenceScenarioCount')::integer
    OR jsonb_typeof(convergence_diagnostic->'maxToleranceRatio') IS DISTINCT FROM 'number'
    OR (convergence_diagnostic->>'maxToleranceRatio')::numeric NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'ROS summary requires a passing deterministic convergence diagnostic';
  END IF;
  IF NEW.season IS DISTINCT FROM projection_set_record.season
    OR NEW.window_start_week IS DISTINCT FROM projection_set_record.window_start_week
    OR NEW.window_end_week IS DISTINCT FROM projection_set_record.window_end_week
    OR NEW.as_of_week IS DISTINCT FROM projection_set_record.as_of_week
    OR NEW.as_of_at IS DISTINCT FROM projection_set_record.as_of_at THEN
    RAISE EXCEPTION 'ROS summary identity does not match its projection set';
  END IF;

  IF jsonb_typeof(NEW.availability) IS DISTINCT FROM 'object'
    OR NEW.availability - 'schemaVersion' - 'semantics' - 'weeks' <> '{}'::jsonb
    OR NEW.availability->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR NEW.availability->>'semantics' IS DISTINCT FROM 'unconditional-active-probability'
    OR jsonb_typeof(NEW.availability->'weeks') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ROS availability must use the versioned unconditional probability schema';
  END IF;
  IF jsonb_array_length(NEW.availability->'weeks')
      <> NEW.window_end_week - NEW.window_start_week + 1 THEN
    RAISE EXCEPTION 'ROS availability must contain exactly one entry per window week';
  END IF;
  FOR availability_week IN
    SELECT value FROM jsonb_array_elements(NEW.availability->'weeks')
  LOOP
    IF jsonb_typeof(availability_week) IS DISTINCT FROM 'object'
      OR availability_week - 'week' - 'scheduled' - 'bye' - 'availabilityProbability'
        <> '{}'::jsonb
      OR jsonb_typeof(availability_week->'week') IS DISTINCT FROM 'number'
      OR availability_week->>'week' !~ '^[0-9]+$'
      OR (availability_week->>'week')::integer NOT BETWEEN NEW.window_start_week AND NEW.window_end_week
      OR jsonb_typeof(availability_week->'scheduled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(availability_week->'bye') IS DISTINCT FROM 'boolean'
      OR (availability_week->>'scheduled')::boolean = (availability_week->>'bye')::boolean
      OR jsonb_typeof(availability_week->'availabilityProbability') IS DISTINCT FROM 'number'
      OR (availability_week->>'availabilityProbability')::numeric NOT BETWEEN 0 AND 1
      OR (
        (availability_week->>'bye')::boolean
        AND (availability_week->>'availabilityProbability')::numeric <> 0
      ) THEN
      RAISE EXCEPTION 'ROS availability contains an invalid weekly entry';
    END IF;
  END LOOP;
  SELECT
    count(*),
    count(DISTINCT (value->>'week')::integer),
    count(*) FILTER (WHERE (value->>'scheduled')::boolean),
    coalesce(sum((value->>'availabilityProbability')::numeric), 0)
  INTO
    availability_week_count,
    availability_unique_week_count,
    availability_scheduled_game_count,
    availability_expected_games
  FROM jsonb_array_elements(NEW.availability->'weeks');
  IF availability_week_count <> NEW.window_end_week - NEW.window_start_week + 1
    OR availability_unique_week_count <> availability_week_count
    OR availability_scheduled_game_count <> NEW.scheduled_games
    OR abs(availability_expected_games - NEW.expected_games) > 0.00002 THEN
    RAISE EXCEPTION 'ROS availability does not reconcile to its window and expected games';
  END IF;

  SELECT "mean_points", "floor_points", "ceiling_points"
  INTO player_projection_record
  FROM "player_projections"
  WHERE "projection_set_id" = NEW.projection_set_id AND "player_id" = NEW.player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROS summary requires a player projection total';
  END IF;
  IF player_projection_record.floor_points IS NULL
    OR player_projection_record.ceiling_points IS NULL
    OR NEW.aggregate_mean_points IS DISTINCT FROM player_projection_record.mean_points
    OR NEW.p15_points IS DISTINCT FROM player_projection_record.floor_points
    OR NEW.p85_points IS DISTINCT FROM player_projection_record.ceiling_points THEN
    RAISE EXCEPTION 'ROS distribution totals do not match player projection mean/p15/p85';
  END IF;
  RETURN NEW;
END;
$$;
