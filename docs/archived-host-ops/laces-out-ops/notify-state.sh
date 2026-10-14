#!/usr/bin/env bash
# Sourced by sentinel.sh after collecting observations.
legacy_state_file="${STATE_ROOT}/sentinel.state"
notified_state_file="${STATE_ROOT}/sentinel.notified.state"
candidate_state_file="${STATE_ROOT}/sentinel.candidate.state"
candidate_count_file="${STATE_ROOT}/sentinel.candidate.count"
current_state="$(printf '%s\n' "${issue_keys[@]:-}" | sed '/^$/d' | sort -u)"
if [[ ! -f "${notified_state_file}" && -f "${legacy_state_file}" ]]; then
  cp "${legacy_state_file}" "${notified_state_file}"
fi
notified_state="$(test -f "${notified_state_file}" && sed '/^$/d' "${notified_state_file}" | sort -u || true)"
candidate_state="$(test -f "${candidate_state_file}" && sed '/^$/d' "${candidate_state_file}" | sort -u || true)"
candidate_count="$(cat "${candidate_count_file}" 2>/dev/null || echo 0)"

if [[ "${current_state}" == "${notified_state}" ]]; then
  : >"${candidate_state_file}"
  printf '0\n' >"${candidate_count_file}"
elif [[ "${current_state}" == "${candidate_state}" ]]; then
  candidate_count="$((candidate_count + 1))"
  printf '%s\n' "${candidate_count}" >"${candidate_count_file}"
else
  printf '%s\n' "${current_state}" >"${candidate_state_file}"
  candidate_count=1
  printf '1\n' >"${candidate_count_file}"
fi

# Debounce observations, then page only newly failing issue keys. Removing one issue must not
# re-send every persistent issue. A ROS recovery gets its own positive confirmation.
if [[ "${current_state}" != "${notified_state}" && "${candidate_count}" -ge "${alert_observations}" ]]; then
  declare -a new_details=()
  for index in "${!issue_keys[@]}"; do
    if ! grep -Fxq -- "${issue_keys[index]}" <<<"${notified_state}"; then
      new_details+=("${issue_details[index]}")
    fi
  done
  # Advance delivery state only after Telegram accepts all required messages.
  if [[ ${#new_details[@]} -gt 0 ]]; then
    send_telegram "$(printf 'Laces Out needs attention: %d new issue(s)\n' "${#new_details[@]}"; printf -- '- %s\n' "${new_details[@]}")" || return 1
  fi
  if grep -Fxq 'ros-projection-stale' <<<"${notified_state}" &&
     ! grep -Fxq 'ros-projection-stale' <<<"${current_state}" &&
     ! grep -Eq '^(database|ros-monitor-query|ros-monitor-config)$' <<<"${current_state}"; then
    send_telegram "Laces Out ROS projections are fresh again. New approved ROS numbers are published for every monitored league." || return 1
  fi
  printf '%s notification-state updated; new issues: %d\n' "$(timestamp)" "${#new_details[@]}"
  printf '%s\n' "${current_state}" >"${notified_state_file}"
  : >"${candidate_state_file}"
  printf '0\n' >"${candidate_count_file}"
fi
