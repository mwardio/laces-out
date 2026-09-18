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
  leagues, all 26 checked sources usable (including all 21 required sources), and all four
  historical PBP pairs coherent. The
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

Presentation deployment verification, 23:50 UTC:

- Commit `d951e13` is pushed and deployed in the API, web app, and ordinary worker. The production
  build, full repository lint and type check, and nine-entry worker container canary pass.
  API and web readiness pass; no database migration was needed for this follow-up.
- Read-only production verification still finds 16 valid weekly league outputs and one explicitly
  unsupported IDP configuration. All 26 checked sources are usable, including the 21 required
  sources; all four player/team PBP pairs remain coherent. Actual request services return the
  latest v14 forecasts, current scoring compatibility, Harvey's visible injury designation,
  and close-call assessments. Both ROS consumers remain paused for corpus completion.
- A single isolated read-only CPU profile identified repeated pre-trade roster optimizations as
  a substantial request cost. A request-scoped reuse improvement is being tested for exact output
  equivalence. No production API process was profiled or modified during that diagnostic.

Decision computation equivalence checks:

- Each internal lineup candidate now lazily retains its existing exact tie-breaking string. The
  assignments, semantic slot order, score epsilon, and preference for current assignments are
  unchanged. All 31 lineup tests and 14 downstream waiver tests pass. A seeded comparison against
  the deployed optimizer matches complete outputs and errors across 801 cases, including missing
  and nonfinite projections, locks, duplicate inputs, reordered slots, and epsilon ties. The
  aggregate output SHA-256 is identical. A dense tied-lineup benchmark improves from roughly
  190–217 ms to 127–135 ms per 30 optimizations; this is a component benchmark, not HTTP latency.
- Trade search reuses only the two unchanged pre-trade baseline evaluations inside one fixed,
  synchronous opponent context. Resulting rosters are still evaluated for each package. Validation
  remains lazy, invalid context stays isolated, and no cache crosses a request or user boundary.
  All 107 focused trade and decision cases pass, including generated equality across 35 contexts
  and eight packages each, null baselines, invalid inputs, and locked/IR/taxi roster integration.
- A single read-only capture supplied identical deep-cloned repository results and a fixed clock
  to the full deployed `d951e13` graph and the optimized graph. Complete snapshots match exactly
  for both reported leagues, including timestamps, provenance, and checksums. Replay wall time
  fell from 5,921 to 3,951 ms for FF and from 5,854 to 3,912 ms for Android, approximately one-third
  less computation time. CPU reductions were 15.3% and 30.4%, respectively. These measurements
  exclude live database reads and are not a service-level latency guarantee.
- A final replay after preserving the standalone package-field boundary again matched both full
  captured snapshots exactly, with zero database reads. Source hashes and the baseline module
  graph are archived alongside that proof; the baseline graph contains only deployed `d951e13`
  project modules.

Decision computation deployment, September 18 00:10 UTC:

- Commit `7f769b5` is pushed and running in the API, web app, and ordinary worker. Full type
  checking, scoped lint/formatting, production builds, and the nine-entry Linux worker canary pass.
  Read-only live requests return the current v14 projections, Harvey's injury designation, matching
  scoring compatibility, and close-call labels. Observed request-service times were 4.4–4.9 seconds
  under concurrent historical and weekly computation; this is not an HTTP latency guarantee.
- The preceding cold weekly job completed successfully before replacing the worker. A follow-on
  job returned to normal queue retry during graceful shutdown, with no abandoned active lease.
  The current worker began another refresh at 00:08:26 UTC.
- Verification at 00:10 found all 16 normalizable leagues still passed model, scoring, supported
  position, range, and confidence checks. Their publications predate a real roster-source update
  at 00:07:26, so the verifier correctly marks them for attention while the automatic refresh
  catches up. All 26 checked sources remain usable, including 21 required sources, and all four
  historical PBP pairs remain coherent. This checkpoint does not claim that publication has
  caught up with that source update.
- Captured request replay exposed a separate responsiveness problem: despite the reduced total
  computation time, one synchronous stretch delayed a 10 ms timer by about 3.9 seconds. A bounded
  scheduling change is being verified against the same immutable captured facts. The historical
  ROS model, numerical policy, release thresholds, and active corpus process remain unchanged.

Cooperative decision scheduling verification:

- Request orchestration now yields to an actual event-loop turn between trade packages after
  approximately 25 ms of work, and at independent waiver/trade phase boundaries. The clock,
  loaded facts, package order, and per-opponent baseline context remain fixed. No numerical
  engine or cross-request cache changed. Invalid packages cannot bypass the scheduling checkpoint.
