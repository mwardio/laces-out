#!/bin/bash

set -u
set -o pipefail
umask 077

readonly EXPECTED_ROOT="/Users/laces-worker/laces-worker"
readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly EXPECTED_OS="Darwin"
readonly EXPECTED_ARCH="arm64"
readonly PLATFORM_LABEL="Darwin/ARM64"
readonly NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
readonly NPM_BIN="/opt/homebrew/opt/node@22/bin/npm"

fail() {
  printf 'laces-worker: %s\n' "$1" >&2
  exit "${2:-1}"
}

physical_directory() {
  (cd "$1" 2>/dev/null && pwd -P)
}

root=${1:-}
job_id=${2:-}
action=${3:-}

[ "$root" = "$EXPECTED_ROOT" ] || fail "worker root is not the pinned root" 78
[[ "$job_id" =~ ^job-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9a-f]{12}$ ]] ||
  fail "invalid job ID" 64
case "$action" in
  allocate | run | cleanup) ;;
  *) fail "invalid worker action" 64 ;;
esac

[ -d "$root" ] && [ ! -L "$root" ] || fail "worker root is missing or is a symlink" 78
[ -O "$root" ] && [ -w "$root" ] || fail "worker root is not owned and writable by this user" 78
[ "$(physical_directory "$root")" = "$EXPECTED_ROOT" ] || fail "worker root canonical path mismatch" 78

jobs_root="$root/jobs"
if [ ! -e "$jobs_root" ]; then
  mkdir -m 700 "$jobs_root" || fail "cannot create jobs root" 73
fi
[ -d "$jobs_root" ] && [ ! -L "$jobs_root" ] || fail "jobs root is not a real directory" 78
[ "$(physical_directory "$jobs_root")" = "$EXPECTED_ROOT/jobs" ] ||
  fail "jobs root canonical path mismatch" 78

job_dir="$jobs_root/$job_id"
[ "$job_dir" = "$EXPECTED_ROOT/jobs/$job_id" ] || fail "job path mismatch" 78

verify_existing_job() {
  [ -d "$job_dir" ] && [ ! -L "$job_dir" ] || fail "job does not exist or is unsafe" 66
  [ -O "$job_dir" ] || fail "job is not owned by this user" 78
  [ "$(physical_directory "$job_dir")" = "$EXPECTED_ROOT/jobs/$job_id" ] ||
    fail "job canonical path mismatch" 78
}

if [ "$action" = allocate ]; then
  [ ! -e "$job_dir" ] && [ ! -L "$job_dir" ] || fail "job already exists" 73
  mkdir -m 700 "$job_dir" || fail "cannot allocate job" 73
  mkdir -m 700 "$job_dir/control" "$job_dir/source" "$job_dir/logs" ||
    fail "cannot initialize job" 73
  printf '%s\n' "$job_id"
  exit 0
fi

verify_existing_job

if [ "$action" = cleanup ]; then
  /bin/rm -rf -- "$job_dir" || fail "cannot remove verified job" 73
  printf '%s\n' "$job_id"
  exit 0
fi

control_dir="$job_dir/control"
source_dir="$job_dir/source"
logs_dir="$job_dir/logs"
archive="$control_dir/snapshot.tar.gz"
argv_file="$control_dir/command.argv"
metadata_source="$control_dir/metadata.env"
artifact_config="$control_dir/remote-validation-artifacts.txt"

[ -f "$archive" ] && [ ! -L "$archive" ] || fail "snapshot archive is missing or unsafe" 66
[ -f "$argv_file" ] && [ ! -L "$argv_file" ] || fail "command argv is missing or unsafe" 66
[ -f "$metadata_source" ] && [ ! -L "$metadata_source" ] || fail "metadata is missing or unsafe" 66
[ -f "$artifact_config" ] && [ ! -L "$artifact_config" ] || fail "artifact config is missing or unsafe" 66
[ -d "$source_dir" ] && [ ! -L "$source_dir" ] || fail "source directory is unsafe" 78
[ -z "$(find "$source_dir" -mindepth 1 -print -quit)" ] || fail "source directory is not empty" 73

members_file="$control_dir/archive-members.txt"
tar -tzf "$archive" >"$members_file" || fail "snapshot archive cannot be listed" 65
while IFS= read -r member; do
  [ -n "$member" ] || fail "snapshot contains an empty member" 65
  case "$member" in
    /* | .. | ../* | */../* | */..) fail "snapshot contains an unsafe member" 65 ;;
  esac
done <"$members_file"

tar -xzf "$archive" -C "$source_dir" --no-same-owner || fail "snapshot extraction failed" 65
cp "$metadata_source" "$job_dir/metadata.env" || fail "cannot record metadata" 73

