# ROS Gate Hardening and D/ST Weekly Projections — Implementation Plan

- Status: **complete 2026-07-29** — WP0–WP4 landed with all pre-registered bars passing. **WP4's
  flip ran.** WP3 first closed fail-safe (206/209 established but unpriceable); the operator then
  ratified a **de minimis zero** criterion for those two IDs — stated before it was applied, with
  citable occurrence bounds, in `docs/dst-stat-id-evidence-2026-07-29.md` §4 — which made them
  priced rather than approximated. See "WP3-RESULT AMENDMENT" and "WP4 RESULT" below. D/ST now
  normalizes with zero reasons for all three fixture leagues; espn-league-b and espn-league-c are
  the repo's first fully-supported six-position leagues, and espn-league-a is K + D/ST.
  <br />An earlier version of this line said the flip did not run. That was true when WP3 closed and
  stopped being true when the amendment landed; it is corrected here rather than only 500 lines down.
- Last updated: 2026-07-29
- Companion to: `docs/LEAGUE_SCORING_NORMALIZATION_PLAN.md` (implemented 2026-07-29),
  `docs/ROS_AVAILABILITY_PLAN.md`, `docs/ros-v6-2026-untouched-protocol.md`, `docs/PROJECTIONS.md`

**Two goals, in order.**

1. **WP0 — harden the ROS live release gate.** Its evidence identity compares the league's _whole_
   scoring profile key against the admitted artifact's. Any scoring drift at all — a mid-season
   commissioner edit to one kicker bracket, or this plan's own D/ST flip — changes that key and
   takes the league's **entire** ROS rail dark until a fresh ~4.4h validate + admit. Making the
   comparison position-scoped, per cell, contains the damage to the positions actually affected.
2. **WP1–WP4 — publish weekly D/ST projections for the three real ESPN leagues.** Their D/ST scoring
   is ESPN's default set, and the engine currently cannot price two parts of it, so every D/ST row is
   withheld — correctly, but withheld.

The two are linked by one fact: the D/ST flip changes those whole keys, so **the flip is gated on
WP0 being landed.** Modeling and mapping (WP1, WP2) do not change any key and may ship before WP0
lands; only WP4's flip waits.

**Scope boundary — ROS D/ST is not in this plan.** The ROS rail structurally never releases D/ST:
`HISTORICAL_ROS_SUPPORTED_POSITIONS` is `["QB","RB","WR","TE","K"]`
(`apps/worker/src/first-party-ros-backtest.ts:61`), consumed by
`first-party-ros-candidate-provider.ts:131,143` and `first-party-ros-publication.ts:153,195,229`.
WP0 hardens how the ROS gate compares scoring identity; it does not add a position to that rail. ROS
D/ST would be a separate rail-shaped project with its own walk-forward validation and admission, and
this plan does not start it.

**Tech Stack:** TypeScript, Vitest.

---

## 0. Measured evidence (verified against the working tree, 2026-07-29)

### 0.1 What blocks D/ST today

All three leagues carry an identical D/ST rule set. Normalization already attributes every failure
to D/ST alone, so QB/RB/WR/TE/K publish today — **12 D/ST-scoped fatal reasons per league** remain,
asserted against the sanitized real-league fixtures at
`packages/projections/src/league-scoring.test.ts:840-846` (leagues B and C) and `:803-806`
(league A):

| Reason code               | Base stat IDs                          | Count | Mechanism                                                                 |
| ------------------------- | -------------------------------------- | ----: | ------------------------------------------------------------------------- |
| `NONLINEAR_RULE`          | 128, 129, 130, 132, 133, 134, 135, 136 |     8 | `:slot:16` overrides on yards-allowed brackets with no per-unit component |
| `UNSUPPORTED_PLAYER_RULE` | 206, 206, 209, 209                     |     4 | bare + `:slot:16` rows for two IDs in `ESPN_UNSUPPORTED_DEFENSE_STAT_IDS` |

The measured ESPN yards-allowed ladder in those fixtures
(`league-scoring.test.ts:119-134`, identical in all three leagues):

| ID  | bracket | points | ID  | bracket | points |
| --- | ------- | -----: | --- | ------- | -----: |
| 128 | <100    |     +5 | 133 | 400–449 |     −3 |
| 129 | 100–199 |     +3 | 134 | 450–499 |     −5 |
| 130 | 200–299 |     +2 | 135 | 500–549 |     −6 |
| 131 | 300–349 |    (0) | 136 | 550+    |     −7 |
| 132 | 350–399 |     −1 |     |         |        |

131 appears in **no** league's rule set, consistent with ESPN omitting a scoring item worth zero in
every slot. This ladder is the evidence-established ESPN vocabulary, supported by community
vocabulary and exact default-value correspondence across three sources. **It is not to be
re-derived, re-guessed, or "improved" by this plan.**

Because D/ST is unsupported, its rules are excluded from the emitted profile entirely — the
fixtures assert the leagues' profiles contain **no** `points_allowed*` and no `defensive_sacks`
rule (`league-scoring.test.ts:848-851`). So the already-mapped points-allowed ladder is not being
priced either; it is withheld along with everything else D/ST.

### 0.2 What the engine already does, and can be reused verbatim

- **Points-allowed tier probabilities are already modeled.**
  `deriveTeamDefensePointBuckets` (`packages/projections/src/first-party.ts:615-652`) centers a
  Gaussian point mass on the projected `points_allowed`, with a recency-weighted historical
  variance and a standard deviation clamped to `[5, 18]`, evaluates it over the integer grid
  `0..80`, and writes one probability per bucket. Bucket definitions live at
  `first-party.ts:551-600` (`COMMON_/YAHOO_/ESPN_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS`,
  `TEAM_DEFENSE_POINTS_ALLOWED_BUCKET_GROUPS`, `TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS`). **This is
  WP1's template, named explicitly so no one invents a second shape.**
- **The projector's two-step ordering.** `projectFirstPartyTeamDefenseComponents`
  (`first-party.ts:2820-2950`) first runs every component through the shrinkage/opponent/context
  loop (`:2852-2891`), then overwrites the bucket centers via `deriveTeamDefensePointBuckets` and
  re-clamps their bands (`:2893-2899`). `defenseContextMultiplier` (`:2687-2705`) returns 1 for
  probability components and already carries a `yardsAllowedMultiplier` for `yards_allowed`
  (`:2701-2703`).
- **Observed bucket outcomes are derived, not stored.** `defenseComponentValue`
  (`first-party.ts:2643-2660`) turns a history row's `points_allowed` into a 0/1 indicator for any
  points-allowed bucket component the row lacks. The backtest's "actual" comes from that same
  function (`:3080`), so extending it is what makes new buckets scoreable.
- **The weekly defense gate.** `runFirstPartyTeamDefenseBacktest` (`first-party.ts:3032-3126`)
  walk-forwards with same-week-locked calibration; `recencyOnlyDefenseBaseline` (`:2984-3005`) is
  the challenger; `evaluateFirstPartyTeamDefenseBacktestForScoringProfile` (`:3129-3238`) scores
  both under a league profile. The worker runs it twice: once on the publication-gate profile
  (`apps/worker/src/first-party-projections.ts:1225-1233` → `projectionModelGate`, `:618-666`,
  defense sample floor 48 at `:628-630`) and once per league on that league's own normalized
  profile (`:2832-2835`), gated by `defenseEvaluationClearsGate` (`:835-839` →
  `pointEvaluationClearsGate`, `:822-833`).
- **Publication is already per-position.** D/ST rows are emitted only when normalization supports
  DST _and_ the league-scored defense gate clears (`first-party-projections.ts:2870-2893`), and the
  D/ST row loop itself is guarded by `defensePublishable` (`:3010-3052`). Withheld positions carry
  their own reasons (`:2843-2892`), which the status surfaces read per position
  (`apps/api/src/ros-projection-status.ts:509-513`;
  `apps/api/src/schedule-edge.ts:879-891`). **Nothing downstream needs new plumbing to show a D/ST
  row — the flip is upstream.**

