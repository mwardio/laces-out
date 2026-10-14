#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh

report_only=false
case "${1:-}" in
  "") ;;
  --report-only) report_only=true ;;
  *) printf "Usage: %s [--report-only]\n" "$0" >&2; exit 2 ;;
esac

# Cron and manual probes must not race the persisted delivery state.
exec 9>"${STATE_ROOT}/sentinel.lock"
flock -n 9 || exit 0
declare -a issue_keys=()
declare -a issue_details=()
declare -a observations=()
declare -a unavailable_endpoints=()
declare -a unhealthy_containers=()

alert_observations="${LACES_OUT_ALERT_OBSERVATIONS:-3}"
weekly_projection_max_age_hours="${LACES_OUT_WEEKLY_PROJECTION_MAX_AGE_HOURS:-12}"
ros_projection_max_age_hours="${LACES_OUT_ROS_PROJECTION_MAX_AGE_HOURS:-36}"

add_issue() {
  issue_keys+=("$1")
  issue_details+=("$2")
}

for endpoint in "https://lacesout.app/health/ready" "https://laces.mward.io/health/ready"; do
  if curl --fail --silent --show-error --max-time 15 "${endpoint}" >/dev/null; then
    observations+=("$(printf '%s reachable' "${endpoint#https://}")")
  else
    unavailable_endpoints+=("${endpoint#https://}")
  fi
done
if [[ ${#unavailable_endpoints[@]} -gt 0 ]]; then
  add_issue "public-readiness" "Public readiness failed: $(IFS=', '; echo "${unavailable_endpoints[*]}")"
fi

for container in laces-out-postgres-1 laces-out-api-1 laces-out-worker-1 laces-out-web-1; do
  state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container}" 2>/dev/null || true)"
  if [[ "${state}" != running\|healthy && "${state}" != running\|none ]]; then
    unhealthy_containers+=("${container}=${state:-missing}")
  fi
done
if [[ ${#unhealthy_containers[@]} -gt 0 ]]; then
  add_issue "runtime" "Runtime unhealthy: $(IFS=', '; echo "${unhealthy_containers[*]}")"
fi

if docker exec "${POSTGRES_CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
  heartbeat_age="$(psql_query -At -c "select coalesce(extract(epoch from now() - max(completed_on))::bigint, -1) from pgboss.job where name = 'data-health-check' and state = 'completed';")"
  # A cold projection rebuild is CPU-bound and can legally occupy the worker for close to twenty
  # minutes. Allow one missed quarter-hour sweep before declaring the scheduler dead; container and
  # public readiness failures are still detected immediately above.
  if [[ ! "${heartbeat_age}" =~ ^[0-9]+$ || "${heartbeat_age}" -gt 3000 ]]; then
    add_issue "worker-heartbeat" "worker health sweep is ${heartbeat_age:-unknown}s old"
  else
    observations+=("worker heartbeat ${heartbeat_age}s old")
  fi

  while IFS='|' read -r key failures stale_minutes detail; do
    [[ -z "${key}" ]] && continue
    add_issue "critical-source:${key}" "${key}: ${failures} consecutive failure(s), ${stale_minutes}m since success${detail:+ (${detail})}"
  done < <(
    psql_query -At -F '|' -c "
      select key,
             consecutive_failures,
             floor(extract(epoch from (now() - coalesce(last_successful_at, created_at))) / 60)::bigint,
             left(coalesce(last_error_detail, ''), 120)
        from data_sources
       where enabled
         and key = 'nflverse.players'
         and (
           consecutive_failures >= 3
           or now() - coalesce(last_successful_at, created_at)
                > make_interval(mins => check_interval_minutes * 3)
         );"
  )

  source "${LACES_OUT_REPOSITORY:-/workspace/laces-out}/scripts/projection-publication-issues.sh"

  ros_job="$(psql_query -At -F '|' -c "
    select state, retry_count,
           left(coalesce(output->>'message', output->'value'->>'message', output->>'value', ''), 180),
           coalesce(started_on > now() - interval '36 hours', false)
      from pgboss.job where name = 'ros-projection-refresh'
      order by created_on desc limit 1;")"
  source /ops/ros-publication-issues.sh

  gated_optional_sources="$(psql_query -At -c "
    select count(*)
      from data_sources
     where enabled
       and coalesce(metadata->>'matchRate', '') ~ '^[0-9]+([.][0-9]+)?$'
       and coalesce(metadata->>'minimumPublishableMatchRate', '') ~ '^[0-9]+([.][0-9]+)?$'
       and (metadata->>'matchRate')::numeric
             < (metadata->>'minimumPublishableMatchRate')::numeric;")"
  observations+=("${gated_optional_sources} optional source(s) below publication thresholds")

  secondary_failures="$(psql_query -At -c "
    select count(*)
      from data_sources
     where enabled
       and consecutive_failures >= 3
       and key not in ('nflverse.players', 'laces-out.projections.first-party');")"
  if [[ "${secondary_failures}" -gt 0 ]]; then
    observations+=("${secondary_failures} non-blocking source(s) have at least three consecutive failures")
  fi

  stale_sources="$(psql_query -At -c "
    with active as (
      select coalesce(max(season) filter (where horizon = 'week'), extract(year from now())::int) as season
        from projection_model_runs
    )
    select count(*)
      from data_sources, active
     where enabled
       and key not in ('nflverse.players', 'laces-out.projections.first-party')
       and coalesce(metadata->>'availability', '') <> 'not-published'
       and coalesce(metadata->>'mode', '') <> 'shadow'
       and not (
         key like 'nflverse.%'
         and coalesce(metadata->>'season', '') ~ '^[0-9]{4}$'
         and (metadata->>'season')::int < active.season
       )
       and now() - coalesce(last_successful_at, created_at)
             > make_interval(mins => check_interval_minutes * 2);")"
  if [[ "${stale_sources}" -gt 0 ]]; then
    observations+=("${stale_sources} active non-blocking source(s) are past their freshness window")
  fi

  archived_sources="$(psql_query -At -c "
    with active as (
      select coalesce(max(season) filter (where horizon = 'week'), extract(year from now())::int) as season
        from projection_model_runs
    )
    select count(*)
      from data_sources, active
     where enabled
       and key like 'nflverse.%'
       and coalesce(metadata->>'season', '') ~ '^[0-9]{4}$'
       and (metadata->>'season')::int < active.season
       and last_checksum is not null
       and last_successful_at is not null
       and coalesce(metadata->>'availability', 'available') = 'available'
       and coalesce(metadata->>'publishable', 'true') <> 'false';")"
  observations+=("${archived_sources} admitted historical source snapshot(s)")

  provider_issues="$(psql_query -At -c "select count(*) from provider_connections where health in ('degraded', 'reauthorize');")"
  if [[ "${provider_issues}" -gt 0 ]]; then
    add_issue "provider-connections" "${provider_issues} league connection(s) need attention or reauthorization"
  fi

  recent_sync_failures="$(psql_query -At -c "select count(*) from sync_runs where state = 'failed' and started_at > now() - interval '6 hours';")"
  if [[ "${recent_sync_failures}" -gt 0 ]]; then
    observations+=("${recent_sync_failures} transient ingestion or league-sync failure(s) in the last six hours")
  fi

  dead_letters="$(psql_query -At -c "select count(*) from pgboss.job where name like '%-dead-letter' and state = 'created';")"
  if [[ "${dead_letters}" -gt 0 ]]; then
    add_issue "dead-letters" "${dead_letters} unacknowledged dead-letter job(s)"
  else
    observations+=("no dead letters")
  fi

  model_summary="$(psql_query -At -F '|' -c "
    select season,
           coalesce(target_week::text, window_start_week::text || '-' || window_end_week::text),
           quality_state,
           players_published,
           floor(extract(epoch from (now() - created_at)) / 3600)::bigint
      from projection_model_runs
     where horizon = 'week'
     order by created_at desc
     limit 1;")"
  observations+=("latest reference-profile model run ${model_summary:-unavailable}; league publication health is checked separately")
else
  add_issue "database" "PostgreSQL is not accepting connections"
fi

backup_source="$(findmnt -no SOURCE -T "${BACKUP_ROOT}" 2>/dev/null || true)"
backup_error="$(backup_target_error)"
if [[ -n "${backup_error}" ]]; then
  add_issue "backup-mount" "${backup_error}"
else
  observations+=("backup target ${backup_source:-available}")
  latest_backup="$(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'fantasy-*.dump' -printf '%T@|%p\n' 2>/dev/null | sort -nr | head -1 || true)"
  if [[ -z "${latest_backup}" ]]; then
    add_issue "backup" "no verified database backup exists"
  else
    backup_epoch="${latest_backup%%|*}"
    backup_age="$(( $(date +%s) - ${backup_epoch%.*} ))"
    if [[ "${backup_age}" -gt 129600 ]]; then
      add_issue "backup" "latest verified database backup is $((backup_age / 3600))h old"
    else
      observations+=("backup $((backup_age / 3600))h old")
    fi
  fi
fi

disk_used="$(df -P "${BACKUP_ROOT}" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')"
if [[ "${disk_used}" -ge 90 ]]; then
  add_issue "backup-disk" "backup disk is ${disk_used}% full"
fi

if [[ "$report_only" == false ]]; then source /ops/notify-state.sh; fi

report="${REPORT_ROOT}/ops-latest.txt"
{
  printf 'Laces Out operations report\nGenerated: %s\nStatus: %s\n\n' "$(timestamp)" "$([[ ${#issue_details[@]} -eq 0 ]] && echo healthy || echo attention)"
  printf 'Issues:\n'
  if [[ ${#issue_details[@]} -eq 0 ]]; then printf -- '- none\n'; else printf -- '- %s\n' "${issue_details[@]}"; fi
  printf '\nObservations:\n'
  printf -- '- %s\n' "${observations[@]:-none}"
} >"${report}"
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${report}"
chmod 0600 "${report}"
