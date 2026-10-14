#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh
require_backup_device

lock="${STATE_ROOT}/restore-verify.lock"
exec 9>"${lock}"
flock -n 9 || exit 0

archive="$(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'fantasy-*.dump' -printf '%T@|%p\n' | sort -nr | head -1 | cut -d'|' -f2-)"
if [[ -z "${archive}" ]]; then
  send_telegram "Laces Out restore verification failed: no database archive exists."
  exit 1
fi
sha256sum --check "${archive}.sha256" >/dev/null

verify_db="fantasy_restore_verify"
cleanup() {
  docker exec "${POSTGRES_CONTAINER}" dropdb -U "${DB_USER}" --if-exists --force "${verify_db}" >/dev/null 2>&1 || true
}
on_error() {
  local code=$?
  trap - ERR
  send_telegram "Laces Out monthly restore verification failed. Production was not modified." || true
  exit "${code}"
}
trap cleanup EXIT
trap on_error ERR
cleanup
docker exec "${POSTGRES_CONTAINER}" createdb -U "${DB_USER}" -T template0 "${verify_db}"
docker exec -i "${POSTGRES_CONTAINER}" pg_restore -U "${DB_USER}" -d "${verify_db}" \
  --exit-on-error --no-owner --no-privileges <"${archive}" >/dev/null

table_count="$(docker exec "${POSTGRES_CONTAINER}" psql -X -At -U "${DB_USER}" -d "${verify_db}" -c "select count(*) from information_schema.tables where table_schema = 'public';")"
source_count="$(docker exec "${POSTGRES_CONTAINER}" psql -X -At -U "${DB_USER}" -d "${verify_db}" -c "select count(*) from data_sources;")"
if [[ "${table_count}" -lt 20 || "${source_count}" -lt 1 ]]; then
  send_telegram "Laces Out restore verification failed integrity checks (${table_count} tables, ${source_count} sources)."
  exit 1
fi

report="${REPORT_ROOT}/restore-verify-$(date --utc +%Y%m%dT%H%M%SZ).txt"
printf 'Archive: %s\nVerified: %s\nTables: %s\nData sources: %s\n' \
  "${archive}" "$(timestamp)" "${table_count}" "${source_count}" >"${report}"
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${report}"
chmod 0600 "${report}"
send_telegram "Laces Out monthly restore test passed: ${table_count} tables and ${source_count} data sources restored cleanly."
