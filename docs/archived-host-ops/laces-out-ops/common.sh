#!/usr/bin/env bash
set -Eeuo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-laces-out-postgres-1}"
DB_NAME="${DB_NAME:-fantasy}"
DB_USER="${DB_USER:-fantasy}"
BACKUP_ROOT="${LACES_OUT_BACKUP_ROOT:-/srv/backups/laces-out}"
STATE_ROOT="${LACES_OUT_STATE_ROOT:-/var/lib/laces-out-ops}"
REPORT_ROOT="${BACKUP_ROOT}/reports"
OUTPUT_UID="${OUTPUT_UID:-1000}"
OUTPUT_GID="${OUTPUT_GID:-1000}"
EXPECTED_BACKUP_DEVICE="${LACES_OUT_BACKUP_DEVICE:-}"
EXPECTED_BACKUP_VOLUME_ID="${LACES_OUT_BACKUP_VOLUME_ID:-}"
BACKUP_VOLUME_MARKER="${LACES_OUT_BACKUP_VOLUME_MARKER:-${BACKUP_ROOT}/.volume-id}"

mkdir -p "${BACKUP_ROOT}" "${REPORT_ROOT}" "${STATE_ROOT}"
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${BACKUP_ROOT}" "${REPORT_ROOT}"
chmod 0700 "${BACKUP_ROOT}" "${STATE_ROOT}"

psql_query() {
  docker exec "${POSTGRES_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" "$@"
}

send_telegram() {
  local message="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    printf 'Telegram is not configured; message suppressed: %s\n' "${message}" >&2
    return 0
  fi
  curl --fail --silent --show-error --max-time 20 \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message:0:4000}" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null
}

timestamp() {
  date --utc +%Y-%m-%dT%H:%M:%SZ
}

backup_target_error() {
  local actual_source actual_volume_id
  actual_source="$(findmnt -no SOURCE -T "${BACKUP_ROOT}" 2>/dev/null || true)"

  if [[ -n "${EXPECTED_BACKUP_VOLUME_ID}" ]]; then
    if [[ ! -r "${BACKUP_VOLUME_MARKER}" ]]; then
      printf 'backup volume marker is missing on %s (%s)' \
        "${BACKUP_ROOT}" "${actual_source:-no mounted filesystem}"
      return 0
    fi

    actual_volume_id="$(tr -d '\r\n' <"${BACKUP_VOLUME_MARKER}")"
    if [[ "${actual_volume_id}" != "${EXPECTED_BACKUP_VOLUME_ID}" ]]; then
      printf 'backup volume identity mismatch on %s (%s)' \
        "${BACKUP_ROOT}" "${actual_source:-no mounted filesystem}"
    fi
    return 0
  fi

  # Backward-compatible fallback for deployments that still configure a
  # device path. Prefer LACES_OUT_BACKUP_VOLUME_ID because /dev/sdX names can
  # change after a reboot or USB device reorder.
  if [[ -n "${EXPECTED_BACKUP_DEVICE}" && "${actual_source}" != "${EXPECTED_BACKUP_DEVICE}" ]]; then
    printf 'backup target is on %s; expected %s' \
      "${actual_source:-no mounted filesystem}" "${EXPECTED_BACKUP_DEVICE}"
  fi
}

require_backup_device() {
  local error
  error="$(backup_target_error)"
  if [[ -n "${error}" ]]; then
    send_telegram "Laces Out backup task refused to run: ${error}."
    return 1
  fi
}