- All 109 focused trade and decision tests pass, including real timer progress during successful
  and throwing package paths. The same two captured requests retain byte-identical complete
  snapshot hashes with no database or network access. Maximum observed 10 ms timer delay fell
  from roughly 3.9 seconds to 995 ms for FF and 690 ms for Android; 83 and 76 timer ticks ran
  before completion. Individual synchronous waiver calls still took 610–811 ms, so neither
  the 25 ms checkpoint target nor these replay measurements establish a request-latency guarantee.

Cooperative deployment and weekly catch-up, September 18 00:21 UTC:

- Commit `3b0ecca` is pushed and deployed in the API, web app, and ordinary worker. Full type
  checking, scoped lint/formatting, all 109 focused tests, production builds, and the nine-entry
  Linux worker canary passed. The API and web app are healthy. The two ROS consumers remain
  stopped while the unchanged historical service builds its 2023 holdout forecasts.
- The cold weekly refresh completed at 00:19:21 without retry; a subsequent warm refresh
  completed in 24.7 seconds. Read-only verification at 00:20:35 finds 16 verified weekly league
  outputs, one unsupported IDP configuration, all 26 checked sources usable (21 required), and
  four coherent PBP source pairs. The previous roster-source freshness discrepancy is resolved.
- Actual request-service reads still return current v14 projections, compatible scoring, visible
  injury status, and close-call assessments. FF took 5.46 seconds and Android 4.04 seconds during
  the concurrent verification workload. Cooperative yielding improves scheduling responsiveness;
  these variable live timings do not demonstrate another total-latency reduction.
- Queue inspection confirms the earlier retried follow-on completed normally. Another follow-on
  arrived during graceful replacement and returned to normal retry; no active work was force-killed.

Optional historical cache prewarming, September 18 00:29 UTC:

- A separate Linux helper uses the unchanged validation CLI with holdouts `2022,2024,2025`;
  every source season, cutoff, position, sampling count, and release threshold remains unchanged.
  The original full four-season run remains the sole release authority. The helper's report must
  never be substituted for it or adopted. There is no supported single-season CLI mode.
- Code review confirms each season's training data, calibration, player selection, input identity,
  and seed are independent of the other holdouts requested. The maximum full cohort is 3,264
  forecasts, below the unchanged 6,000 cap. Existing vectors are reused; concurrent identical
  writes use atomic links and verify collisions without overwriting a winner. An initial header
  inventory finds exactly 1,632 completed 2022 vectors, all with 16,384 scenarios.
- The helper is limited to two CPUs, low priority, a 3 GiB soft memory threshold, 4 GiB maximum,
  and 256 MiB swap. A separate guard stops only its cgroup when host available memory falls below
  2 GiB or the 2024 forecast stage finishes. Three guard checks passed. Shutdown is bounded to
  30 seconds because the next synchronous calibration can delay the process's signal handler.
  The original process and its resource limits are unchanged. The Mini remains unreachable.

Conditional interval development evaluation, September 18:

- One prespecified scalar interval candidate partitions prior residuals by a forecast threshold
  learned only from the previous eight weekly batches. The threshold is the median prior batch's
  RB24/WR36/TE12 raw forecast. Both partitions retain the existing signed residual quantiles,
  square-root scale, and 24-observation minimum with pooled fallback. Existing affine centers and
  physical strategy selections remain unchanged; there was no candidate or parameter sweep.
- All nine exact scoring profiles and 9,282 locked predictions completed in 161 seconds on
  Linux x86-64, with peak RSS about 591 MiB. Every mean and selected strategy matched exactly;
  prefix and target-outcome mutation checks passed. All unchanged position coverage gates and
  starter quality guards pass for the candidate. The overall proper 70% interval score improves
  by 0.40–1.01% across profiles. These profiles share observations and are not independent holdouts.
- Android starter coverage improves from 53.65% to 67.11% for WR and from 45.61% to 62.28% for TE;
  their proper interval scores improve by 3.92% and 8.52%. RB results are mixed: wider intervals
  improve coverage, but starter interval score worsens by up to 0.74% in some profiles. This is
  a measured tradeoff, not a claim of uniform improvement. The existing locked data was previously
  inspected, so this is development validation rather than untouched prospective confirmation.
- Integration is authorized only as a separately versioned interval layer after original strategy
  selection. It must preserve point calibration v1, component model v14, ROS v11 and all ROS cache
  identities. Provisional interval rows retain a confidence ceiling of 0.49. Frozen and known-zero
  forecasts remain protected; an old frozen interval cannot acquire stronger confidence merely
  because a new interval policy passed. This checkpoint is not deployment or live-output proof.

Durable post-sync projection scheduling, implementation verification:

- A nullable UUID on each league season records projection demand in the same transaction as a
  changed ESPN/Yahoo snapshot. Unchanged recaptures preserve the marker; an accepted ESPN identity
  change can create new demand. Migration 0051 adds only that column and a partial pending index,
  without backfilling historical leagues or changing model inputs.