### 0.3 The calibration data that exists

`yards_allowed` is real, ingested, per-team-week history:
`buildFirstPartyDefenseHistory` (`apps/worker/src/first-party-projection-inputs.ts:331-381`) sets
`yards_allowed: component(opponent.components, "total_offensive_yards")` (`:372`), and
`total_offensive_yards` is `passing_yards + sack_yards_lost + rushing_yards`
(`packages/source-nflverse/src/team-weekly-stats-source.ts:341-342`, i.e. net yards, sack yardage
already negative). The weekly run loads four seasons (`historySeasonCount = 4`,
`first-party-projections.ts:88`; `projectionHistorySeasons`, `:513-518`), REG only — on the order of
1.5–2k completed team-weeks, against a defense gate that needs 48 predictions and 100 scored
samples. **The data for WP1 is already in the database; no new source is required.**

`COMPONENT_CAPS` already carries `yards_allowed: 800` and `1` for every points-allowed probability
(`first-party.ts:535-548`) — the pattern new probability components must follow, or `capFor`
(`:1214-1216`) returns `MAX_SAFE_INTEGER` and upper bands escape `[0,1]`.

### 0.4 Drift risk to fix en passant: the defense component vocabulary exists in three places

1. `TEAM_DEFENSE_COMPONENTS` (`packages/projections/src/first-party.ts:602-613`) — the superset;
   exported by `firstPartyTeamDefenseProjectionComponents` (`:2628-2630`).
2. `TEAM_DEFENSE_SCORING_COMPONENTS` (`packages/projections/src/league-scoring.ts:416-435`) — a
   hand-typed ESPN-only subset, and the gatekeeper of the `:slot:16` acceptance branch (`:919-927`).
3. `defenseStatIds` (`apps/worker/src/first-party-projections.ts:106-128`) — a third hand-typed
   copy, used by `hasRelevantRules` (`:818-820`) whose comment at `:2866-2869` explicitly relies on
   "D/ST's vocabulary is a subset of `defenseStatIds`" staying true.

Adding components to (1) without (2) and (3) breaks acceptance and silently re-classifies rules.
The DST position vocabulary itself is derived from (1) (`league-scoring.ts:44-52`), as are all three
`availableStatIds` unions — `firstPartyAvailableProjectionComponents`
(`first-party-projections.ts:743-753`), `rosAvailableProjectionStatIds`
(`packages/projections/src/ros-scoring-profiles.ts:214-224`), and the decisions package's
`availableComponents` (`packages/decisions/src/managed-projection-profile.ts:15-21`) — so those
three pick up new components automatically once (1) grows.

---

## 1. The line this plan draws: model vs approximation

A bracket rule pays on where a random variable lands, not on its mean. There are exactly three
things one can do with it:

1. **Approximate it** — score the bracket the projected mean falls into, or interpolate. This
   throws away the distribution and is what the codebase calls a nonlinear rule that "cannot be
   reconstructed from a projected total" (`league-scoring.ts:548-553`). **Forbidden here.**
2. **Model it** — model the distribution of yards allowed, integrate it over the ladder to get one
   probability per tier, price the expectation exactly (`Σ pᵢ · vᵢ`, which is what
   `scoreProjectionStatComponents` computes for probability components,
   `packages/projections/src/scoring.ts:174-181`), and then **measure the model against real
   outcomes** through the same walk-forward backtest and gate every other component clears.
3. **Refuse it** — leave the IDs unmapped and keep D/ST withheld with a stated reason.

**A tier probability model with backtest evidence is (2), not (1).** The distinction is not
rhetorical: (1) has no error measurement and no falsifier; (2) produces a per-week prediction that
the existing rail already scores against reality and can fail. The engine has been doing exactly (2)
for points allowed since before this plan. If (2)'s evidence does not clear its pre-registered bars,
the answer is (3) — never (1).

---

## WP0 RESULT — completed 2026-07-29: gate aligned and position-scoped, arbitration recorded

Landed in two commits (gate, then arbitration), ratified as Amendment 4 of
`docs/ros-v6-2026-untouched-protocol.md` using §0c's drafted text, and recorded as WP4b in
`docs/ROS_AVAILABILITY_PLAN.md`. No ceiling, α, frozen identity row, or version constant moved.
Amendment 4(A) shipped alongside: the live gate's availability-MAE comparison is the report gate's
evidence test (point comparison retained as a structural guard).

- **Steps 1–2, with one recorded deviation.** Live evidence rows keep their whole-key stamp; the
  position scoping happens **inside the gate**, which recovers both sides' profiles from their
  keys and compares `projectionScoringProfileKeyForPosition` at the cell's position — Step 2's
  stated preference (self-contained gate) applied to both sides, taken instead of Step 1's
  restamping because the live key is canonical by construction, the evidence rows keep carrying
  the league's whole identity for observability, and one mechanism in one place beats two. Both
  identity comparisons were scoped — the policy identity (`evidence-identity-mismatch`) **and**
  the interval-calibration artifact identity (`interval-calibration-unavailable`); scoping only
  the first is defeated by the second. An unparseable key on either side fails closed; the three
  version fields stay whole and strictly compared.
- **Step 3 — arbitration, tie-break recorded verbatim at the function.** With the gate scoped,
  two admitted artifacts whose scoped keys agree on some positions could both publish one league
  (verified: per-artifact target enumeration, artifact-checksummed idempotency keys — no
  collision). `selectFirstPartyRosArtifactForLeague` now arbitrates one artifact per league:
  (1) whole-key equality wins outright, latest `admittedAt` among whole-key matches — and the
  only behavior when the league profile/positions are not supplied, keeping the self-key dedupe
  byte-identical; (2) otherwise most matched supported positions wins; (3) tie → latest
  `admittedAt`; (4) tie → lexicographically greatest `artifactChecksum`. The publication pass
  skips a target whose league arbitrates to a different artifact and surfaces the count in run
  diagnostics (`ros_artifact_arbitration_skipped_targets`); when arbitration selects nothing,
  evaluation proceeds so the decision itself states the mismatch, preserving the existing
  preserve-prior-set behavior.
