# Projection accuracy and scoring resilience repair

Status: in progress. Weekly v14 / ROS v11 supersede the earlier v13 / v10 candidate below.
The production v9 recovery jobs are paused pending the validated replacement.

The acceptance target is accurate, traceable weekly and rest-of-season forecasts for ordinary
league scoring without training or replaying the football model for every new points configuration.
Changing points must not change predicted football outcomes, availability, random paths, or the
historical population being evaluated. Scoring-specific rankings and residual calibration may
change, but must be computed from reusable, strictly chronological evidence.

Required completion evidence:

- Weekly release metrics use predictions made by the policy available before each evaluation
  batch. Zero/inactive/bye projections remain zero after scoring changes, including after lock.
- Provider arithmetic, negative-yardage settings, whole-unit awards, and supported bonuses match
  actual rules. Expected transformed stats are learned from transformed outcomes; transforming
  a mean is not a substitute. Missing capabilities are explicit and isolated by position.
- ROS availability, production calibration, sample selection, seeds, and input identities are
  independent of league scoring. Both weekly and ROS retain relevant component provenance.
- Joint ROS outcome vectors can be reused for exact weighted scoring, including negative points.
  Nonlinear weekly operations cannot be applied to season totals. Correlation and zero-game paths
  survive reuse. Current model outcomes cannot be relabeled as a different model's evidence.
- Historical outcome evidence is persisted with bounded memory/disk use, checksums, versioned
  identities, atomic writes, recovery from interruption, and deduplicated shared generation.
  A new supported scoring configuration rescales cached evidence, then runs honest quality checks.
- Held-out evaluation covers weekly and ROS accuracy, calibration, position/horizon breakdowns,
  representative real league rules, sparse histories, rookies, injury states, and provider inputs.
  Model changes require new validation; tests alone do not establish predictive accuracy.
- Publication and lineup consumers use current league rules and correct week/horizon, retain only
  clearly labeled older evidence when appropriate, and cannot quietly mix incompatible identities.
- Fresh production results exist for the connected supported leagues; new-league onboarding and
  scoring changes are exercised end to end. Commit, push, deploy, health checks, and live evidence
  are required before completion.

Work is split across the weekly release/lock path, provider scoring adapters, reusable ROS outcome
generation/calibration, and durable reusable historical evidence. Final acceptance must inspect the
actual runtime and historical metrics against this list, not merely mark the implementation done.

Implementation checkpoint (not release evidence):

- Weekly v13 learns signed-yardage and positive-part/whole-group transforms from actual games.
  Exact-league publication is independent of the default/reference league gate. The release
  evaluation now uses the policy available before each held-out batch, and frozen zero projections
  cannot become positive during rescoring. Known snap-only, zero-stat games enter the training
  history as explicit position-relevant zeros; canonical historical normalization is idempotent.
- ROS v10 removes league coefficients from calibration APIs, checksums and seeds. It retains the
  established variance estimator against a fixed, declared reference production loss; this is a
  shared training target, not a replacement for exact league scoring. Availability uses actual
  football activity. The held-out cohort includes reference-production strata plus opportunity
  leaders and return specialists; zero/negative reference scores no longer exclude participants.
- Joint Float64 component vectors and per-path games are reusable through checksummed, bounded,
  atomic cache entries. A small immutable corpus references those entries and actual stat outcomes.
  Corpus replay reruns the same convergence, champion and interval-quality gates without fetching
  sources, fitting weekly models or simulating paths. A reserved PostgreSQL builder lease, atomic
  readiness pointer, cancellation and verified adoption path now coordinate this across workers.
  Readiness requires qualified source coverage, all requested season/cutoff/position batches and
  every referenced 16,384-path vector. Manual release batches also build once and replay profiles.
- Live refreshes share one worker, football calibration, and streamed simulations across all
  admitted profiles. Additional scorers retain only point arrays, with at most 32 profiles per
  batch and a 128 MiB summary cache. Exact full-projection equivalence is tested, including weekly
  bonuses, unavailable players, quantiles and diagnostics. Worker cancellation terminates CPU work.
  Reused convergence results must match seed, cutoff, scoring, model and path-count identities.