actual_os=$(uname -s)
actual_arch=$(uname -m)
actual_node=$("$NODE_BIN" --version 2>/dev/null || true)
{
  printf 'remote_os=%s\n' "$actual_os"
  printf 'remote_architecture=%s\n' "$actual_arch"
  printf 'remote_node_version=%s\n' "$actual_node"
  printf 'remote_job_directory=%s\n' "$job_dir"
  printf 'started_at_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
} >>"$job_dir/metadata.env"

install_status=0
command_status=125
artifact_status=0
bundle_status=0

npm_cache="$root/npm-cache"
if [ ! -e "$npm_cache" ]; then
  mkdir -m 700 "$npm_cache" || fail "cannot create persistent npm cache" 73
fi
[ -d "$npm_cache" ] && [ ! -L "$npm_cache" ] || fail "persistent npm cache is unsafe" 78
[ "$(physical_directory "$npm_cache")" = "$EXPECTED_ROOT/npm-cache" ] ||
  fail "npm cache canonical path mismatch" 78

(
  set -e
  printf '[laces-mini %s] validating runtime\n' "$PLATFORM_LABEL"
  [ "$actual_os" = "$EXPECTED_OS" ]
  [ "$actual_arch" = "$EXPECTED_ARCH" ]
  [ "$actual_node" = "$EXPECTED_NODE_VERSION" ]
  printf '[laces-mini %s] npm ci --cache %s\n' "$PLATFORM_LABEL" "$npm_cache"
  cd "$source_dir"
  "$NPM_BIN" ci --cache "$npm_cache" --prefer-offline --no-audit --no-fund
) 2>&1 | tee "$logs_dir/install.log"
install_status=${PIPESTATUS[0]}

declare -a command_argv=()
if [ "$install_status" -eq 0 ]; then
  while IFS= read -r -d '' argument; do
    command_argv[${#command_argv[@]}]="$argument"
  done <"$argv_file"
  [ "${#command_argv[@]}" -gt 0 ] || fail "requested command is empty" 64

  (
    cd "$source_dir" || exit 72
    export CI=1
    export LACES_REMOTE_PLATFORM=darwin-arm64
    export LACES_VITEST_MAX_WORKERS=2
    export GOMAXPROCS=2
    export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    printf '[laces-mini %s] executing requested command (%s arguments)\n' \
      "$PLATFORM_LABEL" "${#command_argv[@]}"
    "${command_argv[@]}"
  ) 2>&1 | tee "$logs_dir/command.log"
  command_status=${PIPESTATUS[0]}
else
  printf '[laces-mini %s] command not run because npm ci exited %s\n' \
    "$PLATFORM_LABEL" "$install_status" | tee "$logs_dir/command.log"
fi

selected_artifacts="$control_dir/selected-artifacts.txt"
: >"$selected_artifacts"
while IFS= read -r artifact_path || [ -n "$artifact_path" ]; do
  case "$artifact_path" in
    '' | \#*) continue ;;
    /* | .. | ../* | */../* | */..) artifact_status=65; break ;;
  esac
  candidate="$source_dir/$artifact_path"
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    if [ -L "$candidate" ] || [ -n "$(find "$candidate" -type l -print -quit 2>/dev/null)" ]; then
      printf 'refusing artifact containing symbolic links: %s\n' "$artifact_path" \
        >>"$logs_dir/artifacts.log"
      artifact_status=65
      break
    fi
    printf '%s\n' "$artifact_path" >>"$selected_artifacts"
  fi
done <"$artifact_config"

if [ "$artifact_status" -eq 0 ]; then
  tar -czf "$job_dir/artifacts.tar.gz" -C "$source_dir" -T "$selected_artifacts" \
    >"$logs_dir/artifacts.log" 2>&1 || artifact_status=$?
fi
if [ ! -f "$job_dir/artifacts.tar.gz" ]; then
  tar -czf "$job_dir/artifacts.tar.gz" -T /dev/null || artifact_status=$?
fi

if [ "$install_status" -ne 0 ]; then
  effective_status=$install_status
else
  effective_status=$command_status
fi
if [ "$effective_status" -eq 0 ] && [ "$artifact_status" -ne 0 ]; then
  effective_status=$artifact_status
fi

{
  printf 'platform_label=%s\n' "$PLATFORM_LABEL"
  printf 'install_exit_status=%s\n' "$install_status"
  printf 'command_exit_status=%s\n' "$command_status"
  printf 'artifact_exit_status=%s\n' "$artifact_status"
  printf 'effective_exit_status=%s\n' "$effective_status"
  printf 'finished_at_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
} >"$job_dir/result.env"

tar -czf "$job_dir/results.tar.gz" -C "$job_dir" \
  logs metadata.env result.env artifacts.tar.gz || bundle_status=$?
if [ "$effective_status" -eq 0 ] && [ "$bundle_status" -ne 0 ]; then
  effective_status=$bundle_status
fi

exit "$effective_status"
