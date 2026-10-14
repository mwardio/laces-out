#!/usr/bin/env bash
set -Eeuo pipefail
STATE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STATE_ROOT"' EXIT
alert_observations=2
messages="${STATE_ROOT}/messages"
fail_delivery=false
send_telegram() { if $fail_delivery; then return 1; fi; printf '%s\n' "$1" >>"${messages}"; }
timestamp() { printf 'test'; }
probe() { source "$(dirname "${BASH_SOURCE[0]}")/notify-state.sh"; }
issue_keys=(ros-projection-stale dead-letters)
issue_details=('ROS old' 'Dead letters')
probe
[[ ! -f "$messages" ]]
probe
[[ $(grep -c 'needs attention' "$messages") -eq 1 ]]
! grep -Fxq -- '-' "$messages"
probe
[[ $(grep -c 'needs attention' "$messages") -eq 1 ]]
# Another issue appears, then recovers: ROS must not be paged again on recovery.
issue_keys+=(weekly-projection-failures)
issue_details+=('Weekly failed')
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 2 ]]
[[ $(grep -c 'ROS old' "$messages") -eq 1 ]]
issue_keys=(ros-projection-stale dead-letters)
issue_details=('ROS old' 'Dead letters')
probe; probe
[[ $(grep -c 'needs attention' "$messages") -eq 2 ]]
# Actual ROS recovery is confirmed once.
issue_keys=(dead-letters)
issue_details=('Dead letters')
probe; probe; probe
[[ $(grep -c 'fresh again' "$messages") -eq 1 ]]
# Failure to send must leave pending state for a later successful send.
issue_keys+=(ros-projection-stale)
issue_details+=('ROS old')
probe
fail_delivery=true
if (probe); then echo 'failed delivery incorrectly succeeded' >&2; exit 1; fi
! grep -Fxq ros-projection-stale "${STATE_ROOT}/sentinel.notified.state"
fail_delivery=false
probe
[[ $(grep -c 'needs attention' "$messages") -eq 3 ]]
# A failed database probe does not imply ROS recovered.
issue_keys=(database)
issue_details=('Database unavailable')
probe; probe
[[ $(grep -c 'fresh again' "$messages") -eq 1 ]]
printf 'Alert state regression checks passed\n'