- **Step 4.** `"[]"` never matches — enforced in the gate and already enforced in the matcher.
- **Step 5.** The seam test inverted ("publishes a partially matched league's matched positions in
  the production evidence shape") and the service-side seam comment rewritten; a new service test
  pins a two-artifact league arbitrating to exactly one set with the skip recorded.
- **Step 6.** The inertness pin: one frozen profile on both sides decides exactly as whole-key
  equality did — releasing fixture releases with no reasons, withholding fixture withholds on
  exactly its evidence reason, and a 6-position × 3-bucket matrix raises no
  `evidence-identity-mismatch`. One honest caveat: live-gate **evidence checksums** move, because
  the evidence-test α and the per-bucket row-error bound joined the checksum's threshold record —
  content addressing recording a real input, with decisions unchanged; admitted artifact
  checksums are untouched.
- **Steps 7–8.** Amendment 4 ratified and appended (the §0c draft verbatim, marked applied); the
  frozen availability criterion row now reads as the coverage criterion has since Amendment 3.
  The stale copies were swept — with the note that `docs/PROJECTIONS.md` does not exist in the
  tree; the prose the plans attributed to it lives in `docs/operations.md`, which got the dated
  alignment section, alongside the methodology manifest/page copy.

**What a league sees is still governed by admitted evidence:** the admitted-cell-blocker ratchet
is untouched, so cells named by the currently admitted artifacts stay withheld until a later
replay clears them and is admitted. WP0 changed how identity is compared — never what the
evidence must show.

---

## WP0 — Position-scoped evidence identity in the live release gate

**Operator decision, 2026-07-29: this is the chosen route and the plan's first work package.** It is
not a D/ST prerequisite that happens to be useful; it is a fix to a fragility class that the D/ST
flip merely happens to trigger first.

### 0a. The fragility class

The emitted scoring profile is exactly the union of the _supported_ positions' own rules
(`emittedRules`, `packages/projections/src/league-scoring.ts:1331-1338`). Any change to a league's
rules — a commissioner editing one kicker bracket in week 6, a provider adding a stat, or this plan's
D/ST flip — changes the **whole-profile key**. Two ROS call sites read that whole key, and both fail
closed on it:

1. **Artifact selection is whole-key, and comes first.**
   `selectFirstPartyRosArtifactForLeague` (`apps/worker/src/first-party-ros-publication.ts:723-735`,
   called from `apps/worker/src/first-party-ros-projections.ts:806`) skips any artifact whose
   `scoringProfileKey !== leagueScoringProfileKey`. Select nothing and the per-position matcher never
   runs at all.
2. **The live release gate compares the whole key inside its evidence identity.**
   `evaluateFirstPartyRosReleaseGate` (`packages/projections/src/rest-of-season.ts:3139-3147`) adds
   `evidence-identity-mismatch` when `live.scoringProfileKey` differs from the admitted policy's, and
   `live.scoringProfileKey` is the league's whole normalized key
   (`apps/worker/src/first-party-ros-candidate-provider.ts:267,396,431`).

So **one changed rule anywhere takes every position of that league's ROS rail dark**, and it stays
dark until someone notices, adds a catalog profile, runs `ros:validate` (~4.4h, measured 2026-07-29)
and admits it. The blast radius is the whole league; the cause may be a bracket only kickers score.
Position-scoped identity contains the damage to the positions actually affected.

Per-position matching **already exists downstream** and is not the gap: `matchFirstPartyRosPositions`
(`first-party-ros-publication.ts:199-259`) compares byte-equal position-scoped keys via
`projectionScoringProfileKeyForPosition`, on the stated basis that positions never interact
numerically (`:203-207`); `enumerateFirstPartyRosScoringMatchedLeagues`
(`first-party-ros-candidate-provider.ts:150-208`) drives it. The gap is that **selection and the live
gate are still whole-key**, so the per-position layer above them can admit a league that the gate
underneath then refuses on every cell.

**That truth is already pinned by a production-shaped test.** `first-party-ros-publication.test.ts` →
`"cannot publish a partially matched league in the production evidence shape"` (`:402-437`, written
2026-07-28) asserts `scoringProfileMatches: true`, `evidence-identity-mismatch` on the bucket, and
`canPublish: false` — and its own comment names it "RECORDED SEAM for
docs/ROS_AVAILABILITY_PLAN.md". A second comment block at
`first-party-ros-projection-service.test.ts:516-529` documents the same seam from the service side.
**WP0 is the work those comments were left for, and both must be updated by it** — the seam test
inverts from "cannot publish" to "publishes the matching positions".

### 0b. The design

Each ROS cell **is** a `position:bucket`: live evidence rows are built per bucket carrying their own
`position` (`first-party-ros-candidate-provider.ts:388-397`), and the gate finds its policy choice by
`position === live.position && bucket === live.bucket`
(`packages/projections/src/rest-of-season.ts:3136-3138`). The identity comparison is therefore
already per-cell in every field except the one that matters.

- [ ] **Step 1: Stamp live evidence with the position-scoped key.** In
      `buildFirstPartyRosLeagueTarget` (`first-party-ros-candidate-provider.ts:267,388-397`), each
      evidence row's `scoringProfileKey` becomes
      `projectionScoringProfileKeyForPosition(leagueProfile, thatRow.position)` instead of the shared
      whole key computed at `:267`. The target's own `leagueScoringProfileKey` (`:431`) keeps its
      whole-key meaning — it is what selection and the report surfaces use.
- [ ] **Step 2: Compare per cell in the gate.** In `evaluateFirstPartyRosReleaseGate`
      (`rest-of-season.ts:3139-3147`), the artifact side of the comparison becomes the artifact
      profile's key **for that cell's position**. **A decision to make and record here, not to leave
      implicit:** derive it inside the gate from `policy.evidenceIdentity.scoringProfileKey`
      (self-contained; the gate must then treat an unparseable artifact key as
      `evidence-identity-mismatch`, never as a pass — the analogue of
      `everyRailPositionWithheld("artifact-scoring-profile-key-unreadable")` at
      `first-party-ros-publication.ts:222`), or pass the expected per-position key in alongside the
      live evidence. Prefer the first; take the second only if parsing inside the gate is judged to
      widen its surface. **The other three identity fields — both model versions and the interval
      method version — stay whole and stay compared.**
- [ ] **Step 3: Make selection position-scoped too, or Step 2 never runs.**
      `selectFirstPartyRosArtifactForLeague` (`first-party-ros-publication.ts:723-735`) must select
      the most recently admitted artifact matching **at least one supported position's** scoped key,
      with whole-key equality still winning outright when present. Record the tie-break rule for two
      artifacts matching different positions — this plan does not pre-decide it, but it must be
      written down before code merges: "most recently admitted" across disjoint position sets is a
      silent-wrong-output hazard, not a style choice.
- [ ] **Step 4: Fail closed on the empty case.** A position-scoped key of `"[]"` is never a match —
      the existing rule at `first-party-ros-publication.ts:243-246` and
      `packages/projections/src/scoring-position-keys.ts` state this requirement, because two empty
      subsets are not evidence of identical scoring. Re-assert it at the gate.
- [ ] **Step 5: Update the pinned tests.** `first-party-ros-publication.test.ts:402-437` (the seam)
      and the comment block at `first-party-ros-projection-service.test.ts:516-529` both describe
      today's whole-key behavior as deliberate; both change. Add: a league differing from the
      artifact **only** in D/ST publishes all five rail positions; a league differing in K publishes
      four and withholds K with `scoring-profile-position-mismatch`; a corrupt artifact key releases
      nothing.
- [ ] **Step 6: Prove inertness on the frozen corpus.** The untouched 2026 run scores every position
      under one profile (`laces-out-historical-ros-ppr` v1 — the frozen row in
      `docs/ros-v6-2026-untouched-protocol.md:53`), so each position's scoped key derives from that
      same profile on both sides and **every comparison returns exactly what whole-key equality
      returned**. Pin it with a test, not an argument: same corpus, same decisions, before and after.
- [ ] **Step 7: Ratify Amendment 4 (below) before merging.** The live release gate is
      untouched-protocol territory.

### 0c. Amendment 4 — draft text for operator ratification at kickoff

Two live-gate alignments, batched into **one** amendment because they are the same defect — the live
gate lagging a decision already ratified or already shipped on the report side — and because
ratifying them separately would mean two amendments touching the same function.

> **Amendment 4 (2026-07-29, pre-kickoff, justified):** two alignments of the **live release gate**
> (`evaluateFirstPartyRosReleaseGate`, `packages/projections/src/rest-of-season.ts`) with decisions
> already in force elsewhere in the rail. Ratified by Mack. No 2026 outcome influenced this
> amendment.
>
> **(A) Availability MAE — the live gate adopts gate v3's evidence test.** Amendment 3 (2026-07-22)
> replaced a point-estimate comparison with a one-sided exact binomial evidence test at α = 0.10 for
> interval coverage, and the same remedy was applied to the availability MAE ceilings on the report
> side on 2026-07-28: `firstPartyRosAvailabilityEvidenceOfExcessMae` (`rest-of-season.ts:98`), used
> by `apps/worker/src/first-party-ros-backtest.ts:246-261` as `point comparison AND evidence test`.
> **The live gate was not updated** and still fails a cell on the bare point comparison
> (`rest-of-season.ts:3187-3193`), so a cell can be admitted by the report and refused by the live
> gate on the same numbers. This amendment applies the identical conjunction in the live gate: a cell
> fails `availability-error-above-threshold` only when its MAE exceeds the ceiling **and** the record
> is statistical evidence that its true MAE does, at the same α = 0.10 and the same per-bucket
> maximum row error. **Every ceiling is unchanged** (1.5 / 2.75, `rest-of-season.ts:51-52`); only how
> evidence against them is weighed changes. The signed-bias ceiling deliberately keeps its point
> comparison, for the reason recorded at `rest-of-season.ts:63-66`. The frozen release criterion at
> `docs/ros-v6-2026-untouched-protocol.md:83` is superseded and reads as the coverage criterion at
> `:87-88` already does.
>
> **(B) Scoring identity becomes position-scoped, per cell.** The gate's evidence identity compares
> the league's whole scoring profile key against the admitted artifact's, so any scoring difference
> in any position refuses **every** cell — including cells whose own scoring is byte-identical to
> what the artifact's evidence was measured under. Positions never interact numerically (a rule
> outside position P's component vocabulary contributes exactly 0 to P's score,
> `apps/worker/src/first-party-ros-publication.ts:203-207`), so a byte-equal position-scoped key is
> the same evidentiary claim the whole key was making, restricted to the cell it is being made about.
> Each cell is a `position:bucket`, so the comparison is made per cell against the artifact profile's
> key for that cell's position. The other three identity fields — contextual model version, recency
> model version, interval method version — remain whole and remain compared.
>
> **Inertness on the untouched proof:** the 2026 untouched run scores every position under the single
> frozen profile `laces-out-historical-ros-ppr` v1 (frozen identity row,
> `docs/ros-v6-2026-untouched-protocol.md:53`). Both sides of every comparison derive from that one
> profile, so (B) cannot change any 2026 cell decision; it can differ only for live leagues whose
> profiles differ from the artifact's, which the frozen corpus does not contain. (A) can change a live
> decision only in the direction of admitting a cell the report already admits. Both are pinned by
> tests that replay the frozen corpus before and after and require identical decisions. **No frozen
> identity row, threshold, ceiling, α, corpus, seed, or decision rule is modified.**

