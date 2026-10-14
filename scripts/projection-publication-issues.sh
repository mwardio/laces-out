#!/usr/bin/env bash
# Sourced by the host sentinel after defining psql_query, add_issue, and observations.
# Read-only: notification delivery and persisted incident state belong to the sentinel.
projection_repository="${LACES_OUT_REPOSITORY:-/workspace/laces-out}"
if ! weekly_source="$(psql_query -At -F '|' -c "
  select consecutive_failures from data_sources
   where enabled and key = 'laces-out.projections.first-party';")"; then
  add_issue "weekly-monitor-query" "Cannot inspect weekly projection source failures"
elif [[ -z "${weekly_source}" ]]; then
  add_issue "weekly-projection-missing" "Weekly projection source is missing"
elif [[ "${weekly_source}" -ge 3 ]]; then
  add_issue "weekly-projection-failures" "Weekly projections have ${weekly_source} consecutive failures"
fi

declare -a stale_weekly_leagues=() withheld_weekly_leagues=() stale_ros_leagues=()
weekly_health_sql="${projection_repository}/scripts/weekly-publication-health.sql"
if [[ ! "${weekly_projection_max_age_hours}" =~ ^[1-9][0-9]*$ ]]; then
  add_issue "weekly-monitor-config" "Weekly publication age threshold is invalid"
elif [[ ! -r "${weekly_health_sql}" ]] || ! weekly_publications="$(psql_query -At -F '|' -c "$(cat "${weekly_health_sql}")")"; then
  add_issue "weekly-monitor-query" "Cannot inspect league weekly publication freshness"
else
  while IFS='|' read -r weekly_league_id weekly_league_name weekly_week weekly_age_hours weekly_state; do
    [[ -z "${weekly_league_id}" ]] && continue
    if [[ "${weekly_state}" == unsupported ]]; then
      observations+=("Weekly ${weekly_league_name}: unsupported scoring")
    elif [[ "${weekly_state}" != published ]]; then
      withheld_weekly_leagues+=("${weekly_league_name} W${weekly_week}: ${weekly_state}")
    elif [[ "${weekly_age_hours}" -lt 0 || "${weekly_age_hours}" -ge "${weekly_projection_max_age_hours}" ]]; then
      stale_weekly_leagues+=("${weekly_league_name} W${weekly_week}: ${weekly_age_hours}h old")
    else
      observations+=("Weekly ${weekly_league_name} W${weekly_week}: ${weekly_age_hours}h old")
    fi
  done <<<"${weekly_publications}"
  if [[ ${#withheld_weekly_leagues[@]} -gt 0 ]]; then
    add_issue "weekly-projection-gate" "Weekly league publication missing or incomplete. $(printf '%s; ' "${withheld_weekly_leagues[@]}")"
  fi
  if [[ ${#stale_weekly_leagues[@]} -gt 0 ]]; then
    add_issue "weekly-projection-stale" "Weekly league forecasts stale (${weekly_projection_max_age_hours}h limit). $(printf '%s; ' "${stale_weekly_leagues[@]}")"
  fi
fi

# Use the running serving configuration, not an old monitor image's default. Inspect only env
# internally; emit the allowlisted rail, never credentials. Failed inspection is not legacy mode.
ros_release_rail="$(docker inspect --format '{{json .Config.Env}}' "${LACES_OUT_API_CONTAINER:-laces-out-api-1}" |
  jq -er 'map(select(startswith("ROS_RELEASE_RAIL="))) |
    if length == 0 then "legacy-v7"
    elif length == 1 then .[0] | ltrimstr("ROS_RELEASE_RAIL=")
    else error("ambiguous ROS rail") end')" || ros_release_rail="inspection-failed"
ros_health_sql="${projection_repository}/scripts/ros-publication-health.sql"
if [[ ! "${ros_projection_max_age_hours}" =~ ^[1-9][0-9]*$ ]]; then
  add_issue "ros-monitor-config" "ROS publication age threshold is invalid"
elif [[ "${ros_release_rail}" != legacy-v7 && "${ros_release_rail}" != marginal-v8 && "${ros_release_rail}" != point-v1 ]]; then
  add_issue "ros-monitor-config" "Cannot determine a supported ROS release rail from the serving API"
elif [[ ! -r "${ros_health_sql}" ]] || ! ros_publications="$(psql_query -At -F '|' -c "SET laces.ros_release_rail = '${ros_release_rail}'; $(cat "${ros_health_sql}")")"; then
  add_issue "ros-monitor-query" "Cannot inspect approved ROS publication freshness"
else
  observations+=("ROS release rail ${ros_release_rail}")
  while IFS='|' read -r ros_league_id ros_league_name ros_age_hours ros_published_at; do
    [[ -z "${ros_league_id}" ]] && continue
    if [[ "${ros_league_id}" == configuration-error ]]; then
      add_issue "ros-monitor-config" "ROS publication query does not support the serving release rail"
    elif [[ "${ros_age_hours}" -lt 0 || "${ros_age_hours}" -ge "${ros_projection_max_age_hours}" ]]; then
      stale_ros_leagues+=("${ros_league_name}: ${ros_age_hours}h old, last published ${ros_published_at}")
    else
      observations+=("ROS ${ros_league_name}: ${ros_age_hours}h old")
    fi
  done <<<"${ros_publications}"
fi
