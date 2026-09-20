ALTER TABLE "player_ros_projection_summaries" DROP CONSTRAINT "player_ros_projection_summaries_distribution_check";--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ALTER COLUMN "p15_points" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ALTER COLUMN "p50_points" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ALTER COLUMN "p85_points" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ALTER COLUMN "points_stddev" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD COLUMN "forecast_kind" text DEFAULT 'calibrated-distribution' NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD COLUMN "point_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "point_forecast_contract_version" integer;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD CONSTRAINT "player_ros_projection_summaries_distribution_check" CHECK ("player_ros_projection_summaries"."aggregate_mean_points" between -2500 and 5000 and (("player_ros_projection_summaries"."expected_games" = 0 and "player_ros_projection_summaries"."aggregate_mean_points" = 0 and "player_ros_projection_summaries"."mean_points_per_expected_game" is null) or ("player_ros_projection_summaries"."expected_games" > 0 and "player_ros_projection_summaries"."mean_points_per_expected_game" is not null and "player_ros_projection_summaries"."mean_points_per_expected_game" between -100 and 200 and abs(("player_ros_projection_summaries"."mean_points_per_expected_game" * "player_ros_projection_summaries"."expected_games") - "player_ros_projection_summaries"."aggregate_mean_points") <= 0.001)) and (("player_ros_projection_summaries"."forecast_kind" = 'point-only' and "player_ros_projection_summaries"."p15_points" is null and "player_ros_projection_summaries"."p50_points" is null and "player_ros_projection_summaries"."p85_points" is null and "player_ros_projection_summaries"."points_stddev" is null and "player_ros_projection_summaries"."interval_calibration" is null and "player_ros_projection_summaries"."point_evidence" is not null) or ("player_ros_projection_summaries"."forecast_kind" = 'calibrated-distribution' and "player_ros_projection_summaries"."point_evidence" is null and "player_ros_projection_summaries"."p15_points" is not null and "player_ros_projection_summaries"."p50_points" is not null and "player_ros_projection_summaries"."p85_points" is not null and "player_ros_projection_summaries"."points_stddev" is not null and "player_ros_projection_summaries"."p15_points" between -2500 and "player_ros_projection_summaries"."p50_points" and "player_ros_projection_summaries"."p50_points" <= "player_ros_projection_summaries"."p85_points" and "player_ros_projection_summaries"."p85_points" <= 5000 and "player_ros_projection_summaries"."points_stddev" between 0 and 1000 and ("player_ros_projection_summaries"."expected_games" > 0 or ("player_ros_projection_summaries"."p15_points" = 0 and "player_ros_projection_summaries"."p50_points" = 0 and "player_ros_projection_summaries"."p85_points" = 0 and "player_ros_projection_summaries"."points_stddev" = 0)))));--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_point_contract_check" CHECK ("projection_model_runs"."point_forecast_contract_version" is null or ("projection_model_runs"."point_forecast_contract_version" = 1 and "projection_model_runs"."marginal_interval_contract_version" is null));--> statement-breakpoint
-- Point forecasts have a separate admission, run stamp and player proof. This never admits
-- rejected v7/v8 uncertainty evidence, and leaves their existing validators unchanged.
CREATE FUNCTION ros_point_integer(value jsonb, minimum integer, maximum integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(value) = 'number' AND value #>> '{}' ~ '^[0-9]{1,7}$'
    AND (value #>> '{}')::numeric BETWEEN minimum AND maximum, false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_point_cell(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN ros_marginal_object(value,ARRAY['position','bucket','strategy','qualificationChecksum','releaseEvidenceChecksum'])
    AND coalesce(value->>'position' IN ('QB','RB','WR','TE','K','DST'),false)
    AND coalesce(value->>'bucket' IN ('one-to-four','five-to-eight','nine-plus'),false)
    AND coalesce(value->>'strategy' IN ('contextual','availability-aware-recency'),false)
    AND ros_marginal_digest(value->'qualificationChecksum')
    AND ros_marginal_digest(value->'releaseEvidenceChecksum');
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_point_convergence(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN ros_marginal_object(value,ARRAY['schemaVersion','state','method','evidenceChecksum','lowerScenarioCount','referenceScenarioCount','maxToleranceRatio'])
    AND value->'schemaVersion' = '1'::jsonb AND value->>'state' = 'converged'
    AND value->>'method' = 'live-bounded-ros-point-convergence-v1'
    AND ros_marginal_digest(value->'evidenceChecksum')
    AND value->'lowerScenarioCount' = '12288'::jsonb
    AND value->'referenceScenarioCount' = '16384'::jsonb
    AND ros_marginal_score(value->'maxToleranceRatio')
    AND (value->>'maxToleranceRatio')::numeric <= 1;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_point_envelope(value jsonb, admitted jsonb, policy jsonb, configuration jsonb, source_checksums jsonb, forecast_season integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  qualification jsonb; first_qualification jsonb; choice jsonb; cell jsonb; convergence jsonb;
  field text; strategy text; key text; seen text[] := ARRAY[]::text[]; released text[] := ARRAY[]::text[];
  matches integer;
BEGIN
  IF NOT ros_marginal_object(value,ARRAY['schemaVersion','method','state','championArtifactChecksum','scoringProfileKey','intervalAvailable','cells'])
    OR value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR value->>'method' IS DISTINCT FROM 'point-ros-release-v1'
    OR value->>'state' IS DISTINCT FROM 'validated'
    OR value->'intervalAvailable' IS DISTINCT FROM 'false'::jsonb
    OR NOT ros_marginal_digest(value->'championArtifactChecksum')
    OR value->'championArtifactChecksum' IS DISTINCT FROM configuration->'championArtifactChecksum'
    OR value->'scoringProfileKey' IS DISTINCT FROM configuration->'scoringProfileKey'
    OR jsonb_typeof(value->'scoringProfileKey') IS DISTINCT FROM 'string'
    OR char_length(value->>'scoringProfileKey') NOT BETWEEN 1 AND 65536
    OR jsonb_typeof(value->'cells') IS DISTINCT FROM 'array'
    OR value->'cells' IS DISTINCT FROM configuration->'releasingBuckets'
    OR NOT ros_marginal_object(admitted,ARRAY['schemaVersion','method','intervalAvailable','qualifications'])
    OR admitted->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR admitted->>'method' IS DISTINCT FROM 'point-ros-release-v1'
    OR admitted->'intervalAvailable' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(admitted->'qualifications') IS DISTINCT FROM 'array'
    OR policy->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-block-wis-cqr-v7'
    OR policy->'modelVersion' IS DISTINCT FROM configuration->'simulationModelVersion'
    OR policy->'evidenceIdentity'->'scoringProfileKey' IS DISTINCT FROM value->'scoringProfileKey'
    OR jsonb_typeof(policy->'choices') IS DISTINCT FROM 'array'
    OR jsonb_typeof(source_checksums) IS DISTINCT FROM 'array'
    OR NOT ros_marginal_integer(policy->'evidenceThroughSeason',2000,forecast_season-1)
    OR policy->'minimumHeldOutSeasons' IS DISTINCT FROM '3'::jsonb
    OR policy->'minimumBatches' IS DISTINCT FROM '30'::jsonb
    OR policy->'minimumSamples' IS DISTINCT FROM '300'::jsonb
    OR policy->'minimumCellSeasons' IS DISTINCT FROM '3'::jsonb
    OR policy->'minimumCellSamples' IS DISTINCT FROM '18'::jsonb
    OR policy->'minimumCellCutoffs' IS DISTINCT FROM '3'::jsonb
    OR policy->'minimumCellBatches' IS DISTINCT FROM '9'::jsonb
    OR policy->'minimumModelImprovement' IS DISTINCT FROM '0.01'::jsonb THEN RETURN false; END IF;
  IF jsonb_array_length(value->'cells') NOT BETWEEN 1 AND 18
    OR jsonb_array_length(admitted->'qualifications') <> 18
    OR jsonb_array_length(policy->'choices') <> 18 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(source_checksums) source
      WHERE NOT ros_marginal_object(source,ARRAY['key','checksum'])
        OR jsonb_typeof(source->'key') IS DISTINCT FROM 'string'
        OR char_length(source->>'key') NOT BETWEEN 1 AND 4096
        OR NOT ros_marginal_digest(source->'checksum'))
    OR (SELECT count(DISTINCT source->>'key') FROM jsonb_array_elements(source_checksums) source)
      <> jsonb_array_length(source_checksums) THEN RETURN false; END IF;
  first_qualification := admitted->'qualifications'->0;
  FOR qualification IN SELECT v FROM jsonb_array_elements(admitted->'qualifications') v LOOP
    IF NOT ros_marginal_object(qualification,ARRAY['schemaVersion','version','policyVersion','meanPolicyVersion','modelVersion','calibrationVersion','forecastSeason','scoringProfileKey','position','bucket','selectedStrategy','policyChecksum','candidateReportChecksum','sourceEvidenceChecksum','comparisonManifestChecksum','heldOutEvidenceChecksum','support','convergence','intervalAvailable','evidenceChecksum'])
      OR qualification->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR qualification->>'version' IS DISTINCT FROM 'point-ros-qualification-v1'
      OR qualification->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-only-v1'
      OR qualification->>'meanPolicyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-block-wis-cqr-v7'
      OR qualification->>'calibrationVersion' IS DISTINCT FROM 'unavailable-point-only-v1'
      OR qualification->'modelVersion' IS DISTINCT FROM configuration->'simulationModelVersion'
      OR qualification->'forecastSeason' IS DISTINCT FROM to_jsonb(forecast_season)
      OR qualification->'scoringProfileKey' IS DISTINCT FROM value->'scoringProfileKey'
      OR qualification->'intervalAvailable' IS DISTINCT FROM 'false'::jsonb
      OR coalesce(qualification->>'position' NOT IN ('QB','RB','WR','TE','K','DST'),true)
      OR coalesce(qualification->>'bucket' NOT IN ('one-to-four','five-to-eight','nine-plus'),true)
      OR coalesce(qualification->>'selectedStrategy' NOT IN ('contextual','availability-aware-recency'),true)
      OR NOT ros_marginal_object(qualification->'support',ARRAY['seasons','blocks','samples'])
      OR NOT ros_point_integer(qualification->'support'->'seasons',1,200)
      OR NOT ros_point_integer(qualification->'support'->'blocks',1,1000000)
      OR NOT ros_point_integer(qualification->'support'->'samples',1,1000000)
      OR NOT ros_marginal_object(qualification->'convergence',ARRAY['contextual','recency']) THEN RETURN false; END IF;
    key := qualification->>'position' || ':' || (qualification->>'bucket');
    IF key = ANY(seen) THEN RETURN false; END IF; seen := array_append(seen,key);
    FOREACH field IN ARRAY ARRAY['policyChecksum','candidateReportChecksum','sourceEvidenceChecksum','comparisonManifestChecksum','heldOutEvidenceChecksum','evidenceChecksum'] LOOP
      IF NOT ros_marginal_digest(qualification->field) THEN RETURN false; END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['policyChecksum','candidateReportChecksum','sourceEvidenceChecksum','comparisonManifestChecksum'] LOOP
      IF qualification->field IS DISTINCT FROM first_qualification->field THEN RETURN false; END IF;
    END LOOP;
    FOR field, key IN VALUES ('candidateReportChecksum','point-candidate-report'), ('sourceEvidenceChecksum','point-source-evidence'), ('comparisonManifestChecksum','point-comparison-manifest') LOOP
      SELECT count(*) INTO matches FROM jsonb_array_elements(source_checksums) source
        WHERE source->>'key' = key AND source->'checksum' = qualification->field;
      IF matches <> 1 THEN RETURN false; END IF;
    END LOOP;
    SELECT count(*) INTO matches FROM jsonb_array_elements(policy->'choices') candidate
      WHERE candidate->'position' = qualification->'position' AND candidate->'bucket' = qualification->'bucket';
    IF matches <> 1 THEN RETURN false; END IF;
    SELECT candidate INTO choice FROM jsonb_array_elements(policy->'choices') candidate
      WHERE candidate->'position' = qualification->'position' AND candidate->'bucket' = qualification->'bucket';
    IF qualification->'selectedStrategy' IS DISTINCT FROM choice->'strategy'
      OR qualification->'heldOutEvidenceChecksum' IS DISTINCT FROM choice->'heldOutEvidence'->'evidenceChecksum'
      OR qualification->'support' IS DISTINCT FROM jsonb_build_object('seasons',choice->'heldOutSeasons','blocks',choice->'batches','samples',choice->'samples') THEN RETURN false; END IF;
    FOREACH strategy IN ARRAY ARRAY['contextual','recency'] LOOP
      convergence := qualification->'convergence'->strategy;
      IF NOT ros_marginal_object(convergence,ARRAY['samples','converged','rate','evidenceChecksum'])
        OR convergence->'samples' IS DISTINCT FROM qualification->'support'->'seasons'
        OR NOT ros_marginal_integer(convergence->'samples',1,200)
        OR NOT ros_marginal_integer(convergence->'converged',0,(convergence->>'samples')::integer)
        OR NOT ros_marginal_score(convergence->'rate')
        OR (convergence->>'rate')::double precision IS DISTINCT FROM (convergence->>'converged')::double precision / (convergence->>'samples')::double precision
        OR NOT ros_marginal_digest(convergence->'evidenceChecksum') THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  FOR cell IN SELECT v FROM jsonb_array_elements(value->'cells') v LOOP
    IF NOT ros_point_cell(cell) THEN RETURN false; END IF;
    key := cell->>'position' || ':' || (cell->>'bucket');
    IF key = ANY(released) THEN RETURN false; END IF; released := array_append(released,key);
    SELECT q INTO qualification FROM jsonb_array_elements(admitted->'qualifications') q
      WHERE q->'position' = cell->'position' AND q->'bucket' = cell->'bucket';
    SELECT q INTO choice FROM jsonb_array_elements(policy->'choices') q
      WHERE q->'position' = cell->'position' AND q->'bucket' = cell->'bucket';
    strategy := CASE cell->>'strategy' WHEN 'contextual' THEN 'contextual' ELSE 'recency' END;
    IF qualification IS NULL OR choice IS NULL
      OR cell->'strategy' IS DISTINCT FROM qualification->'selectedStrategy'
      OR cell->'qualificationChecksum' IS DISTINCT FROM qualification->'evidenceChecksum'
      OR qualification->'convergence'->strategy->'rate' IS DISTINCT FROM '1'::jsonb
      OR NOT ros_marginal_integer(choice->'heldOutSeasons',3,200)
      OR NOT ros_point_integer(choice->'batches',9,1000000)
      OR NOT ros_point_integer(choice->'samples',18,1000000)
      OR NOT ros_marginal_integer(choice->'distinctCutoffs',3,25)
      OR NOT ros_marginal_integer(choice->'globalSeasons',3,200)
      OR NOT ros_point_integer(choice->'globalBatches',30,1000000)
      OR NOT ros_point_integer(choice->'globalSamples',300,1000000) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION enforce_ros_point_model_run_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE champion_record record; point_calibration jsonb;
BEGIN
  NEW.point_forecast_contract_version := NULL;
  point_calibration := NEW.calibration->'rosPoints';
  IF point_calibration IS NOT NULL
    OR NEW.configuration->>'policyVersion' = 'season-walk-forward-mean-only-v1'
    OR NEW.configuration->>'calibrationVersion' = 'unavailable-point-only-v1' THEN
    IF NEW.horizon IS DISTINCT FROM 'rest-of-season'
      OR NOT ((NEW.quality_state = 'publishable' AND NEW.configuration->>'mode' = 'release')
        OR (NEW.quality_state = 'degraded' AND NEW.configuration->>'mode' = 'release-evaluation' AND NEW.players_published = 0))
      OR NEW.configuration->>'mode' IS NULL
      OR NEW.configuration->>'simulationModelVersion' IS DISTINCT FROM NEW.model_version
      OR NEW.configuration->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-only-v1'
      OR NEW.configuration->>'calibrationVersion' IS DISTINCT FROM 'unavailable-point-only-v1'
      OR NOT ros_marginal_object(NEW.calibration,ARRAY['state','rosPoints'])
      OR NEW.calibration->>'state' IS DISTINCT FROM 'unavailable'
      OR NEW.marginal_interval_contract_version IS NOT NULL
      OR NOT coalesce(ros_point_convergence(NEW.metrics->'rosPointConvergence'),false)
      OR NEW.metrics ? 'rosConvergence' THEN
      RAISE EXCEPTION 'ROS point model run requires distinct admitted point evidence and convergence';
    END IF;
    SELECT * INTO champion_record FROM first_party_ros_champion_artifacts
    WHERE artifact_checksum = point_calibration->>'championArtifactChecksum'
      AND season = NEW.season AND model_version = NEW.model_version
      AND policy_version = NEW.configuration->>'policyVersion'
      AND calibration_version = NEW.configuration->>'calibrationVersion'
      AND scoring_profile_key = NEW.configuration->>'scoringProfileKey';
    IF NOT FOUND OR champion_record.evidence_through_season >= champion_record.season
      OR champion_record.policy->'evidenceThroughSeason' IS DISTINCT FROM to_jsonb(champion_record.evidence_through_season)
      OR NOT ros_point_envelope(point_calibration,champion_record.release_gate->'pointForecasts',champion_record.policy,NEW.configuration,champion_record.source_checksums,NEW.season) THEN
      RAISE EXCEPTION 'ROS point model run requires matching immutable point qualifications';
    END IF;
    IF NEW.quality_state = 'publishable' THEN NEW.point_forecast_contract_version := 1; END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER projection_model_runs_point_contract_trigger
BEFORE INSERT ON projection_model_runs
FOR EACH ROW EXECUTE FUNCTION enforce_ros_point_model_run_contract();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_player_ros_projection_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  released_cell jsonb;
  matched_cells integer;
  row_bucket text;
  projection_set_record record;
  model_run_record record;
  player_projection_record record;
  interval_calibration jsonb;
  point_calibration jsonb;
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
    "calibration", "metrics", "marginal_interval_contract_version", "point_forecast_contract_version"
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

  IF NEW.forecast_kind = 'point-only' THEN
    point_calibration := model_run_record.calibration->'rosPoints';
    IF model_run_record.point_forecast_contract_version IS DISTINCT FROM 1
      OR model_run_record.marginal_interval_contract_version IS NOT NULL
      OR NEW.window_end_week > 18
      OR NEW.interval_calibration IS NOT NULL
      OR NOT ros_marginal_object(NEW.point_evidence,ARRAY['schemaVersion','position','bucket','strategy','qualificationChecksum','releaseEvidenceChecksum'])
      OR NEW.point_evidence->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR NOT ros_point_cell(NEW.point_evidence - 'schemaVersion') THEN
      RAISE EXCEPTION 'ROS point summary requires a DB-validated point run and point cell proof';
    END IF;
    row_bucket := CASE WHEN NEW.window_end_week - NEW.window_start_week + 1 <= 4 THEN 'one-to-four'
      WHEN NEW.window_end_week - NEW.window_start_week + 1 <= 8 THEN 'five-to-eight' ELSE 'nine-plus' END;
    IF NEW.point_evidence->>'bucket' IS DISTINCT FROM row_bucket THEN
      RAISE EXCEPTION 'ROS point summary bucket does not match its forecast window';
    END IF;
    SELECT count(*) INTO matched_cells FROM jsonb_array_elements(point_calibration->'cells') cell
      WHERE cell = NEW.point_evidence - 'schemaVersion';
    IF matched_cells <> 1 THEN RAISE EXCEPTION 'ROS point player proof does not match a released cell'; END IF;
    convergence_diagnostic := model_run_record.metrics->'rosPointConvergence';
    IF NOT coalesce(ros_point_convergence(convergence_diagnostic),false) THEN
      RAISE EXCEPTION 'ROS point summary requires passing point convergence';
    END IF;
  ELSE
    IF NEW.forecast_kind IS DISTINCT FROM 'calibrated-distribution' OR NEW.point_evidence IS NOT NULL
      OR model_run_record.point_forecast_contract_version IS NOT NULL THEN
      RAISE EXCEPTION 'Distribution ROS summaries cannot claim point-only evidence';
    END IF;
  interval_calibration := model_run_record.calibration->'rosIntervals';
  IF interval_calibration->'schemaVersion' = '2'::jsonb THEN
    IF NEW.window_end_week > 18 OR model_run_record.configuration->>'mode' IS DISTINCT FROM 'release'
      OR model_run_record.configuration->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-marginal-quantiles-v8'
      OR model_run_record.configuration->>'calibrationVersion' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
      OR interval_calibration->'forecastSeason' IS DISTINCT FROM to_jsonb(model_run_record.season) THEN
      RAISE EXCEPTION 'ROS marginal model run lineage is invalid';
    END IF;
    IF model_run_record.marginal_interval_contract_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'ROS marginal summary requires a DB-validated immutable model run';
    END IF;
    row_bucket := CASE WHEN NEW.window_end_week - NEW.window_start_week + 1 <= 4 THEN 'one-to-four'
      WHEN NEW.window_end_week - NEW.window_start_week + 1 <= 8 THEN 'five-to-eight' ELSE 'nine-plus' END;
    IF NOT ros_marginal_object(NEW.interval_calibration,ARRAY['schemaVersion','position','bucket','strategy','qualificationChecksum','calibrationArtifactChecksum','releaseEvidenceChecksum'])
      OR NEW.interval_calibration->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR NEW.interval_calibration->>'bucket' IS DISTINCT FROM row_bucket
      OR NEW.interval_calibration->'releaseEvidenceChecksum' IS DISTINCT FROM interval_calibration->'evidenceChecksum' THEN
      RAISE EXCEPTION 'ROS marginal player interval metadata is invalid';
    END IF;
    SELECT count(*) INTO matched_cells FROM jsonb_array_elements(interval_calibration->'cells') cell
      WHERE cell->'cell'->'position' = NEW.interval_calibration->'position'
        AND cell->'cell'->'bucket' = NEW.interval_calibration->'bucket';
    IF matched_cells <> 1 THEN RAISE EXCEPTION 'ROS marginal player cell is not released'; END IF;
    SELECT cell INTO released_cell FROM jsonb_array_elements(interval_calibration->'cells') cell
      WHERE cell->'cell'->'position' = NEW.interval_calibration->'position'
        AND cell->'cell'->'bucket' = NEW.interval_calibration->'bucket';
    IF NEW.interval_calibration->'strategy' IS DISTINCT FROM released_cell->'strategy'
      OR NEW.interval_calibration->'qualificationChecksum' IS DISTINCT FROM released_cell->'qualificationChecksum'
      OR NEW.interval_calibration->'calibrationArtifactChecksum' IS DISTINCT FROM released_cell->'artifactChecksum' THEN
      RAISE EXCEPTION 'ROS marginal player artifact binding does not match its released cell';
    END IF;
  ELSE
    IF NEW.interval_calibration IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy ROS summaries cannot claim marginal interval metadata';
    END IF;
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
  END IF;

    convergence_diagnostic := model_run_record.metrics->'rosConvergence';
  END IF;
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
  IF NEW.forecast_kind = 'point-only' THEN
    IF player_projection_record.floor_points IS NOT NULL OR player_projection_record.ceiling_points IS NOT NULL
      OR NEW.aggregate_mean_points IS DISTINCT FROM player_projection_record.mean_points THEN
      RAISE EXCEPTION 'ROS point totals require matching means and unavailable bounds';
    END IF;
  ELSIF player_projection_record.floor_points IS NULL
    OR player_projection_record.ceiling_points IS NULL
    OR NEW.aggregate_mean_points IS DISTINCT FROM player_projection_record.mean_points
    OR NEW.p15_points IS DISTINCT FROM player_projection_record.floor_points
    OR NEW.p85_points IS DISTINCT FROM player_projection_record.ceiling_points THEN
    RAISE EXCEPTION 'ROS distribution totals do not match player projection mean/p15/p85';
  END IF;
  RETURN NEW;
END;
$$;