- [ ] **Step 8: Append the ratified text** to `docs/ros-v6-2026-untouched-protocol.md` in the
      established Amendment format (`:5-11` is the model), and update the stale copies the
      normalization plan already flags: `docs/PROJECTIONS.md` and the withheld-cell copy in
      `apps/web/src/app/methodology/evidence.ts`.

**Exit criteria:** the live gate's identity comparison is per-cell and position-scoped; artifact
selection no longer collapses a partial match to no match; a league that changes one position's
scoring keeps publishing every other position; the frozen-corpus replay is decision-identical before
and after; Amendment 4 is ratified and appended. **No ceiling, α, or frozen identity changed.**

---

## WP1 RESULT — completed 2026-07-29: all four pre-registered bars pass

Implemented exactly on the points-tier template: nine `yards_allowed_*_probability` components on
the §0.1 ladder (including the unpriced 300–349 tier), group-shaped buckets
(`TEAM_DEFENSE_YARDS_ALLOWED_BUCKET_GROUPS`, one ESPN group, structured for a later Yahoo ladder),
`deriveTeamDefenseYardBuckets` called in both champion and baseline, `defenseComponentValue`
extended so the backtest has its 0/1 actuals, caps at 1, and the strictly-prior sentinel, sum-to-1,
ordering and bye tests. **The dispersion was measured before the constants were written**
(`docs/dst-yards-allowed-calibration-2026-07-29.md`): grid 0..800 step 1, σ clamp [55, 115],
variance fallback 7225 — measured from 1,632 team-weeks of 2023–2025 REG history, not reused from
the points model.

The pre-registered bars were frozen in that document before measurement, and all four passed on
the 2026-07-29 walk-forward run (1,632 predictions, seasons 2023–2025): probability sums exact to
2.89e-15; **Brier skill +0.01267 over strictly-prior climatology**; reliability gap ≤ 0.0291 in
every bracket against a 0.05 bar; and the weekly D/ST gate clears all five conditions on the
leagues' ESPN-default D/ST profile (MAE 4.816 ≤ baseline 5.153, coverage 0.700, |bias| 0.069).
Full numbers with sample counts are recorded in the calibration document's "Measured results".

Per Step 8, stated plainly: the league-scored gate discriminates only the center adjustment —
champion and baseline share the bucket derivation — so bars 2 and 3 are the tier-model evidence,
and both clear. Nothing here measures whether ESPN's "yards allowed" is exactly nflverse net
offensive yards; that stays a disclosed assumption for WP4 Step 4.

---

## WP1 — Yards-allowed tier probabilities in the defense projector

Modeled on the points-allowed tiers, calibrated from ingested history, measured by the existing
weekly defense gate plus a probabilistic calibration check.

- [ ] **Step 1: Fix the vocabulary from the established ladder — do not re-derive it.** Nine
      components, named on the existing `points_allowed_<lo>_<hi>_probability` convention:
      `yards_allowed_0_99`, `_100_199`, `_200_299`, `_300_349`, `_350_399`, `_400_449`, `_450_499`,
      `_500_549`, `_550_plus` (each `…_probability`). Boundaries come from §0.1 and nowhere else.
      Map them to IDs 128–136 in that order. **131/300–349 gets a component even though no league
      prices it** — the ladder must partition the yards axis or the probabilities do not sum to 1.
- [ ] **Step 2: Build them with the group shape, not a flat list.** Mirror
      `TEAM_DEFENSE_POINTS_ALLOWED_BUCKET_GROUPS` (`first-party.ts:583-600`): an ESPN group now, a
      structure that admits Yahoo's 12-bucket ladder later (IDs 70–81, today
      `YAHOO_YARDS_ALLOWED_BUCKET_IDS` → `DEFENSE_NONLINEAR`, `league-scoring.ts:310-323,833`)
      without restructuring. **Yahoo's boundaries are not established and stay unsupported.**
- [ ] **Step 3: Extend `defenseComponentValue`** (`first-party.ts:2643-2660`) to derive a 0/1
      indicator for a yards bucket from a row's `yards_allowed`, exactly as it does for
      points-allowed buckets. Without this the backtest has no "actual" and the whole package is
      unmeasurable.
- [ ] **Step 4: Add `deriveTeamDefenseYardBuckets`, structurally parallel to
      `deriveTeamDefensePointBuckets`** (`first-party.ts:615-652`), centered on the projected
      `yards_allowed` (which already carries opponent and context adjustment), and call it beside
      the existing derivation in `projectFirstPartyTeamDefenseComponents` (`:2893-2899`) **and** in
      `recencyOnlyDefenseBaseline` (`:2984-3005`) so champion and baseline stay comparable. Add
      `1`-valued `COMPONENT_CAPS` entries for all nine components (`:535-548`).
- [ ] **Step 5: Calibrate the dispersion from measured history — never from the points model's
      numbers.** The points model's grid (`0..80`) and σ clamp (`[5,18]`) are points-scale
      constants; reusing them for yards would be a guess wearing a template's clothes. Measure, from
      the loaded four-season team-week history: the distribution of weekly `yards_allowed`, the
      distribution of per-team residual standard deviations, and the resulting σ clamp band and grid
      resolution. Record the measurement (sample count, seasons, quantiles) in the session evidence
      file before writing the constants.
- [ ] **Step 6: Pre-register the pass bars before measuring anything.** Written down first, changed
      afterwards only with a recorded reason: 1. The nine probabilities sum to 1 ± 1e-6 and each lies in `[0,1]`, for every projected team-week. 2. **Brier skill score > 0 against climatology** (the training-window base rate of each
      bracket) on strictly-prior walk-forward predictions, for the ladder as a whole. 3. **Reliability**: for each bracket with ≥ 100 walk-forward samples, |mean predicted −
      observed frequency| ≤ 0.05. 4. The existing weekly D/ST gate (`defenseEvaluationClearsGate`,
      `first-party-projections.ts:835-839`) clears on the three leagues' ESPN-default D/ST
      profile, including the beat-the-recency-baseline and interval-coverage conditions.
