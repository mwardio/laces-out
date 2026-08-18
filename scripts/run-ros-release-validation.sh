#!/usr/bin/env bash
set -uo pipefail

# Durable, resumable publication-grade ROS validation runner.
#
# Each profile writes to a temporary file and is promoted atomically only after valid JSON exists.
# Completed reports are never removed by a later profile failure. A non-blocking lock prevents two
# release batches from competing for CPU and memory on the same host.

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly run_id="${ROS_VALIDATION_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
readonly concurrency="${ROS_VALIDATION_CONCURRENCY:-3}"
source_model_version="$(
  sed -n 's/^export const FIRST_PARTY_ROS_MODEL_VERSION = "\([^"]*\)";.*/\1/p' \
    "${repo_root}/packages/projections/src/rest-of-season.ts" | head -n 1
)"
readonly model_version="${ROS_VALIDATION_MODEL_VERSION:-${source_model_version:-unknown-model}}"
readonly report_dir="${repo_root}/reports/ros-release-${model_version}-${run_id}"
readonly lock_file="${XDG_RUNTIME_DIR:-/tmp}/laces-out-ros-release-validation.lock"
readonly profiles_default="full-ppr half-ppr standard espn-standard-2pt espn-standard-2pt-nxm espn-ppr-yardage-bonus-6pt-pass"
read -r -a profiles <<< "${ROS_VALIDATION_PROFILES:-${profiles_default}}"
lock_backend=""

if [[ ! "${concurrency}" =~ ^[1-3]$ ]]; then
  printf 'ROS_VALIDATION_CONCURRENCY must be 1, 2, or 3\n' >&2
  exit 2
fi

mkdir -p "${report_dir}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"${lock_file}"
  if ! flock -n 9; then
    printf 'Another publication-grade ROS validation batch is already running.\n' >&2
    exit 3
  fi
  lock_backend="flock"
elif command -v shlock >/dev/null 2>&1; then
  if ! shlock -f "${lock_file}" -p "$$"; then
    printf 'Another publication-grade ROS validation batch is already running.\n' >&2
    exit 3
  fi
  lock_backend="shlock"
else
  printf 'No supported singleton lock utility is available (flock or shlock required).\n' >&2
  exit 69
fi

# A killed host process may leave only explicitly marked partial files. With the singleton lock in
# hand, no live batch can own them, so they are safe to discard before resuming completed profiles.
shopt -s nullglob
partial_files=("${report_dir}"/*.partial.*)
if ((${#partial_files[@]} > 0)); then
  rm -f -- "${partial_files[@]}"
fi
shopt -u nullglob

cd "${repo_root}"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "${report_dir}/batch.log"
}

resource_snapshot() {
  if [[ -r /proc/loadavg && -r /proc/meminfo ]]; then
    printf 'load=%s available_kib=%s' \
      "$(cut -d' ' -f1-3 /proc/loadavg)" \
      "$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)"
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    local load available_percent
    load="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
    available_percent="$(memory_pressure 2>/dev/null | awk -F': ' '/System-wide memory free percentage:/ { print $2; exit }')"
    printf 'load=%s available_percent=%s' "${load:-unknown}" "${available_percent:-unknown}"
    return
  fi

  printf 'load=unknown available=unknown'
}

watch_resources() {
  while sleep 1800; do
    log "RESOURCE $(resource_snapshot)"
  done
}

run_profile() {
  local profile="$1"
  local final_json="${report_dir}/${profile}.json"
  local final_log="${report_dir}/${profile}.log"
  local exit_file="${report_dir}/${profile}.exit"
  local temp_json="${final_json}.partial.$$"
  local temp_log="${final_log}.partial.$$"
  local status=0

  if [[ -s "${final_json}" ]] &&
    jq -e --arg model "${source_model_version}" '
      .champion.modelVersion == $model and
      .report.playersPerPosition >= 8 and
      .report.maximumForecasts >= 6000 and
      .report.forecasts >= 2965 and
      (.sources | type == "array" and length > 0)
    ' "${final_json}" >/dev/null 2>&1; then
    status="$(cat "${exit_file}" 2>/dev/null || printf '0')"
    log "SKIP_COMPLETE profile=${profile} status=${status}"
    # Exit 1 is the validator's ordinary "evidence withheld" result, not an infrastructure error.
    return 0
  fi

  log "START profile=${profile} players_per_position=8 max_forecasts=6000"
  npm run --silent ros:validate -w @laces-out/worker -- \
    --scoring-profile="${profile}" --players-per-position=8 --max-forecasts=6000 --full \
    >"${temp_json}" 2>"${temp_log}" || status=$?

  if jq -e . "${temp_json}" >/dev/null 2>&1; then
    mv -f "${temp_json}" "${final_json}"
    mv -f "${temp_log}" "${final_log}"
    printf '%s\n' "${status}" >"${exit_file}"
    log "END profile=${profile} validation_status=${status}"
    return 0
  else
    log "INVALID_JSON profile=${profile} status=${status} partial=${temp_json}"
    status=90
  fi
  mv -f "${temp_log}" "${final_log}"
  printf '%s\n' "${status}" >"${exit_file}"
  log "END profile=${profile} infrastructure_status=${status}"
  return "${status}"
}

watch_resources &
watchdog_pid=$!
cleanup() {
  kill "${watchdog_pid}" 2>/dev/null || true
  if [[ "${lock_backend}" == "shlock" ]]; then
    rm -f -- "${lock_file}"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 143' INT TERM

overall_status=0
for ((offset = 0; offset < ${#profiles[@]}; offset += concurrency)); do
  pids=()
  wave_profiles=()
  for ((index = offset; index < offset + concurrency && index < ${#profiles[@]}; index++)); do
    profile="${profiles[index]}"
    run_profile "${profile}" &
    pids+=("$!")
    wave_profiles+=("${profile}")
  done

  for ((index = 0; index < ${#pids[@]}; index++)); do
    if ! wait "${pids[index]}"; then
      overall_status=1
    fi
  done
  log "WAVE_COMPLETE profiles=${wave_profiles[*]}"
done

log "BATCH_COMPLETE status=${overall_status} report_dir=${report_dir}"
exit "${overall_status}"