- Kicker paths now contain integer fine-distance makes/misses, XP misses, integer modeled FG
  distances and per-game whole-group awards. This changes the distribution and requires new proof.
- Outstanding statistical checks include component bias, scoring contrasts, interval width/WIS,
  cold-start and early-season cohorts, and lineup-pair regret. Non-kicker paths still use a shared
  production shock and fixed expected bonus probabilities; tests of scoring invariance do not
  establish their variance/covariance accuracy. Change those assumptions if measured evidence
  shows material deficiencies, then regenerate model evidence before publication.

No v10/weekly-v13 release or production recovery is claimed by this checkpoint.

Historical validation checkpoint:

- A fresh full-scope ROS v10 / weekly v13 build is running from the official frozen 2019–2025
  source cache, four held-out seasons, eight players per position/cutoff, all positions and
  the unchanged 6,000-forecast cap. Artifacts live under
  `reports/ros-v10-weekly-v13-20260917/`; the initial code-file SHA manifest is saved there.
- Weekly v13 validation uses the original read-only database snapshot plus a strictly
  checksum-matched official-source overlay for corrected blocked-kick semantics. It matched
  all 55,539 observed player-week facts and changed 57 blocked-FG games.
- Both Yahoo and ESPN count blocked field goals in total and distance-bucket misses, and blocked
  extra points in misses. Player-stat source schema v3 preserves that arithmetic, with a tested
  replay path for legacy archived input despite unchanged upstream bytes. ROS no longer applies
  the erroneous recorded-miss discount. Sparse kicker miss-distance fallback is symmetric rather
  than importing a later historical season into an earlier backtest.

These running checks have not yet established release accuracy or completed production recovery.

Weekly evaluation and runtime checkpoint:

- The frozen v13 weekly run completed 9,282 held-out predictions in 889.647 seconds. All 15
  fully normalizable leagues pass QB/RB/WR/TE/DST gates. Nine fail the adaptive kicker strategy's
  baseline comparison; this requires a separately evaluated fixed-recency fallback, not weaker
  admission requirements. The untouched report and locked predictions are retained under
  `/tmp/laces-weekly-audit-20260917/` pending final evidence export.
- Production API and validation processes restarted at 20:52 UTC after an unhandled pg-boss
  `EAI_AGAIN` event. Queue error observers now preserve pg-boss's existing background retries;
  actual emitter tests cover the process boundary. Kernel logs also confirm an earlier host OOM
  killed the old ROS worker at 20:40 UTC. The replacement live worker has a 2 GiB V8 thread limit
  and a 3 GiB container limit; real live peak memory still needs validation.
- The old production ROS validation worker was explicitly stopped at 20:54 UTC to avoid
  restarting superseded expensive builds. Its two interrupted leases and two pending jobs are
  retained. Deployment must install the verified common corpus and restart the updated worker;
  this pause is not a completed recovery. The public readiness endpoint remained healthy after
  the API's automatic restart.

Additional verified repair evidence:

- The separately evaluated fixed-recency kicker candidate passes the unchanged quality gates
  for all 15 fully normalizable leagues. The actual publication helper selects it only when
  the adaptive candidate fails and this independent candidate passes. Gate evidence remains
  chronological; future live correction is fitted separately for the selected strategy.
  Aggregate proof and input hashes are archived under the release report's `weekly-proof/`.
- Map v6 isolates six known ESPN long-touchdown categories to offensive positions. One further
  league can publish K/DST; its unsupported offensive categories remain explicit. Unmapped IDP
  scoring is still withheld rather than guessed. This is partial support, not full recovery.
- PostgreSQL previously rounded provider multipliers to four decimals. Migration 0050 preserves
  exact imported decimals and repairs only unambiguous historical rounding matches. Real database
  tests cover positive/negative rates, idempotency, duplicate source rules and preserved manual
  edits. The affected Yahoo profile passes all six weekly position gates when rescored with the
  exact imported rate; its corrected profile and proof are saved beside the aggregate reports.
- Lineup advice preserves a complete legal current lineup for gains below half the UI display
  unit, without retaining unavailable or unscheduled starters. Stored projection confidence now
  limits the strength of advice, including keep advice with a sparse-history alternative. This
  does not change the point forecast or manufacture a preferred player ordering.
