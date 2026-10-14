#!/usr/bin/env bash
set -Eeuo pipefail
source /ops/common.sh
require_backup_device

on_error() {
  local code=$?
  trap - ERR
  send_telegram "Laces Out projection scorecard failed to generate. Published projections were not changed." || true
  exit "${code}"
}
trap on_error ERR

scorecard_json="$(psql_query -At -c "
  with batch_at as (
    select max(created_at) as value
      from projection_model_runs
     where horizon = 'week' and quality_state = 'publishable'
  ), latest as (
    select r.*
      from projection_model_runs r, batch_at b
     where r.horizon = 'week'
       and r.quality_state = 'publishable'
       and r.created_at = b.value
  ), position_rows as (
    select entry.key as position, entry.value as choice
      from latest
      cross join lateral jsonb_each(metrics #> '{playerChampionPolicy,byPosition}') entry
     where jsonb_typeof(entry.value) = 'object'
  ), positions as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'position', position,
             'strategy', strategy,
             'samples', samples,
             'modelMae', model_mae,
             'baselineMae', baseline_mae,
             'improvementPct', improvement_pct
           ) order by position), '[]'::jsonb) as value
      from (
        select position,
               mode() within group (order by choice->>'strategy') as strategy,
               round(avg((choice->>'samples')::numeric), 0) as samples,
               round(avg((choice->>'modelMae')::numeric), 3) as model_mae,
               round(avg((choice->>'baselineMae')::numeric), 3) as baseline_mae,
               round(avg(100 * ((choice->>'baselineMae')::numeric - (choice->>'modelMae')::numeric)
                 / nullif((choice->>'baselineMae')::numeric, 0)), 2) as improvement_pct
          from position_rows
         group by position
      ) grouped
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'batchAt', min(created_at),
    'season', max(season),
    'targetWeeks', to_jsonb(array_agg(distinct target_week order by target_week)),
    'modelVersion', min(model_version),
    'profiles', count(*),
    'playersPublished', sum(players_published),
    'playerMae', round(avg((metrics #>> '{player,mae}')::numeric), 3),
    'playerBias', round(avg((metrics #>> '{player,bias}')::numeric), 3),
    'playerCoverage', round(avg((metrics #>> '{player,intervalCoverage}')::numeric), 4),
    'defenseMae', round(avg((metrics #>> '{defense,mae}')::numeric), 3),
    'defenseBias', round(avg((metrics #>> '{defense,bias}')::numeric), 3),
    'defenseCoverage', round(avg((metrics #>> '{defense,intervalCoverage}')::numeric), 4),
    'positions', (select value from positions)
  )
  from latest;")"

if [[ -z "${scorecard_json}" || "${scorecard_json}" == "null" ]]; then
  send_telegram "Laces Out projection scorecard: no publishable weekly model run is available."
  exit 1
fi

scorecard_hash="$(printf '%s\n' "${scorecard_json}" | jq -c 'del(.generatedAt)' | sha256sum | awk '{print $1}')"
scorecard_state="${STATE_ROOT}/projection-scorecard.hash"
prior_hash="$(test -f "${scorecard_state}" && cat "${scorecard_state}" || true)"
if [[ "${scorecard_hash}" == "${prior_hash}" && "${1:-}" != "--force" ]]; then
  printf 'Projection scorecard inputs are unchanged; skipping.\n'
  exit 0
fi

stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
json_file="${REPORT_ROOT}/projection-scorecard-${stamp}.json"
markdown_file="${REPORT_ROOT}/projection-scorecard-${stamp}.md"
printf '%s\n' "${scorecard_json}" | jq . >"${json_file}"
printf '%s\n' "${scorecard_json}" | jq -r '
  "# Weekly projection scorecard\n\n" +
  "Generated: " + .generatedAt + "\n\n" +
  "Model: `" + .modelVersion + "` | Season " + (.season|tostring) +
  " | Week(s) " + (.targetWeeks|join(", ")) + " | " + (.profiles|tostring) + " scoring profiles\n\n" +
  "| Group | MAE | Bias | 70% interval coverage |\n|---|---:|---:|---:|\n" +
  "| Players | " + (.playerMae|tostring) + " | " + (.playerBias|tostring) + " | " + ((.playerCoverage*100)|round|tostring) + "% |\n" +
  "| D/ST | " + (.defenseMae|tostring) + " | " + (.defenseBias|tostring) + " | " + ((.defenseCoverage*100)|round|tostring) + "% |\n\n" +
  "| Position | Strategy | Model MAE | Baseline MAE | Improvement | Samples |\n|---|---|---:|---:|---:|---:|\n" +
  ([.positions[] | "| " + .position + " | " + .strategy + " | " + (.modelMae|tostring) + " | " + (.baselineMae|tostring) + " | " + (.improvementPct|tostring) + "% | " + (.samples|tostring) + " |"] | join("\n")) + "\n"
' >"${markdown_file}"
chown "${OUTPUT_UID}:${OUTPUT_GID}" "${json_file}" "${markdown_file}"
chmod 0600 "${json_file}" "${markdown_file}"
printf '%s\n' "${scorecard_hash}" >"${scorecard_state}"

summary="$(printf '%s\n' "${scorecard_json}" | jq -r '"Laces Out projection scorecard: player MAE " + (.playerMae|tostring) + ", D/ST MAE " + (.defenseMae|tostring) + ", player interval coverage " + ((.playerCoverage*100)|round|tostring) + "%. All reported runs passed the publication gate."')"
send_telegram "${summary}"
