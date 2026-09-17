# ROS scoring onboarding repair — September 17, 2026

The live audit found 17 active 2026 league seasons. Fifteen have fully normalizable scoring, but
only three were completely covered by admitted evidence. Four exact scoring variants cover the
other twelve leagues. The previous monitor considered only leagues with a prior ROS set, hiding
leagues that had never received a forecast. No member names or account identifiers are needed to
reproduce the scoring defects; the committed fixtures contain scoring rules only.

| Exact scoring variant                                        | Digest prefix  | Active leagues |
| ------------------------------------------------------------ | -------------- | -------------: |
| ESPN PPR, four-point passing TDs                             | `f5e63a616d1e` |              5 |
| ESPN half PPR, yardage bonuses, four-point passing TDs       | `a3fe2ccf5413` |              1 |
| Yahoo half PPR                                               | `8707a75b97ee` |              5 |
| Yahoo half PPR, return yards, FG distance and custom defense | `01f307ff974d` |              1 |

These differences include passing-interception penalties, two-point conversions, kickoff/punt
return yards, kicker brackets/distance, and defensive categories. Substituting the closest named
profile would change the league's scoring. The other two leagues contain unsupported rules; they
remain explicitly unsupported rather than receiving numbers under silently reduced scoring.

## Admission and onboarding

Migration 0049 adds an exact-profile validation registry keyed by season, mathematical model,
policy, calibration, and scoring digest. Worker startup and successful ordinary weekly refreshes
normalize every active league's stored rules. Equivalent leagues share one proof. A new valid
numeric scoring variant does not require a new catalog entry or code deployment.

Current evidence is reused only after its identity and checksum validate. A newly linked league
changes the publication demand even when its scoring profile was admitted earlier. Repeated roster
syncs do not repeatedly request that same demand. A coalesced ROS dispatch leaves demand pending,
so a league added while another run is active cannot disappear behind its older input snapshot.

Missing evidence queues `ros-profile-validation`. Its isolated worker runs at most two proofs
concurrently under a two-CPU/five-GiB container budget. The live ROS worker has three CPUs, leaving
capacity on Dakoota for weekly projections, API requests, and heartbeats. The child receives an
exact canonical key file, public-source access, and a small allowlisted environment without
application credentials. Output is bounded; cancellation terminates the child; a 22-hour deadline
fits inside the 23-hour queue lease. Infrastructure failures get two retries and visible dead
letters. Orphaned terminal attempts become `failed`, rather than remaining `validating` forever.

Each proof retains the full locked historical protocol: seven source seasons, four held-out seasons,
eight players per position, a 6,000-forecast cap, and existing portfolio, cell, source-lineage,
convergence, and calibration checks. Statistical withholding remains withholding. Admission inserts
an immutable artifact and completes the registry claim atomically; stale attempts cannot overwrite
a retry. Successful admission queues live publication. A retry of that enqueue reuses the artifact
and does not rerun the proof. Duplicate historical admissions cannot crowd other profiles out of
runtime or status reads, and the publication loader no longer truncates at 64 profiles.

## Correctness and performance

The simulator previously validated and sorted the scoring rules inside every path/week. Compiling
the detached rules once per projection preserves component validation, arithmetic order, seeds,
and scenario counts. Independent before/after bundles produced byte-identical JSON for 240
projections across ten profiles, six positions, two seeds, and two strategies, plus six full
12,288-path projections. The representative release benchmark improved from 8.94 to 2.76 seconds
(3.24 times); this is not a promise of the same whole-run speedup.

Historical defense outcomes previously came from a full defense backtest whose forecasts were
then discarded. Pure extraction preserves all 321 played outcomes and the entire defense backtest
JSON in the independent comparison; the fixture improved from 1,614 to 6 milliseconds. The initial
full-source preflight spent 120 seconds per profile on that discarded work.

Live role calibration also omitted the weekly residuals supplied during historical validation,
forcing its center-volatility fallback to 0.25. The live path now supplies the same locked predictions.
A 24-player regression proves parity with historical fitting and a fitted value distinct from the
fallback. Candidate-input identity advances to v6 so old output cannot be reused as unchanged.

## Visibility and verification

Projection Lab renders every connected league's readiness and its queued, validating, admitted,
withheld, or failed scoring status. Convergence and retained-publication labels come from that
league's own current-model evaluation. Another member's failed league cannot label it blocked.
The API restricts dynamic profile details to the caller's league scope.

Monitoring retains existing publication-age checks and includes never-published supported leagues
after a 36-hour initial grace. Current weekly normalization provides a conservative fallback if the
registrar itself fails. Unsupported/archived leagues do not become false data outages. A completed
shadow job is still not a successful publication.

Focused tests cover real provider fixtures, unknown rules, deduplication, scoring changes,
interrupted and replaced claims, immutable admission, dispatch failure, growing profile catalogs,
API membership isolation, and actual monitoring SQL against disposable PostgreSQL. Browser checks
at 390 and 1280 pixels found no overflow or runtime errors. All validation is Linux x86-64; the Mini
was unavailable (SSH connection refused).

The original identity recovery completed at 13:56:17 UTC on September 17 and published all 856
expected candidates for the three previously approved leagues. New scoring support requires both
successful historical admission and new complete league projection sets. Recovery must be checked
from those records, not inferred from code deployment or a running validation job.

Release artifacts are under `/tmp/laces-ros-onboarding-20260917`. Numerical comparison artifacts
are under `/tmp/laces-ros-speed-20260917`. The exploratory frozen batch under
`/srv/backups/laces-out/reports/ros-exact-validation-20260917-optimized` was deliberately stopped
before forecasts were produced so the initial cohort can exercise the deployed durable queue.