- The full weekly audit's updated estimates narrowly favor Smith over Johnston. Harvey still
  exceeds Tate; Tate has one observed game, and the app now explicitly identifies that limited
  evidence. Cold-start and locked lineup diagnostics are archived in
  `reports/lineup-weekly-v13-20260917/`. The broad cold-start cohort is mostly nonparticipants and
  cannot establish accuracy for rookie starters.
- The ROS publication monitor now requires the current exact scoring key, model, season and
  admitted artifact. PostgreSQL tests reject fresh but obsolete or unproven sets. Its fixtures
  use actual historical report states rather than a synthetic release state.
- The old live ROS worker was also paused after its memory grew beyond 3.8 GiB. Both paused
  consumers must be restored on the validated replacement. The public API remains available.
- Exact-output ROS optimizations precompute repeated elasticity factors and avoid per-component
  tuple allocation. Frozen-reference full projections and aligned outcome bytes match across
  28 cases plus arbitrary-key regressions, including 12,288/16,384 paths. Full-case CPU improved
  by approximately 25–28 percent. The full historical run resumed with these changes and retained
  56 immutable completed ensembles; its restart manifest records the changed source hashes.

Repository-wide checks, deployment, historical ROS admission and live recovery remain pending.

Long-touchdown and conditional-quality revision:

- The previous ROS v10 build was stopped before completion; its 62 cached ensembles are retained
  as superseded evidence, not admitted as v11 forecasts. A fresh corpus must include weekly v14,
  source schema v4 and six explicit passing/rushing/receiving 40+/50+ touchdown components.
  Scoring map v7 will price those components directly. An explosive 40-yard play is not a
  40-yard touchdown and is never substituted for one.
- Official play-by-play from 2019–2026 reconciled 345,005 plays, 130,777 player games and 9,651
  offensive touchdowns against official weekly player totals, with no attribution discrepancies.
  Lateral scores use the credited touchdown player and that player's credited yardage. Production
  source admission must require the same complete game coverage and reconciliation; missing
  evidence must not become a known zero. Both weekly and ROS constrain 50+ <= 40+ <= total TDs.
- Overall weekly interval coverage hid poor coverage among predicted starters. A chronological
  audit of the same frozen v13 holdout found starter coverage roughly 43% RB, 42% WR and 33% TE
  for the reference PPR profile, far below the nominal 70%. Those intervals cannot justify strong
  lineup claims merely because the whole player population passes its gate.
- A separately implemented, strictly prior-week affine center correction for RB/WR/TE and
  square-root forecast-scaled residual intervals improve starter MAE, proper interval score and
  FLEX ranking regret across seven supported exact scoring profiles. These profiles share NFL
  observations and are not seven independent holdouts. Conditional coverage remains inadequate,
  so publication must record it and cap confidence when starter evidence is absent or outside
  the declared coverage range. QB, K and DST retain their independently evaluated policies.
  The candidate must be rechecked against newly generated v14 predictions before release.
- An encrypted pre-migration PostgreSQL backup was written outside the repository. Full archive
  decryption and pg_restore parsing succeeded; this is archive verification, not a database restore
  drill. Migration 0050 and production source reingestion remain pending.
- Corpus readiness now pins the full model/source/simulation/release protocol and verifies every
  referenced vector's player, cutoff, window, candidate, seed and input checksum. A full-season
  source and batch coverage check precedes adoption. Neither weaker release thresholds nor a
  reused vector belonging to another player can create a ready corpus.

No full ROS model-quality report or production recovery is complete at this checkpoint.

Fresh v14/v11 source qualification:

- The updated historical CLI completed its offline input-only pass in 112.867 seconds. All
  seven source seasons (2019–2025), four held-out seasons (2022–2025) and 68 cutoff batches
  qualified. Source evidence includes raw player-CSV, raw PBP and combined parser-v4 checksums.
  This establishes source coverage, not forecast accuracy; model evaluation is still required.
- ROS v11's focused simulation/outcome/kicker and real-PostgreSQL publication-health tests pass
  (87 tests). The new WR golden contains explicit 40+/50+ receiving bonuses, verifies identical
  underlying football expectations across scoring profiles, and checks exact additive scoring.
