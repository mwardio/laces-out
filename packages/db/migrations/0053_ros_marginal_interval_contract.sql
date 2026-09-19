ALTER TABLE "player_ros_projection_summaries" ADD COLUMN "interval_calibration" jsonb;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD COLUMN "marginal_interval_contract_version" integer;--> statement-breakpoint
ALTER TABLE "projection_model_runs" ADD CONSTRAINT "projection_model_runs_marginal_contract_check" CHECK ("projection_model_runs"."marginal_interval_contract_version" is null or "projection_model_runs"."marginal_interval_contract_version" = 2);
--> statement-breakpoint
-- Forward-only schema2 interval branch. All legacy numeric/scope guards remain below.
-- SHA bindings are checked against the immutable admitted payload. PostgreSQL must not
-- attempt to reproduce JavaScript's canonical floating-point JSON serialization.
CREATE FUNCTION ros_marginal_object(value jsonb, keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(value) = 'object' AND value ?& keys
    AND (SELECT count(*) FROM jsonb_object_keys(value)) = cardinality(keys), false)
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_digest(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^[a-f0-9]{64}$', false)
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_integer(value jsonb, minimum integer, maximum integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(value) = 'number' AND value #>> '{}' ~ '^[0-9]{1,5}$'
    AND (value #>> '{}')::numeric BETWEEN minimum AND maximum, false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_score(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(value) = 'number' AND char_length(value::text) <= 640
    AND (value #>> '{}')::numeric BETWEEN 0 AND 1.7976931348623157e308::numeric, false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_fraction(value jsonb, denominator_bound numeric) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n numeric; d numeric;
BEGIN
  IF NOT ros_marginal_object(value, ARRAY['numerator','denominator'])
    OR jsonb_typeof(value->'numerator') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'denominator') IS DISTINCT FROM 'string'
    OR char_length(value->>'numerator') NOT BETWEEN 1 AND 4096
    OR char_length(value->>'denominator') NOT BETWEEN 1 AND 4096
    OR value->>'numerator' !~ '^(0|[1-9][0-9]*)$'
    OR value->>'denominator' !~ '^[1-9][0-9]*$'
    OR char_length(value->>'denominator') > char_length(denominator_bound::text) THEN RETURN false; END IF;
  n := (value->>'numerator')::numeric; d := (value->>'denominator')::numeric;
  RETURN n <= d AND d <= denominator_bound AND gcd(n,d) = 1;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_cell(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  source_year jsonb; annual jsonb; cutoff jsonb; field text; fraction_value jsonb;
  years_count integer; year_index integer := 0; prior_year integer := 1999;
  prior_cutoff integer; rows_count integer := 0; cutoffs_count integer;
  n numeric; d numeric; sum_n numeric; sum_d numeric; divisor numeric; denominator_bound numeric;
  aggregate_n numeric[] := ARRAY[0::numeric,0::numeric,0::numeric];
  aggregate_d numeric[] := ARRAY[1::numeric,1::numeric,1::numeric];
  metric_index integer;
BEGIN
  IF NOT ros_marginal_object(value, ARRAY['cell','strategy','forecastSeason','scoringProfileKey','sourceSeasons','requiredEvaluationSeasons','comparisonSeason','annualSupport','aggregate','candidateWis','benchmarkWis','qualificationChecksum','artifactChecksum','evidenceChecksum','comparisonChecksum','meanChoiceChecksum','sourceScopeChecksum','sourceBindingsChecksum','linkageChecksum','comparisonCohortChecksum','fullReportChecksum','protocolChecksum','sourceManifestChecksum','cellChecksum'])
    OR NOT ros_marginal_object(value->'cell', ARRAY['position','bucket'])
    OR coalesce(value->'cell'->>'position' NOT IN ('QB','RB','WR','TE','K','DST'),true)
    OR coalesce(value->'cell'->>'bucket' NOT IN ('one-to-four','five-to-eight','nine-plus'),true)
    OR coalesce(value->>'strategy' NOT IN ('contextual','availability-aware-recency'),true)
    OR NOT ros_marginal_integer(value->'forecastSeason',2000,2200)
    OR jsonb_typeof(value->'scoringProfileKey') IS DISTINCT FROM 'string'
    OR char_length(btrim(value->>'scoringProfileKey')) NOT BETWEEN 1 AND 65536
    OR jsonb_typeof(value->'sourceSeasons') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'requiredEvaluationSeasons') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'annualSupport') IS DISTINCT FROM 'array'
    OR NOT ros_marginal_object(value->'aggregate',ARRAY['coverage','lowerTail','upperTail'])
    OR NOT ros_marginal_object(value->'benchmarkWis',ARRAY['same-physics-legacy','previous-deployed'])
    OR NOT ros_marginal_score(value->'candidateWis')
    OR NOT ros_marginal_score(value->'benchmarkWis'->'same-physics-legacy')
    OR NOT ros_marginal_score(value->'benchmarkWis'->'previous-deployed') THEN RETURN false; END IF;
  years_count := jsonb_array_length(value->'sourceSeasons');
  IF years_count NOT BETWEEN 4 AND 201
    OR jsonb_array_length(value->'requiredEvaluationSeasons') <> years_count - 1
    OR jsonb_array_length(value->'annualSupport') <> years_count - 1 THEN RETURN false; END IF;
  FOR source_year IN SELECT v FROM jsonb_array_elements(value->'sourceSeasons') v LOOP
    IF NOT ros_marginal_integer(source_year,prior_year+1,2200) THEN RETURN false; END IF;
    prior_year := (source_year #>> '{}')::integer;
    IF year_index > 0 AND source_year IS DISTINCT FROM value->'requiredEvaluationSeasons'->(year_index-1) THEN RETURN false; END IF;
    year_index := year_index + 1;
  END LOOP;
  IF value->'comparisonSeason' IS DISTINCT FROM to_jsonb(prior_year)
    OR (value->>'forecastSeason')::integer <= prior_year THEN RETURN false; END IF;
  year_index := 0;
  FOR annual IN SELECT v FROM jsonb_array_elements(value->'annualSupport') v LOOP
    IF NOT ros_marginal_object(annual,ARRAY['forecastSeason','samples','cutoffs','coverage','lowerTail','upperTail'])
      OR annual->'forecastSeason' IS DISTINCT FROM value->'requiredEvaluationSeasons'->year_index
      OR NOT ros_marginal_integer(annual->'samples',18,20000)
      OR jsonb_typeof(annual->'cutoffs') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    cutoffs_count := jsonb_array_length(annual->'cutoffs');
    IF cutoffs_count NOT BETWEEN 3 AND 17 THEN RETURN false; END IF;
    prior_cutoff := 0;
    FOR cutoff IN SELECT v FROM jsonb_array_elements(annual->'cutoffs') v LOOP
      IF NOT ros_marginal_integer(cutoff,prior_cutoff+1,17) THEN RETURN false; END IF;
      prior_cutoff := (cutoff #>> '{}')::integer;
    END LOOP;
    rows_count := rows_count + (annual->>'samples')::integer;
    IF rows_count > 20000 THEN RETURN false; END IF;
    denominator_bound := cutoffs_count * power((annual->>'samples')::numeric,cutoffs_count);
    sum_n := 0; sum_d := 1; metric_index := 1;
    FOREACH field IN ARRAY ARRAY['coverage','lowerTail','upperTail'] LOOP
      fraction_value := annual->field;
      IF NOT ros_marginal_fraction(fraction_value,denominator_bound) THEN RETURN false; END IF;
      n := (fraction_value->>'numerator')::numeric; d := (fraction_value->>'denominator')::numeric;
      sum_n := sum_n*d+n*sum_d; sum_d := sum_d*d;
      divisor := gcd(sum_n,sum_d); sum_n := sum_n/divisor; sum_d := sum_d/divisor;
      aggregate_n[metric_index] := aggregate_n[metric_index]*d+n*aggregate_d[metric_index];
      aggregate_d[metric_index] := aggregate_d[metric_index]*d;
      divisor := gcd(aggregate_n[metric_index],aggregate_d[metric_index]);
      aggregate_n[metric_index] := aggregate_n[metric_index]/divisor;
      aggregate_d[metric_index] := aggregate_d[metric_index]/divisor;
      metric_index := metric_index+1;
    END LOOP;
    IF sum_n <> sum_d THEN RETURN false; END IF;
    year_index := year_index+1;
  END LOOP;
  metric_index := 1;
  FOREACH field IN ARRAY ARRAY['coverage','lowerTail','upperTail'] LOOP
    fraction_value := value->'aggregate'->field;
    IF NOT ros_marginal_fraction(fraction_value,power(10::numeric,4096)-1) THEN RETURN false; END IF;
    n := (fraction_value->>'numerator')::numeric; d := (fraction_value->>'denominator')::numeric;
    IF n * aggregate_d[metric_index] * (years_count-1) <> aggregate_n[metric_index]*d
      OR (field = 'coverage' AND n*5 < d*3)
      OR (field <> 'coverage' AND n*4 > d) THEN RETURN false; END IF;
    metric_index := metric_index+1;
  END LOOP;
  IF (value->>'candidateWis')::numeric > (value->'benchmarkWis'->>'same-physics-legacy')::numeric
    OR (value->>'candidateWis')::numeric > (value->'benchmarkWis'->>'previous-deployed')::numeric THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['qualificationChecksum','artifactChecksum','evidenceChecksum','comparisonChecksum','meanChoiceChecksum','sourceScopeChecksum','sourceBindingsChecksum','linkageChecksum','comparisonCohortChecksum','fullReportChecksum','protocolChecksum','sourceManifestChecksum','cellChecksum'] LOOP
    IF NOT ros_marginal_digest(value->field) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_fit(value jsonb, context jsonb, forecast_season jsonb, prior_seasons jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE fit jsonb; correction jsonb; prior jsonb; prior_year integer := 1999;
BEGIN
  IF NOT ros_marginal_object(value,ARRAY['schemaVersion','artifactVersion','calibrationVersion','context','fit','evidenceChecksum','artifactChecksum'])
    OR value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR value->>'artifactVersion' IS DISTINCT FROM 'ros-marginal-interval-artifact-v1'
    OR value->>'calibrationVersion' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
    OR value->'context' IS DISTINCT FROM context
    OR NOT ros_marginal_object(context,ARRAY['strategy','position','bucket','evidenceIdentity'])
    OR NOT ros_marginal_object(context->'evidenceIdentity',ARRAY['contextualModelVersion','recencyModelVersion','scoringProfileKey','intervalMethodVersion'])
    OR NOT ros_marginal_digest(value->'evidenceChecksum') OR NOT ros_marginal_digest(value->'artifactChecksum') THEN RETURN false; END IF;
  fit := value->'fit';
  IF NOT ros_marginal_object(fit,ARRAY['version','target','nominalCoverage','quantiles','weighting','scale','seriesKey','forecastSeason','priorSeasons','samples','blocks','distinctCutoffs','state','corrections'])
    OR fit->>'version' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
    OR fit->>'target' IS DISTINCT FROM 'individual-player-marginal-quantiles'
    OR fit->'nominalCoverage' IS DISTINCT FROM '0.7'::jsonb
    OR fit->'quantiles' IS DISTINCT FROM '[0.15,0.5,0.85]'::jsonb
    OR fit->>'weighting' IS DISTINCT FROM 'equal-season-equal-cutoff-equal-player'
    OR fit->>'scale' IS DISTINCT FROM 'scheduled-games'
    OR jsonb_typeof(fit->'seriesKey') IS DISTINCT FROM 'string'
    OR fit->>'seriesKey' !~ '^ros-marginal:[a-f0-9]{64}$'
    OR fit->'forecastSeason' IS DISTINCT FROM forecast_season
    OR NOT ros_marginal_integer(forecast_season,2000,2200)
    OR fit->'priorSeasons' IS DISTINCT FROM prior_seasons
    OR jsonb_typeof(prior_seasons) IS DISTINCT FROM 'array'
    OR fit->>'state' IS DISTINCT FROM 'fitted'
    OR NOT ros_marginal_integer(fit->'samples',18,20000)
    OR NOT ros_marginal_integer(fit->'blocks',3,3618)
    OR NOT ros_marginal_integer(fit->'distinctCutoffs',3,17)
    OR jsonb_typeof(fit->'corrections') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(prior_seasons) NOT BETWEEN 1 AND 201 OR jsonb_array_length(fit->'corrections') <> 3
    OR (fit->>'blocks')::integer > (fit->>'samples')::integer
    OR (fit->>'blocks')::integer > 18 * jsonb_array_length(prior_seasons) THEN RETURN false; END IF;
  FOR prior IN SELECT v FROM jsonb_array_elements(prior_seasons) v LOOP
    IF NOT ros_marginal_integer(prior,prior_year+1,(forecast_season #>> '{}')::integer-1) THEN RETURN false; END IF;
    prior_year := (prior #>> '{}')::integer;
  END LOOP;
  FOR correction IN SELECT v FROM jsonb_array_elements(fit->'corrections') v LOOP
    IF jsonb_typeof(correction) IS DISTINCT FROM 'number' OR char_length(correction::text)>640
      OR NOT ros_marginal_score(to_jsonb(abs((correction #>> '{}')::numeric))) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE FUNCTION ros_marginal_envelope(value jsonb, admitted jsonb, policy jsonb, configuration jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cell jsonb; qualification jsonb; scoped jsonb; annual jsonb; measured jsonb;
  fitted jsonb; bucket_configuration jsonb; first_cell jsonb; first_qualification jsonb;
  historical jsonb; prefix_years jsonb; block jsonb; link jsonb; block_index integer; support_count integer; support_rows integer; support_cutoffs integer;
  field text; key text; seen text[] := ARRAY[]::text[]; qualified_keys text[] := ARRAY[]::text[];
  compact_keys text[] := ARRAY[]::text[]; scope_keys text[]; previous_key text := '';
  cell_index integer := 0; annual_index integer; matches integer;
  expected_keys constant text[] := ARRAY['DST:five-to-eight','DST:nine-plus','DST:one-to-four','K:five-to-eight','K:nine-plus','K:one-to-four','QB:five-to-eight','QB:nine-plus','QB:one-to-four','RB:five-to-eight','RB:nine-plus','RB:one-to-four','TE:five-to-eight','TE:nine-plus','TE:one-to-four','WR:five-to-eight','WR:nine-plus','WR:one-to-four'];
BEGIN
  IF NOT ros_marginal_object(value,ARRAY['schemaVersion','version','method','qualificationMethod','target','quantiles','nominalCoverage','interpretation','championArtifactChecksum','forecastSeason','scoringProfileKey','releasedCells','cells','evidenceChecksum'])
    OR value->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR value->>'version' IS DISTINCT FROM 'ros-marginal-interval-storage-v1'
    OR value->>'method' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
    OR value->>'qualificationMethod' IS DISTINCT FROM 'ros-marginal-interval-qualification-v1'
    OR value->>'target' IS DISTINCT FROM 'individual-player-marginal-quantiles'
    OR value->'quantiles' IS DISTINCT FROM '[0.15,0.5,0.85]'::jsonb
    OR value->'nominalCoverage' IS DISTINCT FROM '0.7'::jsonb
    OR value->>'interpretation' IS DISTINCT FROM 'historical-descriptive'
    OR NOT ros_marginal_digest(value->'championArtifactChecksum')
    OR NOT ros_marginal_digest(value->'evidenceChecksum')
    OR NOT ros_marginal_integer(value->'forecastSeason',2000,2200)
    OR value->'scoringProfileKey' IS DISTINCT FROM configuration->'scoringProfileKey'
    OR value->'championArtifactChecksum' IS DISTINCT FROM configuration->'championArtifactChecksum'
    OR jsonb_typeof(value->'releasedCells') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'cells') IS DISTINCT FROM 'array'
    OR NOT ros_marginal_object(admitted,ARRAY['schemaVersion','qualificationMethod','qualifications','cells'])
    OR admitted->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR admitted->>'qualificationMethod' IS DISTINCT FROM 'ros-marginal-interval-qualification-v1'
    OR jsonb_typeof(admitted->'qualifications') IS DISTINCT FROM 'array'
    OR jsonb_typeof(admitted->'cells') IS DISTINCT FROM 'array'
    OR jsonb_typeof(configuration->'releasingBuckets') IS DISTINCT FROM 'array'
    OR policy->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-block-wis-cqr-v7'
    OR policy->'modelVersion' IS DISTINCT FROM configuration->'simulationModelVersion'
    OR jsonb_typeof(policy->'choices') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'cells') NOT BETWEEN 1 AND 18
    OR jsonb_array_length(value->'releasedCells') <> jsonb_array_length(value->'cells')
    OR jsonb_array_length(configuration->'releasingBuckets') <> jsonb_array_length(value->'cells')
    OR jsonb_array_length(policy->'choices') <> 18
    OR jsonb_array_length(admitted->'qualifications') <> 18
    OR jsonb_array_length(admitted->'cells') > 18 THEN RETURN false; END IF;
  first_qualification := admitted->'qualifications'->0;
  FOR qualification IN SELECT v FROM jsonb_array_elements(admitted->'qualifications') v LOOP
    IF NOT ros_marginal_object(qualification,ARRAY['schemaVersion','qualificationMethod','state','interpretation','canAuthorizeRelease','scope','cell','forecastSeason','requiredEvaluationSeasons','comparisonSeason','strategy','previousStrategy','meanSelectorPolicyVersion','meanSelectorOptions','meanChoice','previousMeanChoice','sourceScope','sources','intervalTraining','liveArtifact','historicalArtifacts','evidence','comparison','linkage','reasons','qualificationChecksum'])
      OR qualification->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR qualification->>'qualificationMethod' IS DISTINCT FROM 'ros-marginal-interval-qualification-v1'
      OR qualification->>'interpretation' IS DISTINCT FROM 'historical-descriptive'
      OR qualification->'canAuthorizeRelease' IS DISTINCT FROM 'false'::jsonb
      OR qualification->>'scope' IS DISTINCT FROM 'final-live-fixed-strategy-cell'
      OR qualification->'forecastSeason' IS DISTINCT FROM value->'forecastSeason'
      OR qualification->'sources'->'candidate'->'source'->'modelVersion' IS DISTINCT FROM configuration->'simulationModelVersion'
      OR qualification->'sources'->'candidate'->'source'->'scoringProfileKey' IS DISTINCT FROM value->'scoringProfileKey'
      OR qualification->>'meanSelectorPolicyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-block-wis-cqr-v7'
      OR qualification->'meanSelectorOptions' IS DISTINCT FROM '{"minimumHeldOutSeasons":3,"minimumBatches":30,"minimumSamples":300,"minimumCellSeasons":3,"minimumCellSamples":18,"minimumCellCutoffs":3,"minimumCellBatches":9,"minimumModelImprovement":0.01}'::jsonb
      OR NOT ros_marginal_object(qualification->'cell',ARRAY['position','bucket'])
      OR coalesce(qualification->>'strategy' NOT IN ('contextual','availability-aware-recency'),true)
      OR NOT ros_marginal_digest(qualification->'qualificationChecksum')
      OR jsonb_typeof(qualification->'reasons') IS DISTINCT FROM 'array'
      OR NOT ros_marginal_object(qualification->'sourceScope',ARRAY['sourceSeasons','requiredCells','protocolChecksum','sourceManifestChecksum','fullReportChecksum','identityAmendment'])
      OR qualification->'sourceScope' IS DISTINCT FROM first_qualification->'sourceScope'
      OR qualification->'sources' IS DISTINCT FROM first_qualification->'sources'
      OR jsonb_typeof(qualification->'sourceScope'->'requiredCells') IS DISTINCT FROM 'array'
      OR jsonb_typeof(qualification->'requiredEvaluationSeasons') IS DISTINCT FROM 'array'
      OR jsonb_typeof(qualification->'historicalArtifacts') IS DISTINCT FROM 'array'
      OR jsonb_typeof(qualification->'evidence'->'perSeason') IS DISTINCT FROM 'array'
      OR jsonb_typeof(qualification->'linkage') IS DISTINCT FROM 'array'
      OR NOT ros_marginal_object(qualification->'evidence',ARRAY['schemaVersion','version','target','quantiles','weighting','interpretation','seriesKey','sourceRowsChecksum','blocks','overall','perSeason','descriptive','evidenceChecksum'])
      OR jsonb_typeof(qualification->'evidence'->'blocks') IS DISTINCT FROM 'array'
      OR qualification->'evidence'->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR qualification->'evidence'->>'version' IS DISTINCT FROM 'season-cutoff-player-marginal-evidence-v1'
      OR qualification->'evidence'->>'target' IS DISTINCT FROM 'individual-player-marginal-quantiles'
      OR qualification->'evidence'->'quantiles' IS DISTINCT FROM '[0.15,0.5,0.85]'::jsonb
      OR qualification->'evidence'->>'weighting' IS DISTINCT FROM 'equal-season-equal-cutoff-equal-player'
      OR qualification->'evidence'->>'interpretation' IS DISTINCT FROM 'overlapping-outcomes-descriptive-only' THEN RETURN false; END IF;
    key := qualification->'cell'->>'position' || ':' || (qualification->'cell'->>'bucket');
    IF key IS NULL OR NOT key = ANY(expected_keys) OR key = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen,key);
    IF jsonb_array_length(qualification->'sourceScope'->'requiredCells') <> 18
      OR jsonb_array_length(qualification->'requiredEvaluationSeasons') NOT BETWEEN 3 AND 200
      OR jsonb_array_length(qualification->'historicalArtifacts') <> jsonb_array_length(qualification->'requiredEvaluationSeasons')
      OR jsonb_array_length(qualification->'evidence'->'perSeason') <> jsonb_array_length(qualification->'requiredEvaluationSeasons') THEN RETURN false; END IF;
    scope_keys := ARRAY[]::text[];
    FOR scoped IN SELECT v FROM jsonb_array_elements(qualification->'sourceScope'->'requiredCells') v LOOP
      IF NOT ros_marginal_object(scoped,ARRAY['position','bucket']) THEN RETURN false; END IF;
      field := scoped->>'position' || ':' || (scoped->>'bucket');
      IF field IS NULL OR NOT field = ANY(expected_keys) OR field = ANY(scope_keys) THEN RETURN false; END IF;
      scope_keys := array_append(scope_keys,field);
    END LOOP;
    SELECT count(*) INTO matches FROM jsonb_array_elements(policy->'choices') q
      WHERE q->'position' = qualification->'cell'->'position' AND q->'bucket' = qualification->'cell'->'bucket'
        AND q = qualification->'meanChoice';
    IF matches <> 1 OR qualification->'strategy' IS DISTINCT FROM qualification->'meanChoice'->'strategy' THEN RETURN false; END IF;
    fitted := qualification->'liveArtifact';
    IF NOT ros_marginal_object(fitted,ARRAY['schemaVersion','artifactVersion','calibrationVersion','context','fit','evidenceChecksum','artifactChecksum'])
      OR fitted->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR fitted->>'artifactVersion' IS DISTINCT FROM 'ros-marginal-interval-artifact-v1'
      OR fitted->>'calibrationVersion' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
      OR fitted->'context'->'position' IS DISTINCT FROM qualification->'cell'->'position'
      OR fitted->'context'->'bucket' IS DISTINCT FROM qualification->'cell'->'bucket'
      OR fitted->'context'->'strategy' IS DISTINCT FROM qualification->'strategy'
      OR fitted->'context'->'evidenceIdentity' IS DISTINCT FROM policy->'evidenceIdentity'
      OR fitted->'context'->'evidenceIdentity'->'scoringProfileKey' IS DISTINCT FROM value->'scoringProfileKey'
      OR fitted->'fit'->'forecastSeason' IS DISTINCT FROM value->'forecastSeason'
      OR fitted->'fit'->'priorSeasons' IS DISTINCT FROM qualification->'sourceScope'->'sourceSeasons'
      OR fitted->'fit'->>'state' IS DISTINCT FROM 'fitted'
      OR NOT ros_marginal_digest(fitted->'artifactChecksum') THEN RETURN false; END IF;
    IF NOT ros_marginal_fit(fitted,fitted->'context',qualification->'forecastSeason',qualification->'sourceScope'->'sourceSeasons') THEN RETURN false; END IF;
    IF qualification->'evidence'->'seriesKey' IS DISTINCT FROM fitted->'fit'->'seriesKey'
      OR jsonb_array_length(qualification->'linkage') <> jsonb_array_length(qualification->'evidence'->'blocks')
      OR jsonb_array_length(qualification->'linkage') NOT BETWEEN 9 AND 3600 THEN RETURN false; END IF;
    annual_index := 0;
    FOR historical IN SELECT v FROM jsonb_array_elements(qualification->'historicalArtifacts') v LOOP
      SELECT jsonb_agg(v ORDER BY ord) INTO prefix_years
        FROM jsonb_array_elements(qualification->'sourceScope'->'sourceSeasons') WITH ORDINALITY years(v,ord)
        WHERE ord <= annual_index+1;
      IF NOT ros_marginal_object(historical,ARRAY['forecastSeason','artifact'])
        OR historical->'forecastSeason' IS DISTINCT FROM qualification->'requiredEvaluationSeasons'->annual_index
        OR NOT ros_marginal_fit(historical->'artifact',fitted->'context',historical->'forecastSeason',prefix_years) THEN RETURN false; END IF;
      measured := qualification->'evidence'->'perSeason'->annual_index;
      IF NOT ros_marginal_object(measured,ARRAY['seasons','blocks','samples','distinctCutoffs','metrics','forecastSeason'])
        OR measured->'forecastSeason' IS DISTINCT FROM historical->'forecastSeason' THEN RETURN false; END IF;
      SELECT count(*),coalesce(sum((b->>'samples')::integer),0),count(DISTINCT b->>'asOfWeek')
        INTO support_count,support_rows,support_cutoffs FROM jsonb_array_elements(qualification->'evidence'->'blocks') b
        WHERE b->'forecastSeason' = historical->'forecastSeason';
      IF support_count < 3 OR support_rows < 18 OR support_cutoffs <> support_count
        OR measured->'blocks' IS DISTINCT FROM to_jsonb(support_count)
        OR measured->'samples' IS DISTINCT FROM to_jsonb(support_rows)
        OR measured->'distinctCutoffs' IS DISTINCT FROM to_jsonb(support_cutoffs) THEN RETURN false; END IF;
      annual_index := annual_index+1;
    END LOOP;
    block_index := 0;
    FOR block IN SELECT v FROM jsonb_array_elements(qualification->'evidence'->'blocks') v LOOP
      link := qualification->'linkage'->block_index;
      IF NOT ros_marginal_object(block,ARRAY['forecastSeason','asOfWeek','windowStartWeek','windowEndWeek','scheduledGamesRange','artifactChecksum','trainedThroughSeason','sourceRowsChecksum','samples','coverageCount','lowerTailCount','upperTailCount','endpointCounts','pinballSums','wisSum','rawWisSum','intervalScoreSum','widthSum'])
        OR NOT ros_marginal_integer(block->'samples',1,20000)
        OR NOT ros_marginal_integer(block->'asOfWeek',1,17)
        OR NOT ros_marginal_object(link,ARRAY['forecastSeason','asOfWeek','samples','observationChecksum','correctedRowsChecksum','comparisonCandidateRowsChecksum','evidenceSourceRowsChecksum','comparisonRowsChecksum'])
        OR link->'forecastSeason' IS DISTINCT FROM block->'forecastSeason'
        OR link->'asOfWeek' IS DISTINCT FROM block->'asOfWeek'
        OR link->'samples' IS DISTINCT FROM block->'samples'
        OR link->'evidenceSourceRowsChecksum' IS DISTINCT FROM block->'sourceRowsChecksum'
        OR NOT ros_marginal_digest(link->'observationChecksum')
        OR NOT ros_marginal_digest(link->'correctedRowsChecksum') THEN RETURN false; END IF;
      SELECT h INTO historical FROM jsonb_array_elements(qualification->'historicalArtifacts') h WHERE h->'forecastSeason'=block->'forecastSeason';
      IF NOT FOUND OR block->'artifactChecksum' IS DISTINCT FROM historical->'artifact'->'artifactChecksum'
        OR block->'trainedThroughSeason' IS DISTINCT FROM historical->'artifact'->'fit'->'priorSeasons'->-1 THEN RETURN false; END IF;
      IF block->'forecastSeason'=qualification->'comparisonSeason' THEN
        IF link->'comparisonCandidateRowsChecksum' IS DISTINCT FROM link->'correctedRowsChecksum'
          OR NOT ros_marginal_digest(link->'comparisonRowsChecksum') THEN RETURN false; END IF;
      ELSIF link->'comparisonCandidateRowsChecksum' IS DISTINCT FROM 'null'::jsonb
        OR link->'comparisonRowsChecksum' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
      block_index := block_index+1;
    END LOOP;
    IF qualification->>'state' = 'qualified' THEN
      IF qualification->'reasons' IS DISTINCT FROM '[]'::jsonb OR qualification->'comparison'->>'state' IS DISTINCT FROM 'passed' THEN RETURN false; END IF;
      qualified_keys := array_append(qualified_keys,key);
    ELSIF qualification->>'state' = 'failed-qualification' THEN
      IF jsonb_array_length(qualification->'reasons') = 0 THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
  END LOOP;
  FOR cell IN SELECT v FROM jsonb_array_elements(admitted->'cells') v LOOP
    IF NOT ros_marginal_cell(cell) THEN RETURN false; END IF;
    key := cell->'cell'->>'position' || ':' || (cell->'cell'->>'bucket');
    IF NOT key = ANY(qualified_keys) OR key = ANY(compact_keys) THEN RETURN false; END IF;
    compact_keys := array_append(compact_keys,key);
    SELECT q INTO qualification FROM jsonb_array_elements(admitted->'qualifications') q WHERE q->'cell' = cell->'cell';
    IF cell->'qualificationChecksum' IS DISTINCT FROM qualification->'qualificationChecksum'
      OR cell->'artifactChecksum' IS DISTINCT FROM qualification->'liveArtifact'->'artifactChecksum'
      OR cell->'evidenceChecksum' IS DISTINCT FROM qualification->'evidence'->'evidenceChecksum'
      OR cell->'comparisonChecksum' IS DISTINCT FROM qualification->'comparison'->'evidenceChecksum'
      OR cell->'strategy' IS DISTINCT FROM qualification->'strategy'
      OR cell->'forecastSeason' IS DISTINCT FROM qualification->'forecastSeason'
      OR cell->'sourceSeasons' IS DISTINCT FROM qualification->'sourceScope'->'sourceSeasons'
      OR cell->'requiredEvaluationSeasons' IS DISTINCT FROM qualification->'requiredEvaluationSeasons'
      OR cell->'comparisonSeason' IS DISTINCT FROM qualification->'comparisonSeason'
      OR cell->'candidateWis' IS DISTINCT FROM qualification->'comparison'->'candidateWis'
      OR cell->'benchmarkWis' IS DISTINCT FROM qualification->'comparison'->'benchmarkWis'
      OR cell->'comparisonCohortChecksum' IS DISTINCT FROM qualification->'comparison'->'cells'->0->'cohortChecksum'
      OR cell->'fullReportChecksum' IS DISTINCT FROM qualification->'sourceScope'->'fullReportChecksum'
      OR cell->'protocolChecksum' IS DISTINCT FROM qualification->'sourceScope'->'protocolChecksum'
      OR cell->'sourceManifestChecksum' IS DISTINCT FROM qualification->'sourceScope'->'sourceManifestChecksum' THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['coverage','lowerTail','upperTail'] LOOP
      IF cell->'aggregate'->field IS DISTINCT FROM qualification->'evidence'->'overall'->'metrics'->field THEN RETURN false; END IF;
    END LOOP;
    annual_index := 0;
    FOR annual IN SELECT v FROM jsonb_array_elements(cell->'annualSupport') v LOOP
      measured := qualification->'evidence'->'perSeason'->annual_index;
      IF measured->'forecastSeason' IS DISTINCT FROM annual->'forecastSeason'
        OR measured->'samples' IS DISTINCT FROM annual->'samples'
        OR measured->'blocks' IS DISTINCT FROM to_jsonb(jsonb_array_length(annual->'cutoffs'))
        OR measured->'distinctCutoffs' IS DISTINCT FROM to_jsonb(jsonb_array_length(annual->'cutoffs')) THEN RETURN false; END IF;
      FOREACH field IN ARRAY ARRAY['coverage','lowerTail','upperTail'] LOOP
        IF annual->field IS DISTINCT FROM measured->'metrics'->field THEN RETURN false; END IF;
      END LOOP;
      annual_index := annual_index+1;
    END LOOP;
  END LOOP;
  IF cardinality(compact_keys) <> cardinality(qualified_keys) THEN RETURN false; END IF;
  first_cell := value->'cells'->0;
  FOR cell IN SELECT v FROM jsonb_array_elements(value->'cells') v LOOP
    IF NOT ros_marginal_cell(cell) OR cell->'cell' IS DISTINCT FROM value->'releasedCells'->cell_index
      OR cell->'forecastSeason' IS DISTINCT FROM value->'forecastSeason'
      OR cell->'scoringProfileKey' IS DISTINCT FROM value->'scoringProfileKey' THEN RETURN false; END IF;
    key := cell->'cell'->>'position' || ':' || (cell->'cell'->>'bucket');
    IF key COLLATE "C" <= previous_key COLLATE "C" THEN RETURN false; END IF;
    previous_key := key;
    SELECT count(*) INTO matches FROM jsonb_array_elements(admitted->'cells') c WHERE c = cell;
    IF matches <> 1 THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['sourceScopeChecksum','sourceBindingsChecksum','fullReportChecksum','protocolChecksum','sourceManifestChecksum','sourceSeasons','requiredEvaluationSeasons','comparisonSeason'] LOOP
      IF cell->field IS DISTINCT FROM first_cell->field THEN RETURN false; END IF;
    END LOOP;
    SELECT count(*) INTO matches FROM jsonb_array_elements(configuration->'releasingBuckets') b
      WHERE b->'position' = cell->'cell'->'position' AND b->'bucket' = cell->'cell'->'bucket';
    IF matches <> 1 THEN RETURN false; END IF;
    SELECT b INTO bucket_configuration FROM jsonb_array_elements(configuration->'releasingBuckets') b
      WHERE b->'position' = cell->'cell'->'position' AND b->'bucket' = cell->'cell'->'bucket';
    SELECT q INTO qualification FROM jsonb_array_elements(admitted->'qualifications') q WHERE q->'cell' = cell->'cell';
    IF NOT ros_marginal_object(bucket_configuration,ARRAY['position','bucket','strategy','intervalCalibration'])
      OR bucket_configuration->'strategy' IS DISTINCT FROM cell->'strategy'
      OR NOT ros_marginal_object(bucket_configuration->'intervalCalibration',ARRAY['method','qualificationChecksum','artifactChecksum','releaseGateEvidenceChecksum','artifact'])
      OR bucket_configuration->'intervalCalibration'->'method' IS DISTINCT FROM value->'method'
      OR bucket_configuration->'intervalCalibration'->'qualificationChecksum' IS DISTINCT FROM cell->'qualificationChecksum'
      OR bucket_configuration->'intervalCalibration'->'artifactChecksum' IS DISTINCT FROM cell->'artifactChecksum'
      OR NOT ros_marginal_digest(bucket_configuration->'intervalCalibration'->'releaseGateEvidenceChecksum')
      OR bucket_configuration->'intervalCalibration'->'artifact' IS DISTINCT FROM qualification->'liveArtifact' THEN RETURN false; END IF;
    cell_index := cell_index+1;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
-- The full admitted proof is checked once per immutable run, not once per player.
-- Caller-provided stamps are discarded; historical rows remain NULL after ADD COLUMN.
CREATE FUNCTION enforce_ros_marginal_model_run_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE champion_record record; interval_calibration jsonb;
BEGIN
  NEW.marginal_interval_contract_version := NULL;
  interval_calibration := NEW.calibration->'rosIntervals';
  IF interval_calibration->'schemaVersion' = '2'::jsonb THEN
    IF NEW.horizon IS DISTINCT FROM 'rest-of-season'
      OR NEW.configuration->>'simulationModelVersion' IS DISTINCT FROM NEW.model_version
      OR NEW.configuration->>'mode' IS DISTINCT FROM 'release'
      OR NEW.configuration->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-marginal-quantiles-v8'
      OR NEW.configuration->>'calibrationVersion' IS DISTINCT FROM 'season-prior-weighted-quantile-residuals-v1'
      OR interval_calibration->'forecastSeason' IS DISTINCT FROM to_jsonb(NEW.season) THEN
      RAISE EXCEPTION 'ROS marginal model run lineage is invalid';
    END IF;
    SELECT * INTO champion_record FROM first_party_ros_champion_artifacts
    WHERE artifact_checksum = interval_calibration->>'championArtifactChecksum'
      AND season = NEW.season AND model_version = NEW.model_version
      AND policy_version = NEW.configuration->>'policyVersion'
      AND calibration_version = NEW.configuration->>'calibrationVersion'
      AND scoring_profile_key = NEW.configuration->>'scoringProfileKey';
    IF NOT FOUND OR champion_record.evidence_through_season >= champion_record.season
      OR NOT ros_marginal_envelope(interval_calibration,champion_record.release_gate->'marginalIntervals',champion_record.policy,NEW.configuration)
      OR champion_record.evidence_through_season IS DISTINCT FROM
        (interval_calibration->'cells'->0->>'comparisonSeason')::integer THEN
      RAISE EXCEPTION 'ROS marginal intervals require matching immutable admitted cell evidence';
    END IF;
    NEW.marginal_interval_contract_version := 2;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER projection_model_runs_marginal_contract_trigger
BEFORE INSERT ON projection_model_runs
FOR EACH ROW EXECUTE FUNCTION enforce_ros_marginal_model_run_contract();
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
    "calibration", "metrics", "marginal_interval_contract_version"
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
