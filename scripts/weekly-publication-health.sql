-- Read-only health of actual league publications. The model-run quality_state describes the
-- reference scoring profile; an exact league can independently pass and publish when it fails.
-- created_at is the publication clock. fetched_at is the oldest selected source verification,
-- which can legitimately belong to an immutable historical season.
with identity as (
  select 'laces-weekly-components-v15'::text as model_version,
         'walk-forward-expected-mean-conditional-interval-v8'::text as policy_version,
         'league-scoring-map-v9'::text as scoring_mapping_version,
         extract(year from now() at time zone 'UTC')::int
           - case when extract(month from now() at time zone 'UTC') < 3 then 1 else 0 end as season
), targets as (
  select ls.id, l.name, ls.season, greatest(1, least(coalesce(ls.current_week, 1), 18)) as week
    from league_seasons ls
    join leagues l on l.id = ls.league_id
    join identity i on i.season = ls.season
   where not l.archived
), latest_runs as (
  select distinct on (r.season, r.target_week)
         r.season, r.target_week, r.input_checksum, r.metrics
    from projection_model_runs r join identity i on i.model_version = r.model_version
   where r.horizon = 'week' and r.season = i.season
   order by r.season, r.target_week, r.created_at desc, r.source_sync_run_id desc
), publications as (
  select t.*, s.created_at as published_at, s.id as set_id, s.metadata,
         r.input_checksum, w.detail as withheld
    from targets t
    left join latest_runs r on r.season = t.season and r.target_week = t.week
    left join lateral (
      select p.id, p.created_at, p.metadata from projection_sets p
       where p.league_season_id = t.id and p.season = t.season and p.week = t.week
         and p.horizon = 'week' and p.source = 'laces-out-first-party'
       order by p.created_at desc, p.id desc limit 1
    ) s on true
    left join lateral (
      select detail from jsonb_array_elements(
        case when jsonb_typeof(r.metrics->'leagues'->'withheld') = 'array'
          then r.metrics->'leagues'->'withheld' else '[]'::jsonb end
      ) detail where detail->>'leagueSeasonId' = t.id::text limit 1
    ) w on true
), evaluated as (
  select p.*,
    case
      -- A wholly unsupported scoring shape is an explicit limitation, not an operational outage.
      when withheld->>'scope' = 'league'
        and jsonb_typeof(withheld->'positions') = 'array'
        and (select count(distinct position->>'position') from jsonb_array_elements(
          case when jsonb_typeof(withheld->'positions') = 'array'
            then withheld->'positions' else '[]'::jsonb end
        ) position where position->>'source' = 'normalization'
          and position->>'position' in ('QB','RB','WR','TE','K','DST')) = 6
        then 'unsupported'
      when withheld is not null then 'withheld'
      when set_id is null then 'missing'
      when coalesce(
        metadata->>'modelVersion' = i.model_version
        and metadata->>'publicationPolicyVersion' = i.policy_version
        and metadata->>'scoringMappingVersion' = i.scoring_mapping_version
        and length(metadata->>'scoringProfileKey') > 0
        and metadata->>'modelInputChecksum' = input_checksum
        and metadata->>'qualityState' = 'publishable'
        and jsonb_typeof(metadata->'supportedPositions') = 'array'
        and metadata->'supportedPositions' <> '[]'::jsonb
        and jsonb_typeof(metadata->'publishedPositions') = 'array'
        and (metadata->'publishedPositions') @> (metadata->'supportedPositions')
        and metadata->'withheldPositions' = '[]'::jsonb
        and exists (select 1 from player_projections pp where pp.projection_set_id = set_id),
        false
      ) then 'published'
      else 'incomplete'
    end as publication_state
  from publications p cross join identity i
)
select id::text, regexp_replace(name, '[|\r\n]+', ' ', 'g') as league_name, week,
       coalesce(floor(extract(epoch from (now() - published_at)) / 3600)::bigint, -1) as age_hours,
       publication_state
  from evaluated order by name, id;
