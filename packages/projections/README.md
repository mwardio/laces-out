# Projection CSV import

`previewProjectionImport` is the lower-level trust boundary for user- or
operator-supplied weekly and future rest-of-season projections. It accepts
bounded CSV text, validated metadata, and an application-owned player resolver.
The current league CSV routes deliberately expose weekly imports only because
the Decision Desk consumes exact league-season/week sets. The package retains
the broader horizon type for future consumers and has no database dependency.

Required CSV columns are `mean_points` plus either `player_id` or `player_name`.
Optional columns are `floor_points`, `ceiling_points`, and `confidence`. Common
aliases such as `Player`, `Projected Points`, `Floor`, `Ceiling`, and `FPTS` are
normalized; unknown columns generate warnings instead of being silently hidden.

```ts
const preview = await previewProjectionImport({
  csv,
  metadata: {
    season: 2026,
    week: 7,
    horizon: "week",
    sourceLabel: "Mack weekly model",
    sourceObservedAt: "2026-10-15T14:30:00.000Z",
  },
  resolvePlayer: async ({ playerId, playerName }) => {
    // Query the application's canonical player catalog. Never guess when a
    // name maps to multiple players.
    return resolveFromCatalog({ playerId, playerName });
  },
});

if (!preview.canCommit || !preview.normalized) {
  return showDiagnostics(preview.diagnostics);
}

await database.transaction(async (transaction) => {
  await insertProjectionSet(transaction, preview.normalized);
  await insertPlayerProjections(transaction, preview.normalized.playerProjections);
});
```

The resolver must return `resolved`, `unresolved`, or `ambiguous`. Unresolved,
ambiguous, duplicate, malformed, and out-of-range rows make the entire preview
non-committable. `sourceObservedAt` is required in strict UTC ISO form and is
canonicalized before hashing. It means when the source observed or published
the data; it is not the later import time. `sourceChecksum` fingerprints
canonical input and metadata, including that timestamp; `normalized.checksum`
fingerprints the exact resolved commit payload. Treat the normalized object as
atomic and never persist only its valid subset.

## Scoring-aware observations

Production adapters should emit `StatComponentProjectionObservation` whenever raw projected stats
are available. `buildProjectionConsensus` scores those components against the target league profile:

```ts
const ppr = {
  id: "league-123:2026",
  rules: [
    { statId: "rushing_yards", points: 0.1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receptions", points: 1 },
    { statId: "rushing_touchdowns", points: 6 },
  ],
};

const consensus = buildProjectionConsensus(observations, { scoringProfile: ppr });
```

When a source supplies only fantasy points, use `PointProjectionObservation` and attach the exact
profile used by the source. A scoped observation also requires its horizon, source version, source
as-of time, and fetch time. The legacy unscoped points shape remains accepted for existing callers,
but cannot be combined with a target league profile.

Consensus rejects mismatched horizons and point-only scoring profiles. `groupProjectionConsensus`
separates those contexts instead of silently mixing them. Sources that mirror or derive from the
same model must share an `independenceKey`; only the newest observation in that lineage contributes
to source count, confidence, and the weighted consensus.

## First-party weekly component model

`projectFirstPartyWeeklyComponents` produces scoring-independent QB, RB, WR, TE, and K stat lines.
It uses exponentially weighted player history, role-matched position priors, bounded team and
opponent adjustments, explicit pregame role context, and conservative injury-state handling. A bye
or explicit no-game schedule produces no projection; a confirmed inactive status produces a hard
zero. Sparse and missing inputs remain visible through coverage counts, quality flags, reasons, and
an input fingerprint rather than being disguised as high-confidence output. The raw mean is never
silently floored or capped after modeling; floors and ceilings are separate uncertainty outputs.

Uncertainty comes from `runFirstPartyProjectionBacktest`, an expanding-window simulation. Every
week is locked as a batch: the point forecasts and interval calibration for that week can use only
games and residuals from earlier weeks. Realized same-week usage is never supplied as a forecast
feature. The release evaluation is bounded to the 20 most recent completed week batches and
fantasy-relevant targets while retaining all earlier rows as training evidence. Calibration is
accepted only when it matches the current model version and declares a `generatedThrough` week
strictly before the projection target. Otherwise the model reports and uses a conservative
historical-dispersion fallback.

`applyFirstPartyProjectionChampionPolicy` prevents a richer model from publishing merely because it
sounds more sophisticated. For each league scoring profile and position, it walks the locked
backtest one whole week at a time and chooses between the contextual model and the recency-only
challenger using only earlier completed batches. The default richer-model threshold is at least 2%
lower MAE with at least 100 scored predictions across eight completed week batches; otherwise recency
defends the position. The returned backtest replaces each prediction with the policy actually in
force for that historical week, so point residuals and the final live strategy measure the same
policy. An unknown or thin position always falls back to recency-only.

