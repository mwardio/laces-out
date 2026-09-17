# ROS refresh alerts — September 17, 2026

The 05:10 CDT notification described a real publication outage and incorrectly labeled a recurring
symptom as a new issue. Completing the background job did not mean new approved forecasts existed.

## Production evidence

- Seven active leagues retained complete ROS sets published September 8 at 06:30:13.865 UTC:
  Android's Dungeon, FF 2026 League, FANTASY FOOTBALL 2026, GD Eagles, Garagely, Lager League,
  and The Fantasy Federation. Those sets covered Weeks 1–18 and were about 219 hours old.
- The September 17 refresh started at 06:30:35 UTC and completed at 09:56:36 UTC. The complete
  scoring profiles passed all six current position gates and their 12,288/16,384-path convergence
  checks, but their candidate universe contained 855 of 856 expected players. Publication was
  withheld with `ros_candidate_universe_incomplete`; the previous sets stayed intact.
  This identity blocker affects Android's Dungeon, FF 2026 League, and Garagely.
- The other four stale leagues have a separate `ros_scoring_profile_position_withheld` blocker.
  FANTASY FOOTBALL 2026, GD Eagles, and The Fantasy Federation use full PPR with four-point
  passing touchdowns and no yardage-game bonuses. Their exact complete scoring shape is absent
  from the current admitted catalog; the closest ESPN standard profile matches only QB and D/ST.
  Lager League uses half PPR, three/five-point yardage-game bonuses, and different defensive rules;
  its selected artifact matches only kickers. Repairing player identity cannot authorize these
  missing scoring profiles. They require separate validation and admission, not a lower gate.
- The unresolved candidate was the official weekly roster's `HEN032810`: Al-Jay Henderson, NYJ RB,
  practice squad (`DEV` / `P01`). The source had an ESB identity but no GSIS identity. Ingestion
  preserved the fallback ID in its observation but resolved database player IDs only through GSIS.
  No matching canonical player existed, leaving this candidate unresolved. Omitting practice-squad
  players would hide the gap rather than repair the identity.
- Earlier ROS runs had separate blockers, including model admission and changing live input
  checksums. The missing identity above is the confirmed blocker in the latest completed run;
  it does not by itself explain every day since the last publication.
- The monitor removed `ros-refresh-incomplete` at 06:45 UTC while the next refresh ran. Completion
  reintroduced that key, causing a new-issue notification at 10:10 UTC / 05:10 CDT even though
  `ros-projection-stale` remained unresolved throughout.
- Source metadata incorrectly retained an earlier `publishedTargets: 7` alongside the latest
  `result: shadow_evidence_recorded`. The publication code omitted zero counts before merging
  current metadata into the prior metadata.

## Other alerts in the screenshot

The weekly-data and connection incidents had recovered by this investigation. The September 17
09:05 UTC weekly runs published all 1,365 evaluated players for both Weeks 2 and 3. The latest
14 league-scored Week 2 sets recorded statistics through Week 1. At 10:16 UTC the managed weekly
source and current nflverse statistics source had zero consecutive failures, and all seven provider
connections and all 16 league links were healthy.

Historical jobs include a weekly heartbeat timeout and a Yahoo database connection timeout. The
monitor's retained logs contain notification counts rather than each removed issue's name, so these
are supporting failure evidence, not a definitive explanation of every screenshot timestamp.
There is no current evidence that the user needs to reconnect an account.

The retained ROS sets have Week 1 windows while the leagues are in Week 2. Decision reads reject
that mismatch for current ROS advice. Weekly lineup recommendations remain based on current
weekly forecasts; the old ROS sets remain available as historical evidence in Projection Lab.

## Corrections

The monitor now retains one publication-staleness incident across queued, running, and completed
refreshes. Completion without new forecasts adds detail to that incident. Actual job failures still
raise a separate operational issue, and only fresh approved publications resolve the stale-data
incident. The host monitoring code lives outside this Git repository; its reproducible patch is
[`ros-alert-monitoring-2026-09-17.patch`](./ros-alert-monitoring-2026-09-17.patch).

ROS source metadata now explicitly resets per-refresh publication/arbitration counts and
diagnostics, including blocked and unchanged runs. A shadow-only pass cannot inherit an earlier
successful release count.

Roster ingestion resolves exact authoritative ESB/SMART identities in separate namespaces when
GSIS is absent, with conflict and continuity checks. A roster-specific normalized checksum binds
the resolved player IDs to the raw artifact, allowing an immutable replacement for the old NULL
observation without rewriting history. Catalog ingestion retains the same exact IDs so a later
GSIS assignment can strengthen the existing player instead of creating a duplicate. Conflicting
canonical owners remain blocked rather than being merged by name.

Future incomplete-universe audits include bounded skipped-player identities and reasons, so the
operator can see the missing source ID directly instead of discovering it after a multi-hour run.

## Validation and recovery

Focused identity, ingestion, candidate, and publication tests passed, including isolated PostgreSQL
17 coverage for preserving old observations, repairing the selected snapshot, 304 responses,
idempotent replays, conflicting identity orders, and subsequent catalog GSIS assignment. A resolved
practice-squad RB with no personal history still produces a covered ROS candidate. Both monitoring
regression suites use temporary state and fake notification delivery.

The monitoring fix was deployed and its container is healthy. Application recovery requires the
updated worker, a forced 2026 weekly-roster refresh, verification that the selected Week 2 fantasy
roster has no unresolved player IDs, and a normal queued ROS refresh. Simulation completion alone
is insufficient: recovery must be measured by new complete projection sets. The remaining four
scoring-profile gaps stay visible until matching evidence is validated and admitted.

The Mini doctor timed out; validation in this incident ran on Linux. Build, rollout, and live
recovery artifacts are retained under `/tmp/laces-ros-incident-20260917`.
