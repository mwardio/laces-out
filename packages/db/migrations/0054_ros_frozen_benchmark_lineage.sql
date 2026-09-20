-- Preserve every0053 interval gate. The optional original benchmark lineage is additionally
-- checked against the corrected observations and the same immutable admitted qualification set.
CREATE FUNCTION ros_frozen_benchmark_binding(value jsonb, corrected jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE binding jsonb; source jsonb; rules jsonb; rule jsonb; original_rules jsonb; corrected_rules jsonb;
BEGIN
  IF NOT ros_marginal_object(value,ARRAY['version','comparisonManifestChecksum','original','correctedObservations','checksum'])
    OR value->>'version' IS DISTINCT FROM 'original-forecasts-corrected-observations-v1'
    OR NOT ros_marginal_digest(value->'comparisonManifestChecksum')
    OR NOT ros_marginal_digest(value->'checksum')
    OR value->'correctedObservations' IS DISTINCT FROM corrected THEN RETURN false; END IF;
  FOR binding IN SELECT value->'original' UNION ALL SELECT value->'correctedObservations' LOOP
    IF NOT ros_marginal_object(binding,ARRAY['source','sourceManifestChecksum','rowsChecksum'])
      OR NOT ros_marginal_digest(binding->'sourceManifestChecksum')
      OR NOT ros_marginal_digest(binding->'rowsChecksum') THEN RETURN false; END IF;
    source := binding->'source';
    IF NOT ros_marginal_object(source,ARRAY['modelVersion','policyVersion','scoringProfileKey','physicalCorpusChecksum','reportChecksum'])
      OR source->>'modelVersion' IS DISTINCT FROM 'laces-ros-distribution-v12'
      OR source->>'policyVersion' IS DISTINCT FROM 'season-walk-forward-mean-rmse-block-wis-cqr-v7'
      OR NOT ros_marginal_digest(source->'physicalCorpusChecksum')
      OR NOT ros_marginal_digest(source->'reportChecksum')
      OR jsonb_typeof(source->'scoringProfileKey') IS DISTINCT FROM 'string'
      OR char_length(source->>'scoringProfileKey') > 65536 THEN RETURN false; END IF;
    rules := (source->>'scoringProfileKey')::jsonb;
    IF jsonb_typeof(rules) IS DISTINCT FROM 'array' OR jsonb_array_length(rules) NOT BETWEEN 1 AND 512 THEN RETURN false; END IF;
    FOR rule IN SELECT v FROM jsonb_array_elements(rules) v LOOP
      IF jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF rule ? 'statDefinition' AND (
        coalesce(rule->>'statDefinition' NOT IN ('yahoo-2022-v1','espn-2019-v1'),true)
        OR NOT coalesce(rule->>'statId' = 'points_allowed' OR rule->>'statId' ~ '^points_allowed_.+_probability$',false)
      ) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  SELECT jsonb_agg(r.rule - 'statDefinition' ORDER BY r.ordinal) INTO original_rules
    FROM jsonb_array_elements((value->'original'->'source'->>'scoringProfileKey')::jsonb) WITH ORDINALITY AS r(rule,ordinal);
  SELECT jsonb_agg(r.rule - 'statDefinition' ORDER BY r.ordinal) INTO corrected_rules
    FROM jsonb_array_elements((value->'correctedObservations'->'source'->>'scoringProfileKey')::jsonb) WITH ORDINALITY AS r(rule,ordinal);
  RETURN original_rules IS NOT DISTINCT FROM corrected_rules;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ros_marginal_envelope(value jsonb, admitted jsonb, policy jsonb, configuration jsonb) RETURNS boolean
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
    IF NOT ros_marginal_object(qualification - 'frozenPrevious',ARRAY['schemaVersion','qualificationMethod','state','interpretation','canAuthorizeRelease','scope','cell','forecastSeason','requiredEvaluationSeasons','comparisonSeason','strategy','previousStrategy','meanSelectorPolicyVersion','meanSelectorOptions','meanChoice','previousMeanChoice','sourceScope','sources','intervalTraining','liveArtifact','historicalArtifacts','evidence','comparison','linkage','reasons','qualificationChecksum'])
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
      OR qualification->'frozenPrevious' IS DISTINCT FROM first_qualification->'frozenPrevious'
      OR (qualification ? 'frozenPrevious' AND NOT ros_frozen_benchmark_binding(qualification->'frozenPrevious', qualification->'sources'->'previous'))
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