Team defense uses the separate `projectFirstPartyTeamDefenseComponents` and
`runFirstPartyTeamDefenseBacktest` APIs with team-week inputs. This prevents DST records from being
treated as player observations. Its lower and upper component values are raw statistical bounds,
not fantasy-point floors and ceilings: scoring direction for categories such as points allowed is
league dependent and must be applied after the raw projection is scored for that league.

The D/ST model uses opponent adjusted points allowed rather than the opponent's final score:
defensive touchdowns and safeties are removed before evaluating the fantasy defense. The remaining
provider-classification ambiguity around rare blocked-kick returns is retained as a publication
warning. Kicker and D/ST output includes the complete aggregate/bucket components needed by the
supported Yahoo and ESPN linear scoring maps.

## Production publisher

`FirstPartyProjectionService` in `apps/worker` is the production boundary around the pure model. It
pins a four-season window of immutable nflverse schedule, player-stat, team-stat, weekly-roster,
injury-report, and snap observations plus the current Sleeper status checksum. Required input sources must be enabled,
successful, publishable, and inside their source-specific freshness window. Current-season player
and team facts must advance together. Missing, stale, failed, degraded, or mismatched inputs fail
closed and leave the prior good projection set intact.

Completed weekly rosters add explicit zero outcomes for recently fantasy-relevant players who have
no box-score or participation row. A DNP is evaluated but never fitted as a played game. Historical
roster and injury releases without a trustworthy pre-kickoff timestamp are never supplied as
target-week forecast features; their zero outcome remains an honest miss. Current live designations
are used only when they are observed before the target kickoff. Future and bye-week roster membership never creates
a synthetic zero because the join requires a completed scheduled game.

The publisher runs the locked player and D/ST backtests before producing a target week. Player
history is truncated before the earliest target week, so results from an already-started Sunday
cannot leak into a Monday projection from the same batch. Raw stat component observations are
source artifacts and remain scoring neutral. For every synchronized league,
`normalizeLeagueScoringProfile` converts only supported, exact linear Yahoo or ESPN rules; unknown
categories, IDP, nonlinear bonuses, overrides, or incomplete mappings withhold that league instead
of guessing. The publisher derives that league's champion policy, selects the corresponding live
components by position, and calibrates point residuals from the same policy backtest in the same
scoring space. D/ST remains separate and must beat or tie its recency baseline. Each managed
projection set retains source/model checksums, model version, source and training cutoffs,
scoring-map version, exact champion policy, coverage, warnings, and backtest metrics.

The base schedule is an hourly sweep. A conditional ten-minute sweep activates within 130 minutes
of a known unresolved kickoff, and the last pass inside ten minutes forces a final current-input
check. The publisher conditionally refreshes current-season model inputs first and rebuilds only
when the pinned aggregate checksum changes. A daily or user-forced shared-data sweep refreshes the
full training window and queues the same publisher. Active source claims, stale/unavailable inputs,
and unresolved kickoff times fail closed. Once a game starts, its last pre-kickoff observation is
immutable. An unchanged checksum is accepted only after verifying that the immutable model run,
component observations, and managed league sets still exist. See `docs/operations.md` for cadence,
retry, recovery, and operator checks.

This package supports weekly forecast horizons. Automatic runs publish the current and next
actionable weeks from the known schedule, but do not aggregate or label those values as a calibrated
rest-of-season projection. ROS trade values and end-of-season forecasting require a separate
validated model/fallback policy.

## Rest-of-season distribution core

`rest-of-season.ts` is a separately versioned, persistence-free modeling slice. It accepts pinned
contextual and availability-aware recency component centers for every week in one continuous future
window, an explicit schedule/bye map, current availability, role-transition parameters, component
elasticities, a scoring profile, a canonical `asOfWeek`/`asOfAt` cutoff, and caller-owned
seed/checksum provenance. It fails closed on a missing week, implicit component behavior, invalid
probability, incoherent attempts/completions, targets/receptions, kick makes/attempts, malformed
cutoff, unsupported position, or malformed window.

The core evolves availability and log-role state across deterministic seeded antithetic Monte
Carlo paths. Its log-role intercept gives the unbounded stationary process an arithmetic mean of
one, and supported football identities are restored after shocks. It aggregates each complete
scenario before calculating empirical P15/P50/P85, so marginal weekly intervals are never summed
and quantiles are never moved to contain the arithmetic mean. Weekly means are explicitly
unconditional: bye and unavailable paths contribute zero, including when expected games is zero.
Output also includes expected games, standard deviation, scenario-mean raw components,
serial-correlation diagnostics, and a browser-safe canonical 64-hex SHA-256 seed digest. Simulation
draws use xoshiro128\*\* with all 128 state bits derived from that digest; the 12288-path release run
remains an exact prefix of its 16384-path reference. Quantiles remain labeled `simulation-only`;
this package does not claim historical calibration.
`diagnoseFirstPartyRosConvergence` deterministically compares the 12288-path release run with its
16384-path seeded reference, reports declared tolerances without changing the forecast, and names
the worst metric with its tolerance ratio so a failure identifies whether expected games, the
center, or a quantile dominates. Model v4 raised the release count from 512 because the absolute
tolerance floors (for example one point on P15) demand a quantile standard error 512 paths cannot
deliver for wide season distributions.

