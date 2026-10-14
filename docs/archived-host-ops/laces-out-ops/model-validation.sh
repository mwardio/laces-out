#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh
if [[ -n "$(docker ps -q --filter label=laces-out.ros-release-validation=true)" ]]; then
  printf 'Dedicated ROS release validation is active; skipping scheduled model validation.\n'
  exit 0
fi
require_backup_device

repository="${LACES_OUT_REPOSITORY:-/workspace/laces-out}"
host_repository="${LACES_OUT_HOST_REPOSITORY:-/home/mack/projects/laces-out}"
node_image="${VALIDATION_NODE_IMAGE:-node:22.22.0-bookworm-slim}"
force=""
run_weekly=true
run_ros=true
for argument in "$@"; do
  case "${argument}" in
    --force) force="--force" ;;
    --weekly-only) run_ros=false ;;
    --ros-only) run_weekly=false ;;
    *) printf 'Unknown option: %s\n' "${argument}" >&2; exit 2 ;;
  esac
done

source_hash() {
  local family="$1"
  shift
  find "$@" -type f \( -name '*.ts' -o -name 'package.json' \) -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk -v family="${family}" '{print family ":" $1}'
}

run_validation() {
  local family="$1"
  local hash="$2"
  local command="$3"
  local state_file="${STATE_ROOT}/${family}-validation.hash"
  local prior="$(test -f "${state_file}" && cat "${state_file}" || true)"
  if [[ "${force}" != "--force" && "${hash}" == "${prior}" ]]; then
    printf '%s validation unchanged; skipping.\n' "${family}"
    return 0
  fi
  local stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
  local output="${REPORT_ROOT}/${family}-validation-${stamp}.json"
  local partial="${REPORT_ROOT}/.${family}-validation-${stamp}.partial.json"
  rm -f "${partial}"
  if docker run --rm \
      -v "${host_repository}:/app:ro" \
      -v "${REPORT_ROOT}:/reports" \
      -w /app \
      -e NPM_CONFIG_UPDATE_NOTIFIER=false \
      -e NPM_CONFIG_FUND=false \
      "${node_image}" bash -o pipefail -c "${command} > /reports/$(basename "${partial}")" \
      && jq -e . "${partial}" >/dev/null; then
    mv "${partial}" "${output}"
    chown "${OUTPUT_UID}:${OUTPUT_GID}" "${output}"
    chmod 0600 "${output}"
    printf '%s\n' "${hash}" >"${state_file}"
    send_telegram "Laces Out ${family} projection validation passed after a model/input-code change. No model was promoted automatically."
  else
    rm -f "${partial}"
    send_telegram "Laces Out ${family} projection validation FAILED. Existing published models remain in place; review the validator log before changing anything."
    return 1
  fi
}

if [[ "${run_weekly}" == true ]]; then
  weekly_hash="$(source_hash weekly \
    "${repository}/packages/projections/src" \
    "${repository}/packages/source-nflverse/src" \
    "${repository}/apps/worker/src/first-party-projections.ts" \
    "${repository}/apps/worker/src/first-party-projection-inputs.ts" \
    "${repository}/apps/worker/scripts/validate-first-party-projections.ts")"
  run_validation weekly "${weekly_hash}" \
    "./node_modules/.bin/tsx apps/worker/scripts/validate-first-party-projections.ts --summary"
fi

if [[ "${run_ros}" == true ]]; then
  ros_hash="$(source_hash ros \
    "${repository}/packages/projections/src/rest-of-season.ts" \
    "${repository}/apps/worker/src/first-party-ros-backtest.ts" \
    "${repository}/apps/worker/src/first-party-ros-candidates.ts" \
    "${repository}/apps/worker/src/first-party-ros-publication.ts" \
    "${repository}/apps/worker/scripts/validate-first-party-ros.ts")"
  run_validation ros "${ros_hash}" \
    "./node_modules/.bin/tsx apps/worker/scripts/validate-first-party-ros.ts --scoring-profile=full-ppr"
fi
