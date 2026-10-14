#!/usr/bin/env bash
set -Eeuo pipefail
LACES_OUT_REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
weekly_projection_max_age_hours=12
ros_projection_max_age_hours=36
weekly_failures=0
weekly_rows='a|League A|2|1|published'
ros_rows='a|League A|10|today'
rail=point-v1
inspect_fails=false
weekly_query_fails=false
ros_query_fails=false
source_missing=false
source_query_fails=false
docker() {
  if [[ "$inspect_fails" == true ]]; then return 1; fi
  jq -cn --arg rail "$rail" '["ROS_RELEASE_RAIL="+$rail]'
}
psql_query() {
  case "$*" in
    *"consecutive_failures from data_sources"*)
      if [[ "$source_query_fails" == true ]]; then return 1; fi
      if [[ "$source_missing" == false ]]; then printf '%s\n' "$weekly_failures"; fi ;;
    *"Read-only health of actual league publications"*)
      if [[ "$weekly_query_fails" == true ]]; then return 1; fi
      printf '%s\n' "$weekly_rows" ;;
    *"SET laces.ros_release_rail = '${rail}'"*)
      if [[ "$ros_query_fails" == true ]]; then return 1; fi
      printf '%s\n' "$ros_rows" ;;
    *) printf 'Unexpected SQL invocation\n' >&2; return 1 ;;
  esac
}
add_issue() { issue_keys+=("$1"); }
probe() {
  issue_keys=()
  observations=()
  source "$LACES_OUT_REPOSITORY/scripts/projection-publication-issues.sh"
  stale_ros_count=${#stale_ros_leagues[@]}
}
has_issue() { [[ " ${issue_keys[*]} " == *" $1 "* ]]; }
probe
[[ ${#issue_keys[@]} -eq 0 && $stale_ros_count -eq 0 ]]
[[ " ${observations[*]} " == *"ROS release rail point-v1"* ]]
weekly_rows+=$'\nb|Stale peer|2|12|published\nc|Failed peer|2|1|withheld\nd|Unsupported|2|-1|unsupported'
probe
has_issue weekly-projection-stale
has_issue weekly-projection-gate
[[ ${#issue_keys[@]} -eq 2 ]]
weekly_rows='a|League A|2|1|published'
ros_rows+=$'\nb|Stale ROS peer|36|yesterday'
probe
[[ $stale_ros_count -eq 1 ]]
weekly_failures=3
probe
has_issue weekly-projection-failures
weekly_failures=0
source_missing=true
probe
has_issue weekly-projection-missing
source_missing=false
source_query_fails=true
probe
has_issue weekly-monitor-query
source_query_fails=false
weekly_query_fails=true
ros_query_fails=true
probe
has_issue weekly-monitor-query
has_issue ros-monitor-query
weekly_query_fails=false
ros_query_fails=false
for rail in legacy-v7 marginal-v8 point-v1; do
  probe
  [[ ${#issue_keys[@]} -eq 0 ]]
done
rail=unknown
probe
has_issue ros-monitor-config
rail=point-v1
inspect_fails=true
probe
has_issue ros-monitor-config
inspect_fails=false
weekly_projection_max_age_hours=invalid
ros_projection_max_age_hours=0
probe
has_issue weekly-monitor-config
has_issue ros-monitor-config
printf 'Projection publication monitoring tests passed\n'