- [ ] **Step 7: Measure.** Run `npm run projections:validate -w @fantasy/worker`
      (`apps/worker/scripts/validate-first-party-projections.ts`, which already exercises
      `runFirstPartyTeamDefenseBacktest` + `evaluateFirstPartyTeamDefenseBacktestForScoringProfile`
      at `:290`) against a D/ST profile carrying the ESPN default ladder, and record every bar's
      measured value with its sample count and date.
- [ ] **Step 8: State what the gate does and does not prove.** Champion and baseline share the same
      bucket derivation, so on the bracket components the league-scored gate discriminates only the
      context/opponent/shrinkage adjustment — bar 2 and bar 3 are what test the tier model itself.
      Write this into the plan's measured-results section rather than claiming the gate "validated"
      the brackets.
- [ ] **Step 9: Tests.** Bucket probabilities sum to 1; a team with a low projected `yards_allowed`
      carries more mass in the low brackets than a team with a high one; the derivation is
      strictly-prior (a future row cannot change a past prediction — the sentinel pattern at
      `packages/projections/src/first-party.test.ts:664-706`); bye/unscheduled returns zeros.

**Exit criteria:** the nine components are projected, sum to 1, and every pre-registered bar is
measured and recorded. If any bar fails, WP1 stops here, 128–136 stay unmapped, and D/ST stays
withheld — that is a successful outcome of this package, not a failure of it.

---

## WP2 RESULT — completed 2026-07-29: 128–136 mapped, one vocabulary, keys unmoved

Landed only after WP1's bars were measured and passed. The three sanitized fixtures re-measured
exactly to the plan's prediction: the 8 `NONLINEAR_RULE` reasons are gone, **exactly 4
`UNSUPPORTED_PLAYER_RULE` reasons remain per league (206 ×2, 209 ×2)**, D/ST is still unsupported,
the emitted profiles carry zero `yards_allowed*` and zero `points_allowed*` rules, and every
league's whole-profile key is **byte-identical before vs after** (verified against HEAD's
normalizer directly and via the pinned catalog keys) — so nothing about this package disturbs ROS
matching.

- `TEAM_DEFENSE_SCORING_COMPONENTS` and the worker's `defenseStatIds` are now both derived from
  `firstPartyTeamDefenseProjectionComponents()` — one vocabulary by construction. The Yahoo-only
  tier omission was established as non-load-bearing before collapsing (the set is consulted only
  at the ESPN `:slot:16` acceptance gate, which also requires an ESPN-mapped base component; no
  Yahoo-only tier is ESPN-mapped), and the safety argument is recorded at the definition. Drift
  tests cover the map↔engine correspondence and the nine components' presence in all three
  `availableStatIds` unions.
- 128–136 map to the nine tier components in ladder order (131 included); they left
  `ESPN_NONLINEAR_STAT_IDS` and `ESPN_NONLINEAR_STAT_ID_BASE_COMPONENTS` (126 and 137 stay), the
  dead `yards_allowed` branch of `nonlinearReasonForBaseComponent` is gone, and the
  `yards_allowed`-vs-ladder `AGGREGATE_OVERLAPS` entry guards the double-count trap. A bare 128
  arriving with nonzero points is now a mapped, priceable D/ST rule — the old inversion test
  asserts the new truth.
- **Step 8 (points-allowed ladder):** corroborated from three concordant documented maps —
  121=PA18/18-21, 122=PA22/22-27, 123=PA28/28-34, 124=PA35/35-45, 125=PA46/46+ — matching the
  repo's mapping exactly, so **no adjustment was made**. ESPN's own settings page was unreachable
  through this session's proxy and the live `scoring_rules` rows were not readable from this
  environment; what stands is documented-community corroboration, recorded with quotes and URLs in
  `docs/dst-stat-id-evidence-2026-07-29.md` §3. The leagues' absent 121/122 rows read as ESPN
  omitting zero-point rungs, exactly as 131 is omitted from the yards ladder.

---

## WP3 RESULT — completed 2026-07-29: both IDs established, both stay unsupported, reasons name them

> **SUPERSEDED IN PART, 2026-07-29 — see "WP3-RESULT AMENDMENT" and "WP4 RESULT" below.** Everything
> this section establishes about 206's and 209's meanings and about the data gap stands unchanged
> and is load-bearing for what replaced it. What is superseded is exactly two things: the decision
> "**both stay in the unsupported set**", and the line "**pricing at a remembered rate stays
> forbidden**" as it applies to these two IDs — the operator ratified a de minimis zero model that
> is neither an ingested measurement nor a remembered rate. Nothing else in this section, and no
> other ID, is affected.

The decision package's deliverable is "no," with better evidence than the plan asked for:

- **206 is established — "2pt Return" (`2PRET`)**, the generic two-point-return category beside
  offense/defense-specific 204/205; and **209 is established — "1pt Safety" (`1PSF`)**, beside
  207/208 — three concordant documented maps each (espn-api `constant.py`, the nntrn ESPN API
  gist, ffscrapr), quoted with URLs in `docs/dst-stat-id-evidence-2026-07-29.md`. 209 moves from
  "meaning unestablished" to "established, unpriceable."
- **Neither is priceable, and the reason is data, not modeling.** Verified against the live
  nflverse assets and their generator: `stats_team_week` and `stats_player_week` carry no
  defensive two-point or one-point-safety column (only the three offensive 2pt conversion counts);
  the events exist solely in play-by-play (`defensive_two_point_attempt/conv`, GSIS 403/404), and
  the repo has no pbp source. Pricing either is a new-data-source project; pricing at a remembered
  rate stays forbidden. Decision: **both stay in the unsupported set.**
- **Step 4 is code, not prose:** the generic "team-defense category has no matching projection
  component" reason is replaced by per-ID reasons for 204–209 naming the ID, its established
  meaning, and the data gap, flowing through both the bare-rule path and the `:slot:16` override
  path to the status surfaces. The sourced citation sits beside the table in `league-scoring.ts`.

**Consequence for WP4:** with 206 and 209 established-but-unpriceable and present in all three
leagues' rule sets at nonzero points, D/ST support still fails closed on exactly those two named,
sourced blockers. WP4's flip therefore does not run — the designed outcome the plan names, not a
shortfall. The flip becomes reachable the day a pbp-derived team-week source prices 206/209 (or
the leagues drop those rules), and WP0 has already removed the ROS sequencing hazard that used to
stand in front of it.

---

## WP3-RESULT AMENDMENT — 2026-07-29, operator-ratified: 206 and 209 priced by a de minimis zero model

The blocker WP3 identified was real but not the only way through. The operator ratified a third
option the plan had not enumerated: **price a component at a constant zero when publicly citable
occurrence data bounds its contribution to nothing.** The criterion was written before it was
applied and lives in `docs/dst-stat-id-evidence-2026-07-29.md` §4:

> **De minimis zero.** A scoring component may be modeled at constant zero ONLY when publicly
> citable occurrence data bounds its expected fantasy points below **0.01 per team-week** at the
> league's own point values. The bound, its source, its denominator and its arithmetic must be
> recorded here before the component is emitted.

Measured bounds, both recorded with citations, denominators and arithmetic in §4.2 and §4.3:

| ID  | component                     | occurrence record                                  | expected pts / team-week | headroom to 0.01 |
| --- | ----------------------------- | -------------------------------------------------- | ------------------------ | ---------------- |
| 206 | `defensive_two_point_returns` | 11 league-wide, 2015-2024, over 5,248 team-games   | 0.0042 (at 2 pts)        | ~2.4x            |
| 209 | `one_point_safeties`          | **zero in NFL history**; rule-of-three upper bound | 0.00057 (at 1 pt)        | ~17x             |

