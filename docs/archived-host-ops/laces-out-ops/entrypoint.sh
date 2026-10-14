#!/usr/bin/env sh
set -eu
mkdir -p "${LACES_OUT_BACKUP_ROOT:-/srv/backups/laces-out}" "${LACES_OUT_STATE_ROOT:-/var/lib/laces-out-ops}"
/ops/sentinel.sh || true
exec crond -f -l 2
