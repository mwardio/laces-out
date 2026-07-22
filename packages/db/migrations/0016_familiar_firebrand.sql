CREATE TABLE "player_ros_projection_summaries" (
	"projection_set_id" uuid NOT NULL,
	"source_sync_run_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"window_start_week" integer NOT NULL,
	"window_end_week" integer NOT NULL,
	"as_of_week" integer NOT NULL,
	"as_of_at" timestamp with time zone NOT NULL,
	"scheduled_games" integer NOT NULL,
	"expected_games" numeric(8, 6) NOT NULL,
	"aggregate_mean_points" numeric(10, 3) NOT NULL,
	"p15_points" numeric(10, 3) NOT NULL,
	"p50_points" numeric(10, 3) NOT NULL,
	"p85_points" numeric(10, 3) NOT NULL,
	"mean_points_per_expected_game" numeric(12, 6),
	"points_stddev" numeric(10, 3) NOT NULL,
	"availability" jsonb NOT NULL,
	"scenario_count" integer NOT NULL,
	"method_version" text NOT NULL,
	"seed_hash" text NOT NULL,
	"input_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_ros_projection_summaries_projection_set_id_player_id_pk" PRIMARY KEY("projection_set_id","player_id"),
	CONSTRAINT "player_ros_projection_summaries_season_check" CHECK ("player_ros_projection_summaries"."season" between 2000 and 2200),
	CONSTRAINT "player_ros_projection_summaries_window_check" CHECK ("player_ros_projection_summaries"."window_start_week" between 1 and 25 and "player_ros_projection_summaries"."window_end_week" between "player_ros_projection_summaries"."window_start_week" and 25 and "player_ros_projection_summaries"."as_of_week" between 0 and 24 and "player_ros_projection_summaries"."as_of_week" < "player_ros_projection_summaries"."window_start_week" and "player_ros_projection_summaries"."as_of_at" >= '2000-01-01'::timestamptz),
	CONSTRAINT "player_ros_projection_summaries_games_check" CHECK ("player_ros_projection_summaries"."scheduled_games" between 0 and ("player_ros_projection_summaries"."window_end_week" - "player_ros_projection_summaries"."window_start_week" + 1) and "player_ros_projection_summaries"."expected_games" between 0 and "player_ros_projection_summaries"."scheduled_games"),
	CONSTRAINT "player_ros_projection_summaries_distribution_check" CHECK ("player_ros_projection_summaries"."aggregate_mean_points" between -2500 and 5000 and "player_ros_projection_summaries"."p15_points" between -2500 and "player_ros_projection_summaries"."p50_points" and "player_ros_projection_summaries"."p50_points" <= "player_ros_projection_summaries"."p85_points" and "player_ros_projection_summaries"."p85_points" <= 5000 and "player_ros_projection_summaries"."points_stddev" between 0 and 1000 and (("player_ros_projection_summaries"."expected_games" = 0 and "player_ros_projection_summaries"."aggregate_mean_points" = 0 and "player_ros_projection_summaries"."p15_points" = 0 and "player_ros_projection_summaries"."p50_points" = 0 and "player_ros_projection_summaries"."p85_points" = 0 and "player_ros_projection_summaries"."points_stddev" = 0 and "player_ros_projection_summaries"."mean_points_per_expected_game" is null) or ("player_ros_projection_summaries"."expected_games" > 0 and "player_ros_projection_summaries"."mean_points_per_expected_game" between -100 and 200 and abs(("player_ros_projection_summaries"."mean_points_per_expected_game" * "player_ros_projection_summaries"."expected_games") - "player_ros_projection_summaries"."aggregate_mean_points") <= 0.001))),
	CONSTRAINT "player_ros_projection_summaries_availability_check" CHECK (jsonb_typeof("player_ros_projection_summaries"."availability") = 'object' and "player_ros_projection_summaries"."availability"->'schemaVersion' = '1'::jsonb and "player_ros_projection_summaries"."availability"->>'semantics' = 'unconditional-active-probability' and jsonb_typeof("player_ros_projection_summaries"."availability"->'weeks') = 'array'),
	CONSTRAINT "player_ros_projection_summaries_scenarios_check" CHECK ("player_ros_projection_summaries"."scenario_count" between 128 and 4096),
	CONSTRAINT "player_ros_projection_summaries_identity_check" CHECK (char_length(btrim("player_ros_projection_summaries"."method_version")) between 1 and 128 and "player_ros_projection_summaries"."seed_hash" ~ '^[a-f0-9]{64}$' and "player_ros_projection_summaries"."input_checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "projection_model_runs" DROP CONSTRAINT "projection_model_runs_week_check";--> statement-breakpoint
ALTER TABLE "projection_model_runs" DROP CONSTRAINT "projection_model_runs_training_window_check";--> statement-breakpoint
ALTER TABLE "projection_sets" DROP CONSTRAINT "projection_sets_week_check";--> statement-breakpoint
DROP INDEX "projection_model_runs_target_checksum_unique";--> statement-breakpoint
DROP INDEX "projection_model_runs_target_created_idx";--> statement-breakpoint
ALTER TABLE "projection_model_runs" ALTER COLUMN "target_week" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "horizon" text DEFAULT 'week' NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "window_start_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "window_end_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "as_of_week" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "as_of_at" timestamp with time zone DEFAULT '-infinity'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_sets" ADD COLUMN "identity_state" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_sets" ADD COLUMN "window_start_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_sets" ADD COLUMN "window_end_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_sets" ADD COLUMN "as_of_week" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_sets" ADD COLUMN "as_of_at" timestamp with time zone DEFAULT '-infinity'::timestamptz NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "projection_model_runs"
    WHERE "trained_through_season" = "season"
      AND ("trained_through_week" IS NULL OR "trained_through_week" >= "target_week")
  ) THEN
    RAISE EXCEPTION 'cannot backfill weekly projection identity: same-season training cutoff reaches the target week';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "projection_model_runs" DISABLE TRIGGER "projection_model_runs_append_only_trigger";--> statement-breakpoint
UPDATE "projection_model_runs"
SET
	"horizon" = 'week',
	"window_start_week" = "target_week",
	"window_end_week" = "target_week",
	"as_of_week" = greatest("target_week" - 1, 0),
	"as_of_at" = "source_as_of"
WHERE "target_week" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ENABLE TRIGGER "projection_model_runs_append_only_trigger";--> statement-breakpoint
UPDATE "projection_sets"
SET
	"identity_state" = 'explicit',
	"window_start_week" = "week",
	"window_end_week" = "week",
	"as_of_week" = greatest("week" - 1, 0),
	"as_of_at" = "fetched_at"
WHERE "horizon" = 'week' AND "week" IS NOT NULL;--> statement-breakpoint
UPDATE "projection_sets"
SET
	"identity_state" = 'legacy-unknown',
	"window_start_week" = 0,
	"window_end_week" = 0,
	"as_of_week" = -1,
	"as_of_at" = '-infinity'::timestamptz
WHERE "horizon" IN ('rest-of-season', 'full-season') AND "week" IS NULL;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD CONSTRAINT "player_ros_projection_summaries_projection_set_id_projection_sets_id_fk" FOREIGN KEY ("projection_set_id") REFERENCES "public"."projection_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD CONSTRAINT "player_ros_projection_summaries_source_sync_run_id_projection_model_runs_source_sync_run_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."projection_model_runs"("source_sync_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_ros_projection_summaries" ADD CONSTRAINT "player_ros_projection_summaries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_ros_projection_summaries_identity_unique" ON "player_ros_projection_summaries" USING btree ("source_sync_run_id","projection_set_id","player_id","method_version","seed_hash","input_checksum");--> statement-breakpoint
CREATE INDEX "player_ros_projection_summaries_run_idx" ON "player_ros_projection_summaries" USING btree ("source_sync_run_id");--> statement-breakpoint
CREATE INDEX "player_ros_projection_summaries_player_window_idx" ON "player_ros_projection_summaries" USING btree ("player_id","season","window_start_week","window_end_week","as_of_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_sets_managed_window_input_unique" ON "projection_sets" USING btree ("league_season_id","source","season","horizon","identity_state","window_start_week","window_end_week","as_of_week","as_of_at","input_checksum") WHERE "projection_sets"."league_season_id" is not null and "projection_sets"."created_by_user_id" is null;--> statement-breakpoint
CREATE INDEX "projection_sets_scoped_window_idx" ON "projection_sets" USING btree ("league_season_id","season","horizon","identity_state","window_start_week","window_end_week","as_of_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_model_runs_target_checksum_unique" ON "projection_model_runs" USING btree ("source_id","season","horizon","window_start_week","window_end_week","as_of_week","as_of_at","model_version","input_checksum");--> statement-breakpoint
CREATE INDEX "projection_model_runs_target_created_idx" ON "projection_model_runs" USING btree ("season","horizon","window_start_week","window_end_week","as_of_at","created_at");--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_horizon_window_check" CHECK ("projection_model_runs"."horizon" in ('week', 'rest-of-season', 'full-season') and "projection_model_runs"."window_start_week" between 1 and 25 and "projection_model_runs"."window_end_week" between "projection_model_runs"."window_start_week" and 25 and "projection_model_runs"."as_of_week" between 0 and 24 and "projection_model_runs"."as_of_week" < "projection_model_runs"."window_start_week" and (("projection_model_runs"."horizon" = 'week' and "projection_model_runs"."target_week" is not null and "projection_model_runs"."target_week" = "projection_model_runs"."window_start_week" and "projection_model_runs"."target_week" = "projection_model_runs"."window_end_week") or ("projection_model_runs"."horizon" <> 'week' and "projection_model_runs"."target_week" is null)));--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_as_of_time_check" CHECK ("projection_model_runs"."as_of_at" >= '2000-01-01'::timestamptz and "projection_model_runs"."source_as_of" <= "projection_model_runs"."as_of_at");--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_training_window_check" CHECK ("projection_model_runs"."training_window_start_season" between 1999 and "projection_model_runs"."trained_through_season" and "projection_model_runs"."trained_through_season" <= "projection_model_runs"."season" and ("projection_model_runs"."trained_through_week" is null or "projection_model_runs"."trained_through_week" between 1 and 25) and ("projection_model_runs"."trained_through_season" < "projection_model_runs"."season" or ("projection_model_runs"."trained_through_season" = "projection_model_runs"."season" and "projection_model_runs"."trained_through_week" is not null and "projection_model_runs"."trained_through_week" <= "projection_model_runs"."as_of_week")));--> statement-breakpoint
ALTER TABLE "projection_sets" ADD CONSTRAINT "projection_sets_horizon_window_check" CHECK ("projection_sets"."horizon" in ('week', 'rest-of-season', 'full-season') and (("projection_sets"."identity_state" = 'explicit' and "projection_sets"."window_start_week" between 1 and 25 and "projection_sets"."window_end_week" between "projection_sets"."window_start_week" and 25 and "projection_sets"."as_of_week" between 0 and 24 and "projection_sets"."as_of_week" < "projection_sets"."window_start_week" and "projection_sets"."as_of_at" >= '2000-01-01'::timestamptz and "projection_sets"."as_of_at" <= "projection_sets"."fetched_at" + interval '5 minutes' and (("projection_sets"."horizon" = 'week' and "projection_sets"."week" is not null and "projection_sets"."window_start_week" = "projection_sets"."week" and "projection_sets"."window_end_week" = "projection_sets"."week") or ("projection_sets"."horizon" <> 'week' and "projection_sets"."week" is null))) or ("projection_sets"."identity_state" = 'legacy-unknown' and "projection_sets"."horizon" <> 'week' and "projection_sets"."week" is null and "projection_sets"."window_start_week" = 0 and "projection_sets"."window_end_week" = 0 and "projection_sets"."as_of_week" = -1 and "projection_sets"."as_of_at" = '-infinity'::timestamptz)));--> statement-breakpoint
ALTER TABLE "projection_sets" ADD CONSTRAINT "projection_sets_week_check" CHECK ("projection_sets"."week" is null or "projection_sets"."week" between 1 and 25);
--> statement-breakpoint
CREATE FUNCTION "normalize_weekly_projection_model_run_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.horizon = 'week' THEN
    IF NEW.target_week IS NULL THEN
      RAISE EXCEPTION 'weekly projection model runs require target_week';
    END IF;
    IF NEW.window_start_week = 0 THEN
      NEW.window_start_week := NEW.target_week;
    END IF;
    IF NEW.window_end_week = 0 THEN
      NEW.window_end_week := NEW.target_week;
    END IF;
    IF NEW.as_of_week = -1 THEN
      NEW.as_of_week := greatest(NEW.target_week - 1, 0);
    END IF;
    IF NEW.as_of_at = '-infinity'::timestamptz THEN
      NEW.as_of_at := NEW.source_as_of;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projection_model_runs_weekly_identity_trigger"
BEFORE INSERT ON "projection_model_runs"
FOR EACH ROW EXECUTE FUNCTION "normalize_weekly_projection_model_run_identity"();
--> statement-breakpoint
CREATE FUNCTION "normalize_weekly_projection_set_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_state = 'legacy-unknown' THEN
    RAISE EXCEPTION 'legacy-unknown projection identity is reserved for migration quarantine';
  END IF;
  IF NEW.horizon = 'week' THEN
    IF NEW.week IS NULL THEN
      RAISE EXCEPTION 'weekly projection sets require week';
    END IF;
    IF NEW.window_start_week = 0 THEN
      NEW.window_start_week := NEW.week;
    END IF;
    IF NEW.window_end_week = 0 THEN
      NEW.window_end_week := NEW.week;
    END IF;
    IF NEW.as_of_week = -1 THEN
      NEW.as_of_week := greatest(NEW.week - 1, 0);
    END IF;
    IF NEW.as_of_at = '-infinity'::timestamptz THEN
      NEW.as_of_at := NEW.fetched_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projection_sets_weekly_identity_trigger"
BEFORE INSERT ON "projection_sets"
FOR EACH ROW EXECUTE FUNCTION "normalize_weekly_projection_set_identity"();
--> statement-breakpoint
CREATE FUNCTION "enforce_player_ros_projection_scope"() RETURNS trigger
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
    OR (convergence_diagnostic->>'referenceScenarioCount')::integer > 4096
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
--> statement-breakpoint
CREATE TRIGGER "player_ros_projection_summaries_scope_trigger"
BEFORE INSERT ON "player_ros_projection_summaries"
FOR EACH ROW EXECUTE FUNCTION "enforce_player_ros_projection_scope"();
--> statement-breakpoint
CREATE FUNCTION "enforce_player_ros_summary_retention"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'player_ros_projection_summaries is append-only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "projection_sets" WHERE "id" = OLD.projection_set_id
  ) THEN
    RAISE EXCEPTION 'player_ros_projection_summaries is append-only';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "player_ros_projection_summaries_append_only_trigger"
BEFORE UPDATE OR DELETE ON "player_ros_projection_summaries"
FOR EACH ROW EXECUTE FUNCTION "enforce_player_ros_summary_retention"();
--> statement-breakpoint
CREATE FUNCTION "enforce_ros_projection_set_identity_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "player_ros_projection_summaries"
    WHERE "projection_set_id" = OLD.id
  ) AND (
    NEW.season IS DISTINCT FROM OLD.season
    OR NEW.horizon IS DISTINCT FROM OLD.horizon
    OR NEW.identity_state IS DISTINCT FROM OLD.identity_state
    OR NEW.week IS DISTINCT FROM OLD.week
    OR NEW.window_start_week IS DISTINCT FROM OLD.window_start_week
    OR NEW.window_end_week IS DISTINCT FROM OLD.window_end_week
    OR NEW.as_of_week IS DISTINCT FROM OLD.as_of_week
    OR NEW.as_of_at IS DISTINCT FROM OLD.as_of_at
    OR NEW.input_checksum IS DISTINCT FROM OLD.input_checksum
  ) THEN
    RAISE EXCEPTION 'projection sets with ROS summaries have immutable horizon identity';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projection_sets_ros_identity_immutable_trigger"
BEFORE UPDATE ON "projection_sets"
FOR EACH ROW EXECUTE FUNCTION "enforce_ros_projection_set_identity_immutable"();
