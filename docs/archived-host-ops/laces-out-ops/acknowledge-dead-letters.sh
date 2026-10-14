#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh
require_backup_device

if [[ "${1:-}" != "--all" ]]; then
  printf 'Usage: %s --all\n' "$0" >&2
  exit 2
fi

stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
report="${REPORT_ROOT}/dead-letters-${stamp}.jsonl"
psql_query -At -c "
  select jsonb_build_object(
    'id', id,
    'queue', name,
    'data', data,
    'createdOn', created_on,
    'sourceName', source_name,
    'sourceId', source_id,
    'sourceRetryCount', source_retry_count
  )
    from pgboss.job
   where name like '%-dead-letter' and state = 'created'
   order by created_on, name;" >"${report}"

count="$(wc -l <"${report}" | tr -d ' ')"
if [[ "${count}" -gt 0 ]]; then
  psql_query -c "delete from pgboss.job where name like '%-dead-letter' and state = 'created';" >/dev/null
fi
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${report}"
chmod 0600 "${report}"
printf 'Archived and acknowledged %s dead-letter job(s) in %s\n' "${count}" "${report}"
