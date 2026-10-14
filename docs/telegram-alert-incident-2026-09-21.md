# Telegram operational alerts — September 21, 2026

The 17:15 UTC operations report contained two misleading publication alerts and nine retained
failed-job records. The application had current league forecasts; the monitor's publication checks
had fallen behind the release contracts.

## Evidence

- All 16 supported leagues had complete ROS publications from September 21 at 06:30:22.510 UTC,
  each containing 856 player rows. The nightly job completed at 08:49:23 UTC without a retry.
- The ROS query still assumed the legacy distribution rail and scoring mapping v8. Production uses
  `point-v1` and scoring mapping v9. It consequently reported every supported league as never
  published, despite their current admitted point forecasts.
- All 16 supported leagues had current Week 2 and Week 3 weekly sets, with all six positions
  published and no withheld positions. The latest checked sets were created at 17:13:24 and
  17:13:48 UTC, respectively. The global reference-profile model run was rejected, but each exact
  league's independent publication checks passed. The monitor incorrectly treated the reference
  rejection as a league publication failure.
- Weekly sets' `fetched_at` value was September 17 because it represents the oldest selected
  source verification, including immutable historical inputs. Their publication time is
  `created_at`; changing the monitor does not relabel or refresh any forecast.
- One IDP scoring configuration remains explicitly unsupported. Provider connections, both public
  readiness endpoints, the worker heartbeat, and the verified backup were healthy.
- Two ROS dead letters were from September 15–16 snapshot/identity errors. One league-sync dead
  letter was a September 16 database connection timeout. Subsequent ROS publications and the
  affected league's successful syncs establish recovery.
- Six weekly dead letters accumulated between 15:00 and 15:24 UTC on September 21. One retained
  aggregate error records HTTP 504 responses for both upstream weekly-stat sources. Five retain
  only a generic isolated-process error; their precise causes cannot be reconstructed from those
  records. Later source checks and repeated publication jobs succeeded, with zero current source
  failure counters. The 504 is confirmed for one job, not asserted as the cause of all six.

## Repair

The ROS query now supports point-only admission and current scoring mapping. The sentinel obtains
its rail from the running API, so a monitor image cannot silently select an obsolete default.
Unknown configuration or failed inspection remains an actionable monitoring error.

Weekly monitoring now checks actual publication for each active league's current week, including
the latest run's league-specific withholding evidence, current model and policy, supported versus
published positions, and persisted player rows. An old complete set or a fresh peer cannot conceal
a failed or incomplete current publication. The reference-profile diagnostic remains labeled in
the report without overriding exact-league publication truth.

The host integration is retained in
[`telegram-alert-monitoring-2026-09-21.patch`](./telegram-alert-monitoring-2026-09-21.patch).
The shared read-only checks live in `scripts/projection-publication-issues.sh`. The host's new
`--report-only` mode verifies production without sending a message or modifying notification state.
The normal notification debounce remains unchanged.

All nine reviewed dead letters were archived, including complete original job data and errors, at
`/srv/backups/laces-out/reports/dead-letters-reviewed-20260921.jsonl` with mode 0600. The verified
SHA-256 is `b79515fd41b4bcb9aa0666f1c5273b6cde40c222559c3c6d84effa7bf0b77729`.
Only those nine IDs were acknowledged by marking their dead-letter records completed. Their error
output and original failed source jobs were retained; no jobs were deleted or replayed.

## Validation

The two focused PostgreSQL suites passed all 25 tests on Linux x86-64, including real monitor SQL
coverage for rejected reference profiles with valid exact-league output, fresh/stale/missing sets,
empty or partial output, old models/policies/scoring mappings, wrong weeks/seasons, unsupported
scoring, and release-rail mismatch. Two pre-existing readiness assertions were corrected to retain
the current ESPN/Yahoo defense-definition mismatch instead of expecting cross-provider admission.
Type checking and scoped ESLint passed. The new shell regression checks and both existing
notification/debounce regression suites passed using fake delivery only.

The monitor image was rebuilt and deployed. Its 17:32:04 UTC report-only check returned `healthy`
with no issues, and the container health check passed. All 16 monitored leagues had fresh weekly
and ROS output; no unacknowledged dead letters remained. No application image, forecast, admission,
numerical model, or publication gate was changed. Build, checks, before/after reports, and
acknowledgement artifacts are retained under `/tmp/laces-telegram-20260921`.
