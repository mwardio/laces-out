# Week 2 lineup advice investigation and release

Investigated September 16, 2026. The initial investigation was read-only. The subsequent,
user-authorized release and refresh are recorded below. No fantasy roster was changed.

## Football recommendation

Start DeVonta Smith over Quentin Johnston under the inspected league's standard scoring
(0.1 per receiving/rushing yard, six per receiving/rushing touchdown, no reception points).
This is a judgment under current information, not a claim that Johnston cannot outscore him.

FantasyPros' current player pages put Smith at WR11 and Johnston at WR29 across 67 experts.
Their standard-point projections are 9.3 and 6.8, respectively. The component projections also
favor Smith: 5.3 receptions and 70.4 receiving yards versus 3.3 and 45.5. Smith led Philadelphia
with six targets in Week 1; Johnston also had six targets, but finished with 17 yards versus
Smith's 53. Smith's expanded role after A.J. Brown's departure is a reason to look beyond the
previous season's production. Sources:

- [Smith: rankings, projections, Week 1 usage, and Week 2 analysis](https://www.fantasypros.com/nfl/players/devonta-smith.php)
- [Johnston: rankings, projections, and Week 1 usage](https://www.fantasypros.com/nfl/players/quentin-johnston.php)

The material counterargument is Ladd McConkey's rib injury. The Chargers called him day-to-day
on September 14; an eventual absence could improve Johnston's opportunity. That is a conditional
upside case, not confirmation that Johnston has a larger role this week.
[Chargers injury update](https://www.chargers.com/news/ladd-mcconkey-injury-fantasy-jm-harbaugh-week-1).

## What Laces Out actually used

The inspected league was synchronized to 2026 Week 2. Its managed weekly projection set was
computed at 17:11 UTC on September 16, with the WR champion set to `recency-only`. Player identities
and league scoring were correct. The lineup optimizer selected the larger mean as designed.

| Stored forecast              |     Johnston |       Smith |
| ---------------------------- | -----------: | ----------: |
| Mean fantasy points          |        7.481 |       5.658 |
| Receiving yards              |       57.058 |      54.117 |
| Receiving touchdowns         |        0.494 |       0.233 |
| Lower/upper projected points | 3.550–10.818 | 1.727–8.995 |

About 1.57 of the 1.82-point advantage comes from receiving touchdowns. The two outcome ranges
overlap substantially. The stored 0.95 projection-quality confidence is not a 95% probability
that Johnston beats Smith.

The larger issue: `statsThrough` and `trainingCutoff` were both 2025 Week 18 despite complete
Week 1 player observations already existing for both players. The Decision Desk's freshness
label used the artifact's recent creation time, obscuring the old statistical cutoff.

## Confirmed cache defect and correction

The active schedule snapshot still marked `2026_01_DEN_KC` as `in-progress` on September 16.
It had been ingested September 15 at 03:40:56 UTC, approximately 3h26 after kickoff. nflverse
derives finality from score presence; Laces Out deliberately delays accepting that signal until
four hours after a known kickoff. That conservative guard worked on the initial ingestion.

Subsequent schedule checks kept reporting success, but did not advance the stored status:

1. An HTTP 304 or identical raw-body checksum skipped parsing and persistence entirely.
2. Even reparsing the unchanged scores used the same selection checksum. The immutable
   observation's unique key prevented replacing the earlier `in-progress` row.
3. The projection publisher requires a complete week before admitting its history. One frozen
   game therefore excluded all of 2026 Week 1, kept Week 1 in the target-week queue, and retained
   the previous season's evidence for Week 2.

`nflverse-schedules.ts` now records the next provisional-status recheck time, bypasses HTTP and
body-checksum caches when that time is due, and fingerprints the effective persisted status.
A matured status produces a new immutable schedule snapshot. Schema version 3 forces a replay
of older artifacts, including records that lack the new recheck metadata. Earlier observations
remain intact; the four-hour guard remains in place.

Regression tests exercise the real source parser and disposable PostgreSQL for HTTP 304,
identical-body, and legacy-schema recovery. They verify that Week 1 leaves the projection queue,
old rows remain unchanged, and subsequent checks return to idempotent behavior.

## Read-only counterfactual

Replayed the current pure recency baseline with each player's pinned 2023–2026 regular-season
stats and snap history. Excluding Week 1 exactly reproduced the stored target, reception,
yardage, and touchdown components above. Including Week 1 produced:

| Baseline components                             |           Johnston |              Smith |
| ----------------------------------------------- | -----------------: | -----------------: |
| Receiving yards                                 |             44.445 |             53.784 |
| Receiving touchdowns                            |              0.339 |              0.175 |
| Raw standard points before residual calibration |              6.452 |              6.430 |
| Points with the existing calibration held fixed | approximately 5.30 | approximately 5.28 |

This reduces the edge to approximately 0.02 points. It does **not** prove that the fully refreshed
publication will have these exact numbers: backtests, champion selection, and calibration also
advance when Week 1 is admitted. Nor does it reverse the residual baseline ordering by itself.
It demonstrates that the stale schedule materially inflated the recommendation's apparent edge.

## Follow-up work

1. **Make statistical recency visible — implemented.** Show “Stats through 2026 Week 1” alongside computation
   time in the Decision Desk. Detect unresolved old schedule games and surface a coverage warning
   when recent inputs exist but cannot enter training. Historical source timestamps alone are
   not an appropriate freshness clock either: archived training inputs can legitimately be old.
2. **Explain uncertain swaps — implemented.** Show both players' outcome ranges and distinguish a small model
   preference from a clear start/sit edge. Any win probability requires a validated joint outcome
   model; overlapping marginal intervals do not establish a calibrated probability.
3. **Test role changes and touchdown regression — completed offline evaluation.** The defending WR baseline ignores opponent/team
   multipliers and does not model a departed teammate's vacated opportunities. Evaluate a
   target-share/route-based role-change challenger and shrunk touchdown rates against the
   current recency baseline. Include early-season and changing-role cohorts, scoring-specific
   MAE, calibration, and start/sit regret in strictly prior held-out evaluation. Preserve the
   existing champion gate until a challenger wins; this pair alone is not sufficient evidence
   for a model promotion.
4. **Audit disagreement — implemented.** Fresh, saved ESPN weekly projections now cross-check the
   modeled lineup using the same roster eligibility, slots and stored locks. ESPN totals are already
   scored for the exact league. Disagreement appears in Decision Desk, inbox details and Film Room;
   a contrary two-player forecast qualifies the swap as a close call. Model points remain separate.
   Public pages consulted for this investigation are not a production scraping dependency.

## Validation and release status

All 85 tests passed across six focused suites: schedule helpers, disposable PostgreSQL schedule
replay, the nflverse schedule source, first-party projection policy, the projection service, and
projection lock windows. Type checking, ESLint for changed TypeScript files, formatting, and the
worker build also passed on local Linux. The M1 Mini doctor failed with SSH connection refused;
no Darwin/ARM64 validation is claimed.
The schedule fix was deployed first, then its normal adapter replayed all 272 schedule rows at
19:43:13 UTC. All 16 Week 1 games, including DEN–KC, now have final status in the selected artifact;
the source reports schema version 3. The earlier immutable observations remain intact.

The Decision Desk/API release now exposes `statsThrough`, each player's `projectedRange`, and
an `assessment` on every lineup change. Overlapping ranges produce a qualified model lean.
Missing or degenerate ranges do not become certainty; a negative slot delta is explicitly
described as dependent on the complete lineup plan. Inbox identity and recommendation version
advance so old unqualified cards cannot masquerade as the new result. Film Room receives the
same assessment, including its deterministic fallback when model generation is unavailable.

Coverage validation is shared between the read path and publisher. An explicitly finished week
must enter training. A game still unresolved eight hours after kickoff triggers a warning; elapsed
time never establishes finality. Missing prior schedules and inconsistent/future cutoffs also
withhold advice. Publisher checks preserve earlier good artifacts; read checks prevent those
artifacts from continuing to generate advice after their coverage becomes inadequate.

## Harvey versus Tate, FF 2026 League

This league uses full PPR plus one point for 100–199 rushing/receiving yards and three for 200+.
The old managed forecast had Harvey at 12.568 (7.377–17.528) and Tate at 4.847 (-0.782–9.600).
Both were using history ending in 2025 Week 18. Tate, a rookie, therefore had no personal
history and received a generic position baseline; his six-target NFL debut was excluded entirely.
Harvey's forecast included 10.79 carries and 0.79 total touchdowns, influenced by his previous role.

The September 16 public PPR benchmark is much closer: Harvey 10.3 and Tate 9.1. Harvey had three
carries and four receptions in Week 1; Tate caught four of six targets. Harvey's passing work
supports a narrow PPR lean even as Dobbins leads Denver's rushing work. These public projections
do not include this league's exact yardage bonuses, so they are a comparison rather than a
replacement league-scored forecast. The original 7.7-point gap is not supported by that benchmark.

A subsequent read of the league's saved ESPN Week 2 projections (observed 20:14:43 UTC) reversed
that narrow preference: Tate 11.559 versus Harvey 10.047 under FF 2026's own scoring. Android
ESPN projections (observed 20:33:50 UTC) favored Smith 8.669 versus Johnston 6.996. Given the
league-specific comparison and Harvey's diminished rushing workload, the final football judgment
is Smith in Android and a slight Tate lean in FF 2026. The conflicting Harvey/Tate forecasts
make this a close call; they do not support a large, confident Harvey advantage.

- [Harvey: Week 2 PPR projection and Week 1 usage](https://www.fantasypros.com/nfl/players/rj-harvey.php?scoring=PPR)
- [Tate: Week 2 PPR projection and Week 1 usage](https://www.fantasypros.com/nfl/players/carnell-tate.php?scoring=PPR)

## Reproducible model research

`apps/worker/scripts/audit-lineup-challengers.ts HISTORY.json [BACKTEST-CACHE.json]` consumes normalized, immutable
NFL history and evaluates three fixed ablations: recent role, touchdown-rate regression, and
both. It uses the existing locked 20-week backtest population, including prior-relevant DNP
outcomes, and removes all target/future-week observations from features. The role adjustment
uses current-season/current-team participation when available, the existing four-game role window,
and existing 0.65–1.35 bounds. Touchdown rates receive four position-average games of prior evidence.
These are target/carry-share experiments; route participation is not available in these inputs.

Reports include standard/PPR mean absolute error, early-season, changed-role and limited-history
cohorts, per-position results, and start/sit regret. Regret compares FLEX-eligible pairs projecting
at least five points and separated by at most five baseline points. It is an all-pairs diagnostic,
not a replay of actual fantasy rosters. Tied forecasts receive the average of the two outcomes.
The optional cache is pinned to the history SHA-256 and model version. No candidate has a production
selection path. The report also runs the existing rolling champion policy and point calibration
using only earlier residuals, plus a final-policy diagnostic. The latter selects a champion over
the full evaluation window and is not an independent out-of-sample selection result. Component
intervals are inherited, so they are not presented as validated challenger intervals.

All six variant/scoring combinations failed the overall research gate. The combined role/TD
experiment reduced raw MAE by 1.32% in standard scoring and 0.81% in PPR, below the required 2%;
PPR running backs regressed slightly. The standard WR subgroup improved 2.23% before calibration
and cleared the native position-selection threshold, but its rolling calibrated improvement was
only 0.09% (MAE 3.1114 to 3.1085). The PPR WR challenger did not clear the native selection margin.
Those results do not justify broad promotion. Production weights and player rankings were not
hand-tuned to these examples. Full results: [lineup challenger audit](lineup-challenger-audit-2026-09-16.json).

## Live verification and calculation performance

The corrected Week 2 publication now records `statsThrough: { season: 2026, week: 1 }`.
Fourteen league sets were published in that batch. Live decision reads for both reported
leagues validate against the strict response contract and resume available lineup advice:

| League/scoring       | Player           | Refreshed mean | Outcome range |
| -------------------- | ---------------- | -------------: | ------------: |
| Android / standard   | Quentin Johnston |          5.350 |   1.501–8.823 |
| Android / standard   | DeVonta Smith    |          5.327 |   1.479–8.801 |
| FF 2026 / league PPR | RJ Harvey        |         11.181 |  5.774–16.015 |
| FF 2026 / league PPR | Carnell Tate     |          6.084 |  0.641–10.940 |

Johnston's 0.023-point edge is effectively a tie; the football recommendation remains Smith.
Harvey's lead narrows but remains larger than the public PPR benchmark. Tate now uses his
debut rather than a generic no-history baseline. One observed game still provides limited
evidence; neither the data correction nor overlapping intervals establishes a probability of
outscoring the alternative.

Profiling the rebuild exposed redundant historical averaging and interval sorting. The model
now avoids per-row temporary allocations, caches position means by immutable history, position,
target week and half-life, and calculates prior-error quantiles once per position/week rather
than once per player. Summation order, the whole-week calibration boundary, model version and
forecast mathematics are unchanged.

A before/after replay of 15 real QB/RB/WR/TE/K targets, for both contextual and recency forecasts,
produced byte-identical objects (SHA-256
`f8dea842b52c6fd7ac3c0f7314d2901514c94bcb81ce4aa78f29a59e895c0c68`). Local elapsed time was
12.73s versus 10.69s. A separate 5,400-observation calibration replay produced identical full
calibration objects in 2.64s versus 0.20s, approximately 13× faster for that stage. These are
focused benchmarks, not a claim that an entire production refresh is 13× faster.

The initial safeguard release passed 287 tests across 18 focused suites. The final ESPN comparison
follow-up passed 122 tests across eight focused suites, TypeScript, changed-file lint, formatting
and API/worker/web builds. Browser checks at 390px and 1280px verified ranges,
close-call wording, visible cutoff, unavailable-state behavior and no horizontal overflow.
The deployed public Decision Desk route returned HTTP 200 without browser exceptions, and
the public API readiness check returned healthy. All validation here ran on Linux.

## Automatic ESPN comparison

The existing ESPN sync persists current-week applied projection totals in league-scoped
`weekly-box-scores` snapshots. Comparisons accept only the exact provider, league, season and week,
with an observation age between zero and 24 hours. Missing/non-finite totals, ambiguous duplicate
rows and ambiguous or foreign-league identities do not become evidence. A full alternative lineup
requires coverage of every rostered player and runs through the same optimizer and stored locks;
partial coverage can support only an explicitly mapped two-player comparison. Slot rearrangements
with identical starters do not create disagreements.

The comparison is advisory and never blends ESPN points into model totals. Its evidence enters
the decision checksum (algorithm version 6); inbox review identity changes when the substantive
disagreement changes, not merely its observation time. Decision Desk displays these notes even
when the current starters already maximize the model's points. Film Room preserves them in both
its tool context and deterministic fallback.

Read-only checks against both live leagues confirmed the comparison works with their real provider
identities. Android's ESPN alternative included Smith; FF 2026's included Sutton over Harvey.
These are full-lineup comparisons, which can differ from the two isolated pairs in the original
report. Fantasy rosters can change during investigation; no roster was modified by this work.

The final API, web and worker deployment completed at approximately 20:48 UTC. Live contract
validation succeeded for both leagues, including their Week 1 cutoff and ESPN comparison notes.
Public readiness and Decision Desk browser smoke checks passed after deployment. Rollback images
and exact deployed image IDs are recorded in the local release manifest.