**Why this is not the thing the non-negotiables forbid.** It is a bounded, disclosed model claim
graded by the same gates — not a dropped rule (the rule is mapped, carried in the emitted profile
and multiplied into every scored line) and not a remembered rate (the shipped number is the floor of
a cited bound, with the citation and the arithmetic in the repo, not a recalled frequency). It is
falsifiable and revocable on its own terms: a future measurement putting either component at or
above 0.01 points per team-week revokes the licence and returns the component to modeled-or-withheld.

**Scope.** 204, 205, 207 and 208 keep their WP3 per-ID reasons and stay unsupported. The criterion is
per-component and evidence-gated: no bound has been recorded for those variants and no league in
scope carries one. Extending the zero set requires a new §4 subsection with its own citable bound
first.

**A correction, recorded rather than absorbed.** The ratification brief put one-point safeties at
"≈ 2 in NFL history." The citable record puts the NFL count at **zero**; the two are FBS college
occurrences (CBS Sports, dated 2026-06-30, quoted in §4.3). The correction strengthens the bound.

---

## WP4 RESULT — completed 2026-07-29: D/ST flips supported for all three fixture leagues

WP4's preconditions were met once the amendment above landed: WP0 is in (Step 0), and WP3's two IDs
resolved to a priced state. The flip ran.

- **Step 1 — normalization re-measured on all three sanitized fixtures.** espn-league-b and
  espn-league-c are now **available with all six positions supported** — the first fully-supported
  leagues in the repo. espn-league-a is **K + D/ST**: its six bare per-N-yard bonuses (17/18/37/38/
  56/57) still withhold QB/RB/WR/TE, exactly as WP3 left them. D/ST carries **zero** reasons in all
  three. The pre-flip assertions that D/ST rules must be ABSENT from the emitted profile are
  inverted in place, with the reason recorded at the assertion.
- **Step 4 — method warnings added.** `defenseMethodWarnings` gained the yards-allowed derivation
  disclosure this step asked for (net offensive yards = passing + sack yardage + rushing, stated as
  an assumption) and a `de_minimis_zero_components=` entry naming both IDs, the constant-zero claim,
  the 0.01 bound and the evidence file. That existing channel is the natural home for both — it
  already carries `points_allowed_method=` and `blocked_kicks_classification=` into every published
  set's metadata and every league's warning list — so no new disclosure channel was invented.
- **Step 5 — fixture updates.** Stat IDs and point values only; no league, team or member data. The
  three league fixtures were not edited at all (their 206/209 rows already existed). Three
  D/ST-unpriceable test fixtures elsewhere moved from `206` to `205` so they keep demonstrating what
  they were written to demonstrate — the ID changed, the behavior under test did not.
- **Step 6 — surfaces update without code changes.** Confirmed: the per-position status surfaces
  report D/ST from `normalizeLeagueScoringProfile`'s output with no edit. One consequence is
  recorded rather than patched (below).
- **Profile-key movement, and why the rail is unharmed.** The three leagues' WHOLE keys move — the
  plan always said they would, and WP0 exists for it. Pinned: **every SUPPORTED rail position's
  scoped key is byte-identical across the flip** (K for league A; QB/RB/WR/TE/K for B and C). League
  A's QB/RB/WR/TE scoped keys move from `"[]"` to `special_teams_touchdowns` — that rule is shared
  with D/ST and stops being excluded once D/ST is supported — and it is inert: those four positions
  are unsupported for league A before and after, and `matchFirstPartyRosPositions` withholds an
  unsupported position without ever comparing keys.
- **Finding, recorded not patched: `readiness.scoringProfile` now reads null for the real ESPN
  leagues.** That field is a WHOLE-key lookup into the ROS catalog. The leagues' whole keys now carry
  their D/ST rules; the byte-frozen `espn-standard-2pt` catalog entry does not. Null is the honest
  answer — naming that entry would claim the league is scored identically to an artifact that prices
  no team defense. **The catalog rule lists were deliberately NOT re-derived**: they are the
  identities admitted artifacts' held-out evidence was measured under, and their digests are
  published in `apps/web/src/app/methodology/evidence.ts`. The release gate is unaffected because
  WP0 made it per-cell; `packages/projections/src/ros-scoring-profiles.test.ts` now asserts the
  catalog entry equals the RAIL-POSITION subset of the league's normalized profile and pins each
  entry's key verbatim.

**Not done in this session, and why.** Steps 2, 3 and 7 need the live stack and live artifacts: the
league-scored D/ST gate on each league's own profile, the weekly sets' D/ST rows (including the bye
and kickoff-freeze paths), and the end-to-end proof that the ROS rail still publishes for Garagely
and The Android's Dungeon after the flip. The code paths are exercised by tests
(`apps/worker/src/first-party-projections.test.ts` covers publish-D/ST-when-the-gate-clears,
withhold-D/ST-when-it-does-not, and the bye/kickoff-freeze zero paths), but **Step 7 in particular is
an observation against live artifacts and remains outstanding.**

---

## WP2 — Mapping and component plumbing

Only after WP1's evidence exists. Mapping IDs to components the projector does not produce would
make normalization accept rules the engine cannot price.

- [ ] **Step 1: One source of truth for the D/ST component vocabulary.** Collapse
      `TEAM_DEFENSE_SCORING_COMPONENTS` (`league-scoring.ts:416-435`) and `defenseStatIds`
      (`first-party-projections.ts:106-128`) onto `TEAM_DEFENSE_COMPONENTS`
      (`first-party.ts:602-613`) via `firstPartyTeamDefenseProjectionComponents()`. Note the two
      lists differ today on purpose-looking grounds — `TEAM_DEFENSE_SCORING_COMPONENTS` omits the
      Yahoo-only tiers (`points_allowed_14_20/21_27/35_plus_probability`) that the superset and
      `defenseStatIds` both carry. **Establish whether that omission is load-bearing before
      collapsing it**; if it is, keep one derived subset with a comment stating why, not a second
      hand-typed literal. Add a test that fails when any copy drifts.
- [ ] **Step 2: Map 128–136** in `ESPN_PLAYER_SCORING_STAT_ID_MAP_V1` (`league-scoring.ts:326-414`)
      to WP1's nine components, in ladder order.
