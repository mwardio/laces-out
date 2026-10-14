#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh
require_backup_device

lock="${STATE_ROOT}/backup.lock"
exec 9>"${lock}"
flock -n 9 || exit 0

stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
final="${BACKUP_ROOT}/fantasy-${stamp}.dump"
partial="$(mktemp -p "${BACKUP_ROOT}" ".fantasy-${stamp}.partial.XXXXXX")"
cleanup() { rm -f "${partial}"; }
on_error() {
  local code=$?
  trap - ERR
  send_telegram "Laces Out database backup failed. The prior verified archive remains untouched." || true
  exit "${code}"
}
trap cleanup EXIT
trap on_error ERR

docker exec "${POSTGRES_CONTAINER}" pg_dump \
  -U "${DB_USER}" -d "${DB_NAME}" --format=custom --compress=9 \
  --no-owner --no-privileges >"${partial}"

if [[ ! -s "${partial}" ]]; then
  send_telegram "Laces Out backup failed: pg_dump produced an empty archive."
  exit 1
fi
docker exec -i "${POSTGRES_CONTAINER}" pg_restore --list <"${partial}" >/dev/null

chmod 0600 "${partial}"
mv "${partial}" "${final}"
sha256sum "${final}" >"${final}.sha256"
chmod 0600 "${final}.sha256"
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${final}" "${final}.sha256"
ln -sfn "$(basename "${final}")" "${BACKUP_ROOT}/latest.dump"

find "${BACKUP_ROOT}" -maxdepth 1 -type f \
  \( -name 'fantasy-*.dump' -o -name 'fantasy-*.dump.sha256' \) \
  -mtime +14 -delete

printf 'Verified Laces Out backup: %s (%s)\n' "${final}" "$(du -h "${final}" | awk '{print $1}')"
