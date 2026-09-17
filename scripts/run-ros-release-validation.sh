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
readonly report_dir="${ROS_VALIDATION_REPORT_DIR:-${repo_root}/reports/ros-release-${model_version}-${run_id}}"
readonly outcome_dir="${ROS_VALIDATION_OUTCOME_CACHE:-${report_dir}/outcomes}"
readonly season="${ROS_VALIDATION_SEASON:-$(date -u +%Y)}"
corpus_identity="${ROS_VALIDATION_CORPUS_SHA:-}"
readonly lock_file="${XDG_RUNTIME_DIR:-/tmp}/laces-out-ros-release-validation.lock"
readonly profiles_default="full-ppr half-ppr standard espn-standard-2pt espn-standard-2pt-nxm espn-ppr-yardage-bonus-6pt-pass espn-ppr-4pt-pass espn-half-ppr-yardage-bonus-4pt-pass yahoo-half-ppr yahoo-half-ppr-return-yards-fg-distance"
read -r -a profiles <<< "${ROS_VALIDATION_PROFILES:-${profiles_default}}"
lock_backend=""
if ((${#profiles[@]} == 0)); then
  printf 'At least one ROS validation profile is required\n' >&2
  exit 2
fi

if [[ ! "${concurrency}" =~ ^[1-3]$ ]]; then
  printf 'ROS_VALIDATION_CONCURRENCY must be 1, 2, or 3\n' >&2
  exit 2
fi
if [[ ! "${season}" =~ ^[0-9]{4}$ ]] || ((season < 2007 || season > 2200)); then
  printf 'ROS_VALIDATION_SEASON must be a supported four-digit target season\n' >&2
  exit 2
fi
if [[ -n "${corpus_identity}" && ! "${corpus_identity}" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'ROS_VALIDATION_CORPUS_SHA must be a SHA-256 corpus identity\n' >&2
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
# Pin the running semantic identities, so a same-name profile edit cannot reuse retired evidence.
profiles_manifest="$(node --import tsx --input-type=module -e '
  import { rosScoringProfileCatalog } from "./packages/projections/src/ros-scoring-profiles.ts";
  console.log(JSON.stringify(Object.fromEntries(rosScoringProfileCatalog().map(p => [p.key, p.digest]))));
')" || exit 2
protocol="$(node --import tsx --input-type=module -e '
  import { rosSharedCorpusRequest } from "./apps/worker/src/ros-shared-corpus-runner.ts";
  console.log(JSON.stringify(rosSharedCorpusRequest(Number(process.argv[1]))));
' "${season}")" || exit 2
protocol_identity="$(jq -er '.identity' <<< "${protocol}")" || exit 2
source_seasons="$(jq -er '.protocol.sourceSeasons | join(",")' <<< "${protocol}")" || exit 2
held_out_seasons="$(jq -er '.protocol.heldOutSeasons | join(",")' <<< "${protocol}")" || exit 2
for profile in "${profiles[@]}"; do
  if ! jq -e --arg profile "${profile}" 'has($profile)' <<< "${profiles_manifest}" >/dev/null; then
    printf 'Unknown ROS scoring profile: %s\n' "${profile}" >&2
    exit 2
  fi
done

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
  local sleeper_pid=""
  trap 'if [[ -n "${sleeper_pid}" ]]; then kill "${sleeper_pid}" 2>/dev/null || true; wait "${sleeper_pid}" 2>/dev/null || true; fi; exit 0' INT TERM
  while true; do
    sleep 1800 &
    sleeper_pid=$!
    wait "${sleeper_pid}" || return
    sleeper_pid=""
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
  local digest
  digest="$(jq -r --arg profile "${profile}" '.[$profile]' <<< "${profiles_manifest}")"
  local status=0
  local source_options=("--outcome-cache=${outcome_dir}")
  if [[ -n "${corpus_identity}" ]]; then
    source_options+=("--replay-corpus=${corpus_identity}")
  elif [[ -n "${ROS_VALIDATION_SOURCE_CACHE:-}" ]]; then
    source_options+=("--source-cache=${ROS_VALIDATION_SOURCE_CACHE}" --offline)
  fi

  if [[ -s "${final_json}" ]] &&
    [[ "$(cat "${final_json}.protocol" 2>/dev/null)" == "${protocol_identity}" ]] &&
    jq -e --arg model "${source_model_version}" --arg digest "${digest}" --arg corpus "${corpus_identity}" '
      .champion.modelVersion == $model and
      .scoringProfile.digest == $digest and
      (.outcomeCorpusIdentity | type == "string" and test("^[a-f0-9]{64}$")) and
      ($corpus == "" or .outcomeCorpusIdentity == $corpus) and
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
    --scoring-profile="${profile}" --seasons="${source_seasons}" --holdouts="${held_out_seasons}" \
    --players-per-position=8 --max-forecasts=6000 --full "${source_options[@]}" \
    >"${temp_json}" 2>"${temp_log}" || status=$?

  if ((status <= 1)) && jq -e --arg corpus "${corpus_identity}" '
    (.outcomeCorpusIdentity | type == "string" and test("^[a-f0-9]{64}$")) and
    ($corpus == "" or .outcomeCorpusIdentity == $corpus)
  ' "${temp_json}" >/dev/null 2>&1; then
    mv -f "${temp_json}" "${final_json}"
    mv -f "${temp_log}" "${final_log}"
    printf '%s\n' "${status}" >"${exit_file}"
    printf '%s\n' "${protocol_identity}" >"${final_json}.protocol"
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
  wait "${watchdog_pid}" 2>/dev/null || true
  if [[ "${lock_backend}" == "shlock" ]]; then
    rm -f -- "${lock_file}"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 143' INT TERM

overall_status=0
# Only one profile builds football outcomes. Every later profile is cache-only, including when
# the first profile's statistical gate withholds its report. Infrastructure failures stop here.
if [[ -z "${corpus_identity}" ]]; then
  if ! run_profile "${profiles[0]}"; then
    log "SHARED_BUILD_FAILED"
    exit 1
  fi
  corpus_identity="$(jq -er '.outcomeCorpusIdentity' "${report_dir}/${profiles[0]}.json")" || exit 1
fi
log "SHARED_CORPUS identity=${corpus_identity} protocol=${protocol_identity}"
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
