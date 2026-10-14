#!/usr/bin/env bash
set -Eeuo pipefail
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STATE_ROOT"' EXIT
alert_observations=2
ros_projection_max_age_hours=36
messages="${STATE_ROOT}/messages"
timestamp() { printf 'test'; }
# No live notification function or common.sh is loaded by this regression test.
send_telegram() { printf '%s\n' "$1" >>"${messages}"; }
add_issue() { issue_keys+=("$1"); issue_details+=("$2"); }
probe() {
  issue_keys=()
  issue_details=()
  observations=()
  source "${script_root}/ros-publication-issues.sh"
  source "${script_root}/notify-state.sh"
}
stale_ros_leagues=('League A: 219h old' 'League B: never published')
ros_job='completed|0||t'
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 1 ]]
grep -q 'completed, but 2 league(s)' "$messages"
grep -Fxq ros-projection-stale "${STATE_ROOT}/sentinel.notified.state"
! grep -Fxq ros-refresh-incomplete "${STATE_ROOT}/sentinel.notified.state"

# A nightly queued/running job never clears the ongoing publication incident. Completion with
# the same stale outputs adds detail to the report, not a second "new issue" notification.
for ros_job in 'created|0||f' 'active|0||t' 'completed|0||t'; do
  probe; probe
  grep -Fxq ros-projection-stale "${STATE_ROOT}/sentinel.notified.state"
done
[[ $(grep -c 'needs attention' "$messages") -eq 1 ]]
[[ "${issue_details[0]}" == *'completed, but 2 league(s)'* ]]
! grep -q 'fresh again' "$messages"

# Existing persisted state from the previous version loses only the duplicate symptom key.
printf '%s\n' ros-projection-stale ros-refresh-incomplete >"${STATE_ROOT}/sentinel.notified.state"
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 1 ]]
! grep -q 'fresh again' "$messages"

# A real refresh failure remains independently actionable and cannot masquerade as success.
ros_job='failed|4|Simulation failed|t'
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 2 ]]
grep -q 'Simulation failed' "$messages"
ros_job='active|0||t'
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 2 ]]
! grep -q 'fresh again' "$messages"

# Fresh published numbers, rather than job status, resolve the incident exactly once.
stale_ros_leagues=()
ros_job='completed|0||t'
probe; probe; probe
[[ $(grep -c 'fresh again' "$messages") -eq 1 ]]
stale_ros_leagues=('League A: 36h old')
ros_job='completed|0||f'
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 3 ]]
grep -q '36h old' "$messages"

# Missing queue history must not suppress known stale publication data.
ros_job=''
probe; probe
grep -Fxq ros-projection-stale "${STATE_ROOT}/sentinel.notified.state"
[[ $(grep -c 'needs attention' "$messages") -eq 3 ]]
printf 'ROS publication alert regression checks passed\n'