- [ ] **Step 3: Remove the now-wrong classification.** `classifyRejectedEspnDefenseSlotOverride`
      (`league-scoring.ts:887-903`) routes slot-16 bracket overrides to `NONLINEAR_RULE`; once
      mapped they take the acceptance branch at `:919-927` and never reach it. Drop 128–136 from
      `ESPN_NONLINEAR_STAT_IDS` (`:437-518`, entries at `:490-498`) and from
      `ESPN_NONLINEAR_STAT_ID_BASE_COMPONENTS` (`:530-546`) — that table exists only to attribute
      _unsupported_ nonlinear rules, and leaving stale entries there is the kind of dead branch that
      later reads as intent. Keep `nonlinearReasonForBaseComponent`'s yards-allowed wording
      (`:548-553`) only if some yards-allowed rule can still be nonlinear (Yahoo's ladder can);
      otherwise remove it with its last caller.
- [ ] **Step 4: Add the aggregate-overlap guard.** `AGGREGATE_OVERLAPS` (`league-scoring.ts:712-782`)
      already refuses a profile that prices both `points_allowed` and its tier probabilities
      (`:765-781`); the identical trap now exists for `yards_allowed` (ESPN ID 127, `:394`) versus
      the new ladder. Add the `yards_allowed` entry. **Watch item, not a required change:** the
      overlap failure attributes to all six positions (`:1237-1247`) even when both sides are
      D/ST-only vocabulary; narrowing that to the owning positions is defensible but needs its own
      test and is out of scope here.
- [ ] **Step 5: Confirm the unions need no edits.** `firstPartyAvailableProjectionComponents`
      (`first-party-projections.ts:743-753`), `rosAvailableProjectionStatIds`
      (`ros-scoring-profiles.ts:214-224`) and the decisions package's `availableComponents`
      (`managed-projection-profile.ts:15-21`) all spread
      `firstPartyTeamDefenseProjectionComponents()`. Verify by test that the new components appear
      in all three, so `COMPONENT_UNAVAILABLE` cannot fire on a rule the run does emit.
- [ ] **Step 6: Optional, evidence-gated — display-name mapping.** ESPN's payload supplies no names
      for scoring items (`packages/connector-espn/src/web-client-normalizer.ts:1048-1069` sets
      `name: null` on the base rule), so the numeric map is the only path that matters for these
      leagues. Add `DISPLAY_NAME` entries (`league-scoring.ts:640-672`) only if a real payload is
      observed carrying them.
- [ ] **Step 7: Re-measure normalization** on all three sanitized fixtures. Expected after WP2:
      the 8 `NONLINEAR_RULE` reasons are gone; exactly 4 `UNSUPPORTED_PLAYER_RULE` reasons remain
      (206 ×2, 209 ×2); D/ST is **still unsupported**. Update
      `league-scoring.test.ts:793-806,840-846,1121-1128` to the new counts.
- [ ] **Step 8: Verify the points-allowed ladder is mapped to the tier ESPN means.** Independent of
      this plan's brackets, and cheap: the fixtures carry `123/124/125 = −1/−3/−5` with 121 and 122
      absent (`league-scoring.test.ts:113-118`), while the map reads 123 → `points_allowed_28_34`,
      124 → `35_45`, 125 → `46_plus` (`league-scoring.ts:391-393`). Either the leagues' ladder is
      genuinely shifted from the commonly cited ESPN default, or one of the two is off by a tier —
      and a shifted tier misprices D/ST silently while looking fully supported. Read the live
      `scoring_rules` rows for all three leagues and confirm against ESPN's own settings page.
      **If it cannot be established, say so and do not adjust the map.**

**Exit criteria:** every mapped ID is mapped to a component the projector actually produces; one
source of truth for the D/ST vocabulary with a drift test; normalization's remaining D/ST reasons
are exactly 206 and 209.

---

## WP3 — The 206 / 209 decision gate

After WP2 these are the **only** things standing between the three leagues and D/ST rows. This is a
decision package: its deliverable may legitimately be "no".

**206 — defensive two-point returns (2 pts).** Community-established meaning; a genuinely rare
event. The measured obstacle is not modeling, it is data: **no ingested source carries it.** The
nflverse team-weekly source exposes offensive two-point conversions only
(`packages/source-nflverse/src/team-weekly-stats-source.ts:54,61,69`), there is no play-by-play
source in the repo (`packages/source-nflverse/src/` has players, injuries, schedules, snap counts,
team-weekly, weekly-rosters, weekly-stats and nothing else), and `buildFirstPartyDefenseHistory`
(`first-party-projection-inputs.ts:353-375`) has no field it could populate.

- [ ] **Step 1: State the evidence bar for pricing 206, then answer it.** To price it the rail needs
      (a) an ingested source carrying defensive two-point returns per team-week, (b) a measured
      historical frequency with its sample size and seasons, (c) a projected component that clears
      the same walk-forward defense gate as everything else. **(a) does not exist today**, so
      pricing 206 is a new-data-source project, not a modeling step.
- [ ] **Step 2: Record the decision explicitly.** Either "keep 206 unsupported — reason: no ingested
      source carries the event, so it can be neither projected nor backtested" (the default, and the
      honest one), or an operator decision to take on the ingestion work as a prerequisite. Do not
      price it at a remembered league-average rate: an unmeasured constant is an approximation.
- [ ] **Step 3: 209 stays unsupported until its meaning is established from evidence.** It is
      unestablished even in community maps. ESPN's payload gives no display name
      (`web-client-normalizer.ts:1048-1069`), so the stored `statKey` is the numeric ID and cannot
      settle it. Named evidence avenues, in order of cost: the ESPN league settings scoring page for
      one of the three leagues (a human can read the label beside the 1-point rule); a documented
      community source with a citation; ESPN's own documentation. **Never guess.** If it cannot be
      established, it stays in `ESPN_UNSUPPORTED_DEFENSE_STAT_IDS` (`league-scoring.ts:579`) with
      its reason, and D/ST stays withheld.
- [ ] **Step 4: Whatever is decided, the withheld reason must name the ID and the cause** — the
      per-position reason text already flows to the status surfaces
      (`ros-projection-status.ts:509-513`), so "D/ST is unavailable" is never the whole message.

**Exit criteria:** each of 206 and 209 is either priced with backtest evidence behind it, or
unsupported with a written, sourced reason. **D/ST support then hinges only on rules actually
present in the leagues' rule sets** — no rule is ignored, none is approximated.

---

## WP4 — Flip and verify

> **RUN 2026-07-29 — see "WP4 RESULT" above for what landed and what is still outstanding (Steps 2,
> 3 and 7 need the live stack).** The checklist below is kept as written for provenance.

Reachable **only if both preconditions hold**: **WP0 is landed** (gate merged, Amendment 4 ratified
and appended), and WP3 resolved 206 and 209 to a priced-or-established state. If either is unmet, WP4
does not run, and the plan's outcome is WP0–WP3's evidence plus a D/ST withheld for one named,
sourced reason. That is the correct outcome, and it must be reported as one rather than as a
shortfall.

**The safe degenerate case is explicitly supported.** WP1 (modeling) and WP2 (mapping) change no
league's profile key — D/ST stays unsupported on 206/209, so its rules stay out of `emittedRules`
(`league-scoring.ts:1331-1338`) and every ROS key is byte-identical. They can ship while WP0 is still
in review. **Only this package waits.**

- [ ] **Step 0: Verify WP0 is landed — and stop if it is not.** The gate's identity comparison is
      per-cell and position-scoped, selection no longer collapses a partial match to no match, the
      frozen-corpus replay test passes, and Amendment 4 is ratified and appended to
      `docs/ros-v6-2026-untouched-protocol.md`. Flipping D/ST before that changes the three leagues'
      whole keys and takes the ROS rail dark for Garagely and The Android's Dungeon.
- [ ] **Step 1: Re-measure normalization** on all three leagues: D/ST supported, zero D/ST reasons,
      and the emitted profile now carries the D/ST rules that the fixtures currently assert are
      absent (`league-scoring.test.ts:848-851` — that assertion inverts).
- [ ] **Step 2: Confirm the league-scored defense gate on each league's own profile**
      (`first-party-projections.ts:2832-2835,2870-2874`). A league whose D/ST gate fails must
      publish its other positions and withhold D/ST with the backtest-gate reason (`:2875-2892`) —
      verify that path, do not assume it.
- [ ] **Step 3: Verify the weekly sets contain D/ST rows** for the three leagues, including the
      bye-week zero path (`:2331-2341`) and the kickoff-freeze path (`:3018-3031`).
- [ ] **Step 4: Add the method warning.** `defenseMethodWarnings`
      (`first-party-projections.ts:96-99`) already discloses the points-allowed derivation; add the
      yards-allowed one (net offensive yards = pass + sack yardage + rush), because whether ESPN's
      "yards allowed" matches that definition exactly is an assumption this plan states rather than
      proves.
- [ ] **Step 5: Sanitized fixture updates.** Stat IDs, operations and points only — no league,
      team, or member data — following the existing header at `league-scoring.test.ts:96-103`.