`evaluateFirstPartyRosChampionPolicy` is a leakage-safe evaluation skeleton. It selects the richer
candidate only by position and remaining-weeks bucket, against the availability-aware recency
challenger, after minimum MAE and standard median-backed WIS gates pass. Player rows are paired into
equal-weight season/cutoff blocks, and one-sided season-clustered uncertainty bounds must clear both
the improvement margin and interval-quality gate; a raw average improvement cannot promote the
model. Global readiness requires at least 300 paired rows, 30 distinct season/cutoff batches, and
three held-out seasons. Each position/window cell separately requires 18 paired rows spanning three
seasons, three distinct cutoff weeks, and nine season/cutoff blocks; a sparse cell is named and
withheld. This avoids the
mathematically impossible requirement that a 1–4-week cell itself contain 30 cutoff weeks. Every
forecast in a held-out season uses policy evidence from fully resolved earlier seasons; overlapping
cutoffs from that season update evidence together only after the season completes. Insufficient
evidence always defends recency.
Every held-out row requires an immutable SHA-256 input checksum, both candidate model versions, the
scoring-profile key, interval-method version, input coverage, actual and expected availability, and
checksummed convergence diagnostics. An evaluation cannot mix those model/scoring identities.
Derived evidence retains observed interval coverage, input coverage, availability error,
convergence rate, and its own canonical checksum.

Interval calibration is a separate, versioned season-blocked split-conformal CQR step within each
position, remaining-weeks, scoring-profile, candidate-model, and source-interval stratum. For each
fully resolved prior season/cutoff block, the calibrator takes the worst nonnegative P15/P85 CQR
nonconformity score in that block. It uses the finite-sample `ceil((n + 1) * 0.70)` order statistic
as a symmetric expansion, never a contraction, and leaves P50 unchanged. A calibration artifact is
created only after all global and cell readiness thresholds pass; it records the exact
training-through season, evidence checksum, method version, correction, and its own canonical
checksum. The policy for a season is frozen before that season's outcomes are added, so a season can
never calibrate its own intervals. `applyFirstPartyRosIntervalCalibration` returns raw intervals as
`not-calibrated` when the artifact is missing or fails checksum validation.

The artifact's fitted-block coverage is retained only as a construction diagnostic. Release quality
uses a separate season-walk-forward record: after a prior-season artifact is frozen, its expanded
intervals are scored against the next fully resolved season, with all players in a season/cutoff
block required to be covered for that block to count as a hit. These outcomes are stored per
position/window cell and selected strategy with their own checksum. The release gate requires the
configured walk-forward season, block, and row counts and compares nominal coverage only with this
genuinely out-of-sample record; fitted calibration-set coverage cannot satisfy the gate.

`evaluateFirstPartyRosReleaseGate` combines that immutable record with the live identity and
current coverage, availability, and convergence evidence. The identity comparison is
position-scoped on the scoring profile (byte-equal whole keys fast-path; otherwise the two keys are
compared as `projectionScoringProfileKeyForPosition` at the cell's position, failing closed on
unparseable keys and empty scoped vocabularies), and the availability-MAE ceiling withholds only on
the same one-sided evidence test the report gate applies — the point comparison survives as a
structural guard. Any identity mismatch, thin evidence, unstable convergence, coverage miss,
evidenced availability miss, bias miss, unavailable or invalid calibration artifact, or zero-game
window withholds the result. It cannot return `release` with `not-calibrated`; a success
identifies the validated artifact and labels the expanded interval `split-conformal-cqr`.
The worker runs the hourly shadow audit and managed release publisher as separate rails. A shadow
run can record degraded evidence but cannot write league projection sets. Release requires an
explicitly admitted, immutable artifact whose scoring identity matches the league; every
position/window cell then re-clears identity, coverage, convergence, availability, bias, and
calibration gates. A withheld cell never removes the prior good league set.

The current rest-of-season reference uses model `laces-ros-distribution-v7`. Every current profile
grades 3,264 forecasts across 68 season/cutoff batches, converges all 144 release/reference
diagnostics, and completes all 18 evidence cells. The generic Full PPR, Half PPR, and Standard
artifacts have clean gate-only re-evaluations admitted under the current availability rule. The two
ESPN-shaped v9 artifacts include complete D/ST scoring and native source lineage; each withholds only
the D/ST 5–8 week cell after 0 of 4 walk-forward blocks covered. All other cells remain
independently releasable. The kicker path uses a calibrated integer count process, and every scoring
profile is validated independently rather than inheriting another profile's result.

These historical seasons are development evidence. The final untouched confirmation remains the
pre-registered [2026 protocol](../../docs/ros-v6-2026-untouched-protocol.md), which cannot execute
until the 2026 regular season resolves. Operational commands, admission rules, and current
per-profile status live in [`docs/operations.md`](../../docs/operations.md).