- A 21:44 UTC read-only production snapshot confirms all 1,025 rules across 17 active 2026 leagues
  still match the original audit snapshot using exact decimal comparisons. The previously captured
  Yahoo precision repair is still required; this comparison does not apply it to production.

External product comparison (checked 2026-09-17):

- FantasyPros describes applying custom scoring to detailed projected statistics in its
  [My Playbook custom-scoring documentation](https://support.fantasypros.com/hc/en-us/articles/360039535653-How-do-enhanced-rankings-and-tools-work-with-my-custom-scoring-i-e-non-default-settings-league).
  This supports the architectural expectation that ordinary scoring coefficients should be
  independent of the underlying football forecast.
- Its separate [Draft Wizard bonus-scoring documentation](https://support.fantasypros.com/hc/en-us/articles/360018745933-Does-Draft-Wizard-have-support-for-bonus-scoring),
  updated August 10, 2026, excludes bonus categories including long-yardage touchdowns because
  the supplied preseason projections lack those inputs. These are different product scopes;
  the limitation does not justify making supported ordinary league scoring fragile in Laces Out.

Final weekly evidence and operational checks, before deployment:

- Fresh weekly v14 produced 9,282 locked predictions in 473.439 seconds. Replaying the final point
  policy against all nine exact scoring profiles took 159.891 seconds. All six position gates pass
  for all 16 normalizable active leagues, including long-touchdown bonuses and the exact Yahoo
  rate. The remaining league's individual defensive player scoring is still unsupported. Starter
  interval coverage warnings remain explicit; aggregate passage does not establish calibrated
  uncertainty for starting players. The report and source/code provenance are in `weekly-proof/`.
- Weekly and live ROS publication now require matching raw PBP capture hashes for player and team
  sources using player schema v4. Ordinary and archived refreshes share one capture, repair a skipped
  counterpart once, and respect active source leases. Six real-PostgreSQL recovery cases plus the
  player replay and orchestration regressions pass. Missing data is not converted into a known zero.
- The broader packages/API/web regression partition passed 2,749 tests across 235 files. A later
  position-vocabulary correction to the long-TD coverage helper passed all 18 focused point tests.
  Full worker checks and deployment remain separate pending steps.
- Two lazy historical simulator processes preserve every component/game byte and metadata across
  12 dense six-position/two-strategy cases at 16,384 scenarios (732 component columns). Measured
  child RSS peaked at 193 MB, with a 587,202,560-byte V8 heap limit. The bundled production entry also
  passed typed-array/metadata equality checks. Linux process-group cancellation tests include a
  CPU-bound grandchild that ignores SIGTERM; no Darwin result is claimed because the Mini was
  unreachable.
- The full ROS v11 run restarted with this operational speedup and retained 49 verified immutable
  ensembles. Its restart manifest preserves their hashes, source hashes, and numeric equality proof.
  No model parameters, scenario counts, seed rules, or admission thresholds changed. A completed
  historical ROS accuracy report, admission, and live publication are still required.

Pre-deployment repository verification:

- Formatting, lint, and type checking pass. The worker/bridge partition ran 993 tests; its one
  failure was an outdated expectation that receiving bonuses must withhold quarterbacks. After
  correcting that expectation, all 47 tests in the affected publication suite pass. Combined with
  the application partition and updated point-policy tests, no known regression failure remains.
- All four production Docker images build successfully. A real container canary caught inferred
  tsup output paths moving service files into `dist/src/` after adding a CLI entry. Explicit entry
  names restore the flat deployment contract. All eight worker entrypoints exist in the final image.
- The final Linux x64 / Node 22.22.0 image reproduces host WR and kicker outcome metadata, game
  vectors, and Float64 columns byte-for-byte at 16,384 scenarios, with heap limits verified.
  Container canaries use invented football inputs and no database or network access.
- The migration preview still identifies exactly one unambiguous historical precision repair.
  Production migration, source reingestion, weekly recovery, and ROS completion follow separately.

Production deployment and source recovery, 22:37 UTC:

- Commit `5c9158a` is pushed. The API and web app are running the verified release images and
  readiness checks pass. Migration 0050 completed; the sole verified Yahoo decimal discrepancy
  now stores `0.0066666666666667` exactly.
- With the ordinary worker paused, the direct source operator refreshed the catalog and all
  20 datasets for 2023–2026. All are enabled, available, publishable, and free of current failures.
  Each player/team pair has the same PBP capture; all four player artifacts use component schema
  v4. Their 58,099 selected player-week observations have all six long-touchdown fields.
- The ordinary worker restarted on the new image and accepted an immediate week-2 refresh.
  Published league outputs and regenerated advice still require verification. Both ROS consumers
  remain paused until the fresh historical corpus is complete and verified for adoption.
- The running historical corpus builder has two bounded simulator children. Completed vectors are
  preserved durably, but no complete v11 accuracy report or exact-profile admission exists yet.

Historical process supervision checkpoint, 22:44 UTC:

- The interactive execution wrapper ended with status 143 before the historical report completed.
  All 288 committed v11 outcome files were retained and SHA-256 recorded in
  `supervised-restart-manifest.json`; the interrupted logs are archived separately.
- The identical validation command now runs as the user systemd service
  `laces-ros-v11-release-20260917.service`, with a 4 GiB total memory limit, 512 MiB swap limit,
  2.5 CPU quota, priority 15, and process-group shutdown. It can outlive the interactive tool
  session, and systemd records its final exit status. Cached ensembles remain reusable; prior
  calibration and feature assembly must run again. No numerical or release-protocol changes
  accompany this restart.

Production weekly verification, 22:48 UTC:

- All 16 normalizable active leagues now publish weekly v14 with map v7, publication policy v4,
  and point policy v1. All six supported position groups are present, with no withheld positions,
  interval-order failures, or violations of the starter-confidence cap. The IDP league remains
  explicitly unsupported. Source checks and all four PBP pairs remain coherent.
- Android's Dungeon projects Smith 4.889 versus Johnston 4.722; both have confidence 0.49.
  Smith is currently starting. Its recommendation regeneration is still being checked.
- FF 2026 has a new v8 lineup run referencing the new projection set. Harvey remains in FLEX
  at 9.242 versus Tate 6.021, both confidence 0.49, with broad overlapping intervals. The app
  model sees Harvey as questionable; the upstream injury observation still records Wednesday DNP,
  while the Broncos' Thursday report improves him to limited. No manual model overrides were made.
- The initial cold weekly fit occupied the ordinary worker's event loop long enough for a
  provider sweep to time out; that sweep recovered on retry. A persistent isolated weekly process
  is being prepared so fitting/publication can retain their existing mathematics and cache without
  blocking queue heartbeats and provider synchronization. This follow-up is not yet deployed.
- The ROS onboarding review also found transient failed or source-coverage-withheld profiles could
  remain stuck under the same identity. A fenced, deduplicated recovery using an already-ready
  corpus is being implemented; statistical withholding must never become an automatic retry loop.

Operational follow-up verification, 23:02 UTC:

- The cross-job scoring-evidence memo reproduces all nine exact-profile v14 audit results from
  the same 9,282 locked predictions: selected policies, fixed-recency fallbacks, point calibration,
  and every position's metrics match exactly. Cold evaluation took 155.303 seconds; the warm pass
  took 0.515 milliseconds and retained 514,032 bytes of compact evidence, with no expanded
  champion backtests. These timings measure scoring evidence, not an entire refresh. The 53-case
  publication suite also passes, including changed rosters, leagues, and kickoff locks.
- Automatic transient ROS recovery passes 73 focused unit cases and 12 real PostgreSQL cases.
  The tests cover committed dispatch reservations, immediate consumers, queue-send failure,
  abandoned reservations, deduplication, preserved evidence, and bounded attempts per ready corpus.
  The full corpus is still building, so production recovery/admission is not yet verified.
- Process isolation and its production image remain separate follow-up checks. The exact model,
  historical simulation rules, and release thresholds are unchanged throughout this operational
  work. The Mini remains unreachable; these results are Linux x64 only.

Operational deployment and live verification, 23:32 UTC:

- Commit `3390569` is pushed and running in the API, web app, and ordinary worker. The weekly
  computation now runs in one persistent child with a 2 GiB old-generation heap allowance and a
  two-connection database pool. All nine flat worker entrypoints passed an actual Linux container
  canary; graceful shutdown and process replacement passed lifecycle and real-database tests.
- The old worker exited normally after its active work drained. The new worker completed a cold
  refresh in 671.202 seconds and reused its child for another refresh in 35.649 seconds. Thirteen
  league syncs completed during the first roughly 70 seconds of the cold calculation; queue
  heartbeats and provider synchronization remained responsive. These are observed job timings,
  not a guaranteed refresh latency.
- Read-only verification at 23:31:50 found current, valid weekly outputs for all 16 normalizable
  leagues, all 26 required sources usable, and all four historical PBP pairs coherent. The
  Decision Desk GET path recalculates from current facts; an older persisted background run is
  not its response cache. Both ROS consumers remain paused pending the completed corpus.
- Queue warnings now retain bounded categories, queue names, and numeric measurements. The
  visible ROS backlog is expected while its consumers are paused; historical raw warnings
  cannot be reconstructed because pg-boss warning persistence was disabled.
- After Docker builds finished, the historical service's CPU allowance increased from 2.5 to
  3 CPUs without restarting it or changing any numerical input. Its 4 GiB memory limit and
  512 MiB swap limit remain in force. Completion, exact-profile admission, and live ROS
  publication still require separate verification.

Starter accuracy and presentation review:

- A read-only diagnostic reproduced the locked 9,282 weekly predictions and all nine exact
  scoring-profile audit results. Prior-baseline starter cohorts use RB24, WR36, and TE12,
  selected before outcomes. Their point MAE improves over the release baseline by 1.58–2.73%
  for RB, 4.32–6.35% for WR, and 8.27–9.53% for TE across the profiles. The selected raw RB/WR/TE
  forecasts equal recency in these profiles; the measured gains come from chronological point
  calibration. This is not evidence that the contextual candidate beat recency.
- The weekly sample contains 20 batches, mostly from 2025. Starter interval coverage and TE
  positive bias remain limitations. The 0.49 confidence cap communicates limited evidence but
  does not repair interval calibration or supply a probability that a recommendation wins.
  No tuning to these diagnostic cohorts or release-threshold changes were made.
- A separate presentation review found two concrete gaps: Projection Lab could label an older,
  differently scored forecast as current, and the model's Harvey injury evidence was absent
  beside his lineup assignment. Read and display fixes are being validated separately from
  the frozen numerical release. The earlier weekly checkpoint refers to the model's injury
  evidence, not a visible Decision Desk injury label.

Read-path validation checkpoint, 23:41 UTC:

- The staged API services were exercised using the two existing claimed-team memberships and
  read-only database sessions. Both returned their latest weekly v14 set and valid contract
  responses. Projection Lab marked the matching rules as current. The lineup responses retained
  limited-evidence cautions and the independent ESPN forecast-disagreement notes.
- This smoke test caught a defect in the proposed injury reader before deployment: two current
  feed rows for an unrelated player caused a global ambiguity guard to discard all player status
  evidence. The guard is being narrowed to the ambiguous player. Direct, current NFL injury
  evidence must also remain usable when the separate Sleeper catalog is unavailable. Final
  injury-label verification and deployment remain pending at this checkpoint.

Presentation fixes verified before deployment, 23:46 UTC:

- Projection Lab annotates managed sets with exact scoring compatibility and only automatically
  selects matching forecasts. Historical access remains explicit, including when cached detail
  metadata disagrees with a newer list response. Older-model forecasts with the same rules remain
  eligible. All 41 focused tests pass, including eight PostgreSQL cases; mobile and desktop browser
  checks confirm that a scoring change removes the automatic selection without hiding history.
- The injury reader now isolates duplicate evidence to the affected player, requires the current
  catalog capture, admits direct canonical NFL injury reports independently of Sleeper availability,
  and distinguishes practice participation from official game designations. Current health changes
  enter the decision fingerprint and invalidate the inbox cache. Source outages leave an explicit
  unresolved-availability note when a stored injury cannot be verified.
- All 152 decision/status regressions pass, including 11 real PostgreSQL cases and rendered status
  badges. A final read-only request against production data returns Harvey as `QUESTIONABLE`,
  retains his 9.242 projected points, and includes the availability caution. Both leagues' proposed
  swaps are close calls. No scoring, simulation, calibration, source-ingestion, or numerical model
  version changed in these presentation fixes.
