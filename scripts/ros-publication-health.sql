-- Read-only monitoring of actual approved ROS publications. Successful jobs and shadow runs do
-- not advance this clock. Check each active league so one fresh league cannot mask stale peers.
with latest as (
  select s.league_season_id, max(s.fetched_at) as published_at
    from projection_sets s
   where s.source = 'laces-out-first-party-ros'
     and s.horizon = 'rest-of-season'
     and s.metadata->>'releaseCompleteness' = 'full'
     and s.metadata->>'preservePriorGoodSet' = 'false'
     and exists (select 1 from player_projections p where p.projection_set_id = s.id)
   group by s.league_season_id
), expected as (
  select distinct ls.id, l.name
    from league_seasons ls
    join leagues l on l.id = ls.league_id
    join projection_sets s on s.league_season_id = ls.id
   where not l.archived
     and ls.season = extract(year from now())::int
     and s.source = 'laces-out-first-party-ros'
)
select expected.id::text,
       regexp_replace(expected.name, '[|\r\n]+', ' ', 'g'),
       coalesce(floor(extract(epoch from (now() - latest.published_at)) / 3600)::bigint, -1),
       coalesce(to_char(latest.published_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), 'never')
  from expected
  left join latest on latest.league_season_id = expected.id
union all
select 'missing', 'All leagues', -1, 'never'
 where not exists (select 1 from expected)
   and exists (
     select 1 from projection_sets s
       join league_seasons ls on ls.id = s.league_season_id
       join leagues l on l.id = ls.league_id
      where s.horizon = 'week' and not l.archived
        and ls.season = extract(year from now())::int
   );
