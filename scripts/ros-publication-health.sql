-- Read-only publication health. Never-published leagues become visible once their supported
-- scoring shape is registered; first publication gets 36 hours from the validation request.
-- Complete weekly normalization also catches a failed registrar, with 36 hours from signup.
-- Keep release identities synchronized with @laces-out/projections (pinned by the PG test).
with release_identity as (
  select 'laces-ros-distribution-v11'::text as model_version,
         'season-walk-forward-block-wis-cqr-v4'::text as policy_version,
         'season-blocked-split-conformal-cqr-v1'::text as calibration_version,
         'league-scoring-map-v7'::text as scoring_mapping_version,
         extract(year from now() at time zone 'UTC')::int
           - case when extract(month from now() at time zone 'UTC') < 3 then 1 else 0 end as season
), latest_weekly as (
  select distinct on (s.league_season_id)
         s.league_season_id, s.metadata
    from projection_sets s
    join release_identity r on r.season = s.season
   where s.source = 'laces-out-first-party' and s.horizon = 'week'
   order by s.league_season_id, s.created_at desc, s.id desc
), current_scoring as (
  select s.league_season_id, s.metadata->>'scoringProfileKey' as scoring_profile_key,
         s.metadata->'supportedPositions' @> '["QB","RB","WR","TE","K","DST"]'::jsonb as all_positions,
         s.metadata->>'scoringMappingVersion' = r.scoring_mapping_version
           and length(s.metadata->>'scoringProfileKey') > 0
           and jsonb_typeof(s.metadata->'scoringWarnings') = 'array'
           and jsonb_typeof(s.metadata->'withheldPositions') = 'array'
           and not exists (
             select 1 from jsonb_array_elements(
               case when jsonb_typeof(s.metadata->'scoringWarnings') = 'array'
                 then s.metadata->'scoringWarnings' else '[]'::jsonb end
             ) warning
             where coalesce(warning->>'code', '') not in (
               'IGNORED_ZERO_POINT_RULE', 'DISPLAY_NAME_FALLBACK'
             )
           )
           and not exists (
             select 1 from jsonb_array_elements(
               case when jsonb_typeof(s.metadata->'withheldPositions') = 'array'
                 then s.metadata->'withheldPositions' else '[]'::jsonb end
             ) position
             where position->>'source' = 'normalization'
               and (jsonb_typeof(position->'reasons') is distinct from 'array' or exists (
                 select 1 from jsonb_array_elements_text(
                   case when jsonb_typeof(position->'reasons') = 'array'
                     then position->'reasons' else '[]'::jsonb end
                 ) reason
                 where reason not like 'NO_SUPPORTED_RULES:%'
               ))
           ) as normalization_supported
    from latest_weekly s cross join release_identity r
), latest as (
  select s.league_season_id, max(s.fetched_at) as published_at
    from projection_sets s
    join release_identity r on r.season = s.season
    join current_scoring current on current.league_season_id = s.league_season_id
      and current.normalization_supported
      and current.scoring_profile_key = s.metadata->>'scoringProfileKey'
    join first_party_ros_champion_artifacts a
      on a.artifact_checksum = s.metadata->>'championArtifactChecksum'
     and a.season = s.season and a.scoring_profile_key = current.scoring_profile_key
     and a.model_version = r.model_version and a.policy_version = r.policy_version
     and a.calibration_version = r.calibration_version
     -- Admission stores the historical report, not a synthetic "released" state. A report with
     -- cell blockers may still authorize this set's fully released remaining-season window.
     and a.admitted_at is not null
     and a.release_gate->>'state' in ('evidence-ready', 'insufficient')
     and jsonb_typeof(a.release_gate->'blockers') = 'array'
   where s.source = 'laces-out-first-party-ros'
     and s.horizon = 'rest-of-season'
     and s.metadata->>'releaseCompleteness' = 'full'
     and s.metadata->>'preservePriorGoodSet' = 'false'
     and exists (select 1 from player_projections p where p.projection_set_id = s.id)
   group by s.league_season_id
), expected as (
  select ls.id, l.name, v.state as validation_state,
         coalesce(v.requested_at, case when s.normalization_supported and s.all_positions then ls.created_at end) as requested_at
    from league_seasons ls
    join leagues l on l.id = ls.league_id
    join release_identity r on r.season = ls.season
    left join current_scoring s on s.league_season_id = ls.id
    left join first_party_ros_profile_validations v
      on s.normalization_supported
     and v.season = ls.season and v.scoring_profile_key = s.scoring_profile_key
     and v.scoring_profile_digest = encode(sha256(convert_to(s.scoring_profile_key, 'UTF8')), 'hex')
     and v.model_version = r.model_version and v.policy_version = r.policy_version
     and v.calibration_version = r.calibration_version
   where not l.archived
     -- Unsupported IDP-only shapes never enter the registry. Withheld/failed validation of a
     -- supported shape is actionable, so it remains monitored after the same initial grace.
     and (v.id is not null or (s.normalization_supported and s.all_positions) or exists (
       select 1 from projection_sets prior
        where prior.league_season_id = ls.id and prior.source = 'laces-out-first-party-ros'
     ))
)
select expected.id::text,
       regexp_replace(expected.name, '[|\r\n]+', ' ', 'g') as league_name,
       coalesce(floor(extract(epoch from (now() - latest.published_at)) / 3600)::bigint, -1) as age_hours,
       coalesce(to_char(latest.published_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'),
         'never; scoring validation ' || coalesce(expected.validation_state, 'unavailable') ||
         coalesce(' since ' || to_char(expected.requested_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '')) as published_at
  from expected
  left join latest on latest.league_season_id = expected.id
 where latest.published_at is not null or expected.requested_at is null
    or expected.requested_at <= now() - interval '36 hours';