- [ ] **Step 6: Verify the per-position surfaces update without code changes**
      (`ros-projection-status.ts:509-513`, `schedule-edge.ts:879-891`, decisions'
      `managed-projection-profile.ts:75-89`). If any surface needs an edit to show D/ST, that is a
      finding to record, not a silent patch.
- [ ] **Step 7: Verify the ROS rail is still publishing** for Garagely and The Android's Dungeon
      after the flip — artifact selected, five rail positions released, no
      `ros_champion_artifact_absent` and no `evidence-identity-mismatch`. **Do this in the same
      session as the flip**: WP0 is what makes this pass, and it is only observable against live
      artifacts. This is the end-to-end proof that WP0 works, not a formality.
- [ ] **Step 8: Re-measure and record** — dated numbers, per league, superseding rather than
      overwriting.

**Exit criteria:** D/ST rows appear in the three leagues' weekly sets, each having cleared
normalization _and_ its own league-scored backtest gate; the ROS rail still publishes for the same
leagues it published for before the flip; no other position's behavior changed.

---

## Non-negotiables

- **No approximation anywhere.** A bracket is priced by integrating a modeled distribution over the
  established boundaries, or it is not priced. Scoring "the bracket the mean lands in", interpolating
  between tiers, or pricing a rare event at a remembered rate are all forbidden. **A tier
  probability model with walk-forward backtest evidence is a model, not an approximation** — the
  difference is that it makes falsifiable per-week predictions and is measured against them.
  **Amended 2026-07-29:** a **de minimis zero** is likewise a model, not an approximation, under the
  criterion in `docs/dst-stat-id-evidence-2026-07-29.md` §4 — publicly citable occurrence data must
  bound the component below 0.01 expected points per team-week at the league's own point values,
  with the bound, its source and its arithmetic recorded before the component is emitted. A rate
  recalled rather than cited is still forbidden, and so is a zero without a recorded bound.
- **Never guess a stat ID's meaning or a bracket boundary.** The 128–136 ladder is the
  evidence-established ESPN vocabulary. (209's meaning was established from three concordant
  documented maps on 2026-07-29 — see the WP3 result.) Unknown stays unknown, and unknown withholds.
- **Fail closed, position-scoped.** Every unpriceable rule withholds D/ST and nothing else, with its
  reason attached to the position.
- **Pre-register the bars.** Statistical thresholds are written down before the measurement that
  they judge; a bar moved afterwards must carry a recorded reason.
- **One source of truth for the D/ST component vocabulary.** No fourth hand-typed copy.
- **WP0 changes how evidence identity is compared — never what the evidence must show.** No ceiling,
  no α, no scenario count, no frozen identity row, no corpus, no seed, no decision rule. If a WP0
  change would alter a 2026 cell decision on the frozen corpus, it is the wrong change.
- **No frozen-protocol edit without ratification.** Amendment 4 is appended to
  `docs/ros-v6-2026-untouched-protocol.md` with its justification and its inertness argument before
  the gate change merges. The protocol's own amendment policy (`:98-104`) governs; nothing is
  smuggled in as a side effect of a D/ST change.
- **The ROS rail's position set is untouched.** `HISTORICAL_ROS_SUPPORTED_POSITIONS` stays
  QB/RB/WR/TE/K. WP0 hardens comparison, not coverage.
- **The flip never ships ahead of WP0.** WP4 Step 0 is a hard stop, not a reminder.
- **Sanitize fixtures.** Stat IDs and point values only.

## Exit criteria (whole plan)

1. **The ROS gate is position-scoped and provably inert on the frozen corpus.** A league that changes
   one position's scoring keeps publishing every other position; the frozen-corpus replay yields
   decision-identical results before and after; Amendment 4 is ratified and appended; no ceiling, α,
   or frozen identity row changed.
2. **No approximation anywhere.** Every priced D/ST rule is either a per-unit component or a tier
   probability with measured, recorded backtest evidence; every unpriceable rule withholds D/ST with
   a stated reason. The model/approximation line of §1 is stated in the shipped code's comments, not
   only here.
3. **D/ST rows appear for the three leagues' weekly sets only if every priced rule clears** —
   normalization supports D/ST with zero remaining reasons, _and_ the league-scored defense gate
   passes for that league. Either failing means no D/ST row and a reason the user can read.
4. **Every pre-registered bar has a measured value on record**, with sample counts and dates,
   including the ones that failed.
5. **ROS still publishes, verified against the live stack**: the ROS rail still releases exactly
   QB/RB/WR/TE/K, and the same leagues that matched an admitted artifact before the flip still
   publish after it.
6. **One D/ST component vocabulary**, with a test that fails on drift.
7. `npm run check` passes at the repo root.

## What this plan does not claim

- **It does not promise D/ST rows.** If 209's meaning cannot be established from evidence, or 206
  cannot be priced without a data source that does not exist yet, D/ST stays withheld and this plan
  delivers the yards-allowed model plus two named, sourced blockers. That is the designed outcome of
  a fail-closed system, not a shortfall. _(2026-07-29: both meanings were established and both were
  priced under the de minimis zero criterion, so normalization now supports D/ST for all three
  fixture leagues. It still promises no published row: each league's own league-scored D/ST backtest
  gate is a separate verdict, and a failure there withholds D/ST with its own reason.)_
- **It does not claim the de minimis zero is measured from ingested data.** It is not. No source in
  this repo carries either event; the claim is an upper bound taken from public occurrence records
  and shipped at its floor, disclosed in the evidence file, in the code comments, and in the
  published set's method warnings. If a pbp source is ever ingested, the measurement supersedes the
  bound.
- **It does not claim the weekly gate validates the tier model.** The gate compares a champion and a
  baseline that share the bucket derivation; the Brier-skill and reliability bars are what test the
  tier model, and they are reported separately.
- **It does not claim ESPN's "yards allowed" is exactly nflverse net offensive yards.** That is a
  stated assumption, disclosed as a method warning; if it is ever measured, the measurement
  supersedes the assumption.
- **It does not add D/ST to the ROS rail.** WP0 changes how the ROS gate compares scoring identity;
  it does not make ROS project or release a D/ST unit. That remains a separate project.
- **It does not claim the flip is ROS-neutral.** It is not: WP0 is what makes it safe, which is why
  the flip is gated on WP0 landing rather than on a hope.
- **It does not claim WP0 makes ROS more permissive.** Every artifact still releases only cells whose
  scoring is byte-identical to what its evidence was measured under. WP0 narrows the blast radius of
  a mismatch from the league to the position; it never widens what counts as a match.
- **It does not re-open the availability ceilings.** Amendment 4(A) aligns the live gate with the
  report side's already-shipped evidence test at the same α and the same ceilings; it changes no
  threshold.
- **It does not fix Yahoo's yards-allowed ladder** (IDs 70–81). Different boundaries, unestablished;
  it stays unsupported, and the group-shaped bucket structure is the only accommodation made for it.

## Execution checklist

1. **Ratify Amendment 4 first** (§0c). It is drafted for signature; WP0's gate change does not merge
   without it.
2. Read this plan, `docs/LEAGUE_SCORING_NORMALIZATION_PLAN.md` §"Measured results — 2026-07-29", and
   `docs/ros-v6-2026-untouched-protocol.md`.
3. Re-measure before starting: run the three sanitized fixtures through
   `normalizeLeagueScoringProfile` and confirm the 12 D/ST reasons per league still hold. The numbers
   above are dated.
4. WP0 and WP1 are independent and can run in parallel — different files, different rails. WP2
   follows WP1; mapping IDs to components the projector does not produce is the one ordering mistake
   that ships a wrong number.
5. No `ros:validate` run is required by any package here. WP0 removes the need for one; WP1–WP3 never
   had one.
6. Do not start WP4 until **both** WP0 is landed and WP3's decisions for 206/209 are written down
   with their sources.
7. Run `npm run check` before declaring any package done.
8. Record measured results with dates; supersede rather than overwrite.