- Immediate scheduling and the existing five-minute provider sweep share a bounded dispatcher.
  It captures up to 100 current-season demands, uses the existing weekly queue singleton/group,
  and clears only captured UUIDs after receiving a new durable job ID. Null/coalesced sends,
  queue errors, cancellation, and acknowledgement failures leave demand retryable. A newer sync
  cannot be cleared by an older dispatch. Provider automation flags do not disable reconciliation.
- All 53 focused tests pass, including PostgreSQL transaction rollback, stable unchanged snapshots,
  newer/unseen demand, first import, identity changes, disabled automation, and schema smoke through 0051. This closes a lost-dispatch path that otherwise could wait for the nightly refresh; it does
  not replace downstream job retries, ROS profile admission, or publication checks. Final build,
  migration, deployment, and live verification remain pending at this checkpoint.

Combined implementation verification, September 18 01:48 UTC:

- The interval integration passes 80 focused tests. Its separate 203.4-second replay matches the
  prespecified candidate's bounds exactly across all nine profiles and 9,282 predictions, while
  preserving every mean, physical component, and strategy-selection result. All 27 position/starter
  gate pairs pass. The original core and point-calibration files are unchanged. A final optional
  property type amendment produces byte-identical emitted JavaScript.
- Frozen and freshly fitted interval rows now have explicit provenance. The per-position fitted
  coefficients apply only to fresh rows; frozen rows retain their original bounds and cannot gain
  confidence from the new fit. An independent review found no numerical, gate, or kickoff-lock
  blocker. The interval policy remains provisional and capped at 0.49 confidence.
- Combined changes pass full application type checking, scoped lint, formatting, and diff checks.
  The full compiler required about 1.9 GiB; an initial 1.5 GiB heap cap was insufficient, so the
  successful check used a larger isolated allowance. All validation evidence here is Linux x86-64.
- The encrypted pre-0051 archive is verified by decryption and full `pg_restore` parsing to
  `/dev/null`. This is archive verification, not a restore drill or off-host backup confirmation.
- The optional 2024 helper was intentionally stopped at 01:40 to free release-build memory. Its
  306 committed 2024 vectors remain cached alongside the completed 2022 and 2023 vectors. The
  original four-season process continued without restart and completed 2024 calibration in
  788.1 seconds. The helper's cancellation exit is not a full-run failure or an eligible report.
- A final bounded cache profile found Float64 decoding accounts for about 14% of sampled read
  time. That is an upper bound on potential savings before preserving copies and finite checks,
  not a measured replacement-code speedup. No cache codec or batch-orchestration change is included.
  Production build, migration, deployment, live weekly verification, and full ROS recovery remain
  outstanding at this checkpoint.

Weekly fit-cache lifecycle review, September 18:

- A weekly calculation child aborted with `SIGABRT` at 06:15 UTC. Its parent stayed running,
  container restart count remained zero, and the cgroup recorded no OOM kill. The queued retry
  completed at 06:28 UTC in about 701 seconds. Heap exhaustion is plausible, but the signal alone
  does not establish the cause; raw crash diagnostics are intentionally excluded from logs.
- Review found that a cold replacement retained the previous histories and backtests until the
  new fit finished, while a separate module-level evidence memo also retained the old backtests.
  Each service now owns its memo and releases obsolete fits and evidence before refitting. Live
  histories are assembled afresh and are no longer retained in the fit cache.
- Whole-feed injury, roster, and statistical checksums previously forced a refit even when the
  strictly prior training rows were identical. The cache now identifies the exact assembled
  player and defense training inputs, their order and duplicates, the cutoff, and fixed fit
  configuration. Ordered per-row hashes bound temporary serialization memory. Current facts,
  source snapshots, and publication fences remain independently refreshed and checked.
- An explicit future-week request could reuse an older publication after a prior game crossed
  the conservative four-hour finality threshold with unchanged source bytes. The publication
  identity now includes the completed-week set before the early unchanged-output check. This
  lets newly eligible history enter the fit without changing the existing finality rule.
- Child result telemetry now distinguishes RSS, used and allocated JavaScript heap, external
  memory, and array buffers using an allowlist of nonnegative integer byte counts. It exposes no
  raw environment or crash output. The forecast algorithms, scoring rules, release gates, and
  frozen historical ROS run are unchanged. Deployment and live verification are separate steps.
- All 98 focused tests pass on Linux x86-64, including exact rebuilt evidence, fresh live
  histories with reused fits, prior-data mutations, failed replacement, clock-only completion,
  source drift on a cache hit, and telemetry filtering. Independent source review found no
  missing fit dependency. The Mini remains unreachable, so these results do not establish
  Darwin/ARM64 compatibility.
