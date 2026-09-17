-- Read-only publication health. Never-published leagues become visible once their supported
-- scoring shape is registered; first publication gets 36 hours from the validation request.
-- Complete weekly normalization also catches a failed registrar, with 36 hours from signup.
-- Keep release identities synchronized with @laces-out/projections (pinned by the PG test).
with release_identity as (
  select 'laces-ros-distribution-v9'::text as model_version,
         'season-walk-forward-block-wis-cqr-v4'::text as policy_version,
         'season-blocked-split-conformal-cqr-v1'::text as calibration_version,
         extract(year from now() at time zone 'UTC')::int
           - case when extract(month from now() at time zone 'UTC') < 3 then 1 else 0 end as season
), latest as (
  select s.league_season_id, max(s.fetched_at) as published_at
    from projection_sets s
   where s.source = 'laces-out-first-party-ros'
     and s.horizon = 'rest-of-season'
     and s.metadata->>'releaseCompleteness' = 'full'
     and s.metadata->>'preservePriorGoodSet' = 'false'
     and exists (select 1 from player_projections p where p.projection_set_id = s.id)
   group by s.league_season_id
), current_scoring as (
  select distinct on (s.league_season_id)
         s.league_season_id, s.metadata->>'scoringProfileKey' as scoring_profile_key,
         length(s.metadata->>'scoringProfileKey') > 0
           and s.metadata->'supportedPositions' @> '["QB","RB","WR","TE","K","DST"]'::jsonb
           and jsonb_typeof(s.metadata->'scoringWarnings') = 'array'
           and not exists (
             select 1 from jsonb_array_elements(
               case when jsonb_typeof(s.metadata->'scoringWarnings') = 'array'
                 then s.metadata->'scoringWarnings' else '[]'::jsonb end
             ) warning
             where coalesce(warning->>'code', '') not in (
               'IGNORED_ZERO_POINT_RULE', 'DISPLAY_NAME_FALLBACK'
             )
           ) as fully_supported
    from projection_sets s
    join release_identity r on r.season = s.season
   where s.source = 'laces-out-first-party' and s.horizon = 'week'
   order by s.league_season_id, s.created_at desc, s.id desc
), expected as (
  select ls.id, l.name, v.state as validation_state,
         coalesce(v.requested_at, case when s.fully_supported then ls.created_at end) as requested_at
    from league_seasons ls
    join leagues l on l.id = ls.league_id
    join release_identity r on r.season = ls.season
    left join current_scoring s on s.league_season_id = ls.id
    left join first_party_ros_profile_validations v
      on v.season = ls.season and v.scoring_profile_key = s.scoring_profile_key
     and v.scoring_profile_digest = encode(sha256(convert_to(s.scoring_profile_key, 'UTF8')), 'hex')
     and v.model_version = r.model_version and v.policy_version = r.policy_version
     and v.calibration_version = r.calibration_version
   where not l.archived
     -- Unsupported IDP-only shapes never enter the registry. Withheld/failed validation of a
     -- supported shape is actionable, so it remains monitored after the same initial grace.
     and (v.id is not null or s.fully_supported or exists (
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
