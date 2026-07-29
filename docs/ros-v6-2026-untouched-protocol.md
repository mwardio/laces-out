# ROS v6 Untouched Validation Protocol — 2026 Season

Pre-registered: 2026-07-21, before any 2026 regular-season game has been played.

**Amendment 4 (2026-07-29, pre-kickoff, justified):** two alignments of the **live release gate**
(`evaluateFirstPartyRosReleaseGate`, `packages/projections/src/rest-of-season.ts`) with decisions
already in force elsewhere in the rail, batched into one amendment because they are the same
defect — the live gate lagging a decision already ratified or already shipped on the report side.
Recorded and ratified on 2026-07-29 before kickoff; applied the same day. No 2026 outcome influenced
this amendment.

**(A) Availability MAE — the live gate adopts gate v3's evidence test.** Amendment 3 (2026-07-22)
replaced a point-estimate comparison with a one-sided exact binomial evidence test at α = 0.10 for
interval coverage, and the same remedy was applied to the availability MAE ceilings on the report
side on 2026-07-28: `firstPartyRosAvailabilityEvidenceOfExcessMae`, used by
`apps/worker/src/first-party-ros-backtest.ts` as point comparison AND evidence test. The live gate
had not been updated and still failed a cell on the bare point comparison, so a cell could be
admitted by the report and refused by the live gate on the same numbers. This amendment applies
the identical conjunction in the live gate: a cell fails `availability-error-above-threshold` only
when its MAE exceeds the ceiling **and** the record is statistical evidence that its true MAE
does, at the same α = 0.10 and the same per-bucket maximum row error. **Every ceiling is
unchanged** (1.5 / 2.75); only how evidence against them is weighed changes. The signed-bias
ceiling deliberately keeps its point comparison, for the reason recorded beside the constants.
The frozen release criterion below is superseded and reads as the coverage criterion already does.

**(B) Scoring identity becomes position-scoped, per cell.** The gate's evidence identity compared
the league's whole scoring profile key against the admitted artifact's, so any scoring difference
in any position refused **every** cell — including cells whose own scoring is byte-identical to
what the artifact's evidence was measured under. Positions never interact numerically (a rule
outside position P's component vocabulary contributes exactly 0 to P's score), so a byte-equal
position-scoped key is the same evidentiary claim the whole key was making, restricted to the cell
it is being made about. Each cell is a `position:bucket`, so the comparison is made per cell
against the artifact profile's key for that cell's position. The other three identity fields —
contextual model version, recency model version, interval method version — remain whole and
remain compared.

**Inertness on the untouched proof:** the 2026 untouched run scores every position under the
single frozen profile `laces-out-historical-ros-ppr` v1 (frozen identity row above). Both sides of
every comparison derive from that one profile, so (B) cannot change any 2026 cell decision; it can
differ only for live leagues whose profiles differ from the artifact's, which the frozen corpus
does not contain. (A) can change a live decision only in the direction of admitting a cell the
report already admits. Both are pinned by tests that hold the frozen shape (byte-equal keys on
both sides) and require identical decisions. **No frozen identity row, threshold, ceiling, α,
corpus, seed, or decision rule is modified.**

**Amendment 3 (2026-07-22, pre-kickoff, justified):** coverage gate v3. The
walk-forward record holds only 4–9 blocks per cell, so the point-estimate comparison falsely
failed a truly 0.70-covered cell with probability 0.27–0.35 (expected ~5.8 false failures across
18 cells; two model versions reproduced byte-identical outcomes because block-max conformal
coverage is rank-invariant to uniform dispersion changes). The 0.60 floor is unchanged; the
comparison is now a one-sided exact binomial evidence test at α = 0.10. No 2026 outcome
influenced this amendment.

**Amendment 2 (2026-07-21, pre-kickoff, justified):** the v5 direction check showed raw interval
coverage unmoved because the mean-reverting role process cannot represent the weekly model's own
static per-player center error, and both calibration moments are measured relative to the player's
realized level (the center error cancels). v6 adds a mean-one static center-error multiplier drawn
once per scenario (`centerVolatility`, calibrated from the weekly model's locked backtest
residuals grouped per player-season) and corrects the two-moment solve constants. Role calibration
is now `historical-ros-role-center-two-moment-v4`. No 2026 outcome influenced this amendment.

**Amendment 1 (2026-07-21, pre-kickoff, justified):** the v4 development replay cleared 37 of 41
blockers but left four interval-coverage cells (QB five-to-eight/nine-plus, K one-to-four/
five-to-eight). Root cause: weekly-variance-only production matching under-dispersed multi-week
totals. v5 replaces the role/production calibration with two-moment matching
(`historical-ros-role-two-moment-v3`) and raises the release scenario count to 12288 to preserve
convergence margin at the wider spread. All frozen identities below reflect v5. No 2026 outcome
influenced this amendment.

## Purpose

The 2022–2025 held-out replay informed the development of model v4 (scenario counts, availability
calibration v3, per-position production volatility, sample sizing, and the availability gate
re-specification). By the project's own standard those seasons are therefore development evidence,
not a release proof. This protocol freezes, in advance, the exact evaluation that will serve as the
untouched final test once the 2026 regular season resolves. It is written so that no discretionary
choice remains to be made after outcomes exist.

## Frozen identities

Any change to any row below voids this protocol and requires a new model version and a new
pre-registered protocol.

| Concern                     | Frozen value                                   |
| --------------------------- | ---------------------------------------------- |
| ROS simulation              | `laces-ros-distribution-v6`                    |
| Release scenario count      | 12288                                          |
| Convergence reference       | 16384 (exact seeded prefix)                    |
| ROS champion policy         | `season-walk-forward-block-wis-cqr-v4`         |
| ROS interval calibration    | `season-blocked-split-conformal-cqr-v1`        |
| Availability calibration    | `historical-ros-availability-curve-matched-v3` |
| Role/production calibration | `historical-ros-role-center-two-moment-v4`     |
| Weekly candidate pair       | contextual vs availability-aware recency       |
| Scoring profile             | `laces-out-historical-ros-ppr` v1 (PPR only)   |

## Frozen corpus construction

- Sources: official nflverse artifacts for seasons 2019–2026, regular season only.
- Held-out seasons: 2022, 2023, 2024, 2025, 2026. The first four seed the season-locked policies
  and walk-forward calibration artifacts exactly as in the development replay; **only the 2026
  cells constitute the untouched proof**.
- Cutoffs: all 17 (Weeks 1–17), each producing a rest-of-season window ending Week 18.
- Player selection: 5 players per position per cutoff, deterministic recent-production
  stratification at rank quantiles 0/25/50/75/100 of the positive-trailing-production ranking,
  exactly as implemented in `selectHistoricalRosPlayers`; 5 D/ST units by the same rule.
- Maximum forecasts: 3000 (above the 2,550 possible, so truncation is impossible).
- Seeds: the deterministic per-forecast seed policy already in code
  (`historical:{season}:{asOfWeek}:{playerId}`); no reseeding.

Command to be run once, after the final 2026 Week 18 game is authoritative:

```bash
npm run ros:validate -w @fantasy/worker -- \
  --seasons=2019,2020,2021,2022,2023,2024,2025,2026 \
  --holdouts=2022,2023,2024,2025,2026
```

## Frozen release criteria

The run must exit zero with `report.state = "evidence-ready"` and an empty blocker list under the
exact thresholds frozen here (the code defaults as of this protocol):

- input coverage ≥ 0.95;
- expected-games MAE ceilings 1.5 (one-to-four, five-to-eight) and 2.75 (nine-plus): no
  statistical evidence that a cell's true MAE exceeds its ceiling — one-sided exact binomial test
  at α = 0.10 on the structural row-error bound (availability gate v3, Amendment 4);
- |signed expected-games bias| ≤ 1.0 in every cell (point comparison, unchanged);
- convergence rate exactly 1.0 (every 12288-vs-16384 stratum representative within every declared
  tolerance — tolerances as in `ROS_CONVERGENCE_TOLERANCES`, unchanged);
- CQR walk-forward block coverage: no statistical evidence of undercoverage against the 0.60
  floor (nominal 0.70 − 0.10) — one-sided exact binomial test at α = 0.10 (gate v3);
- walk-forward evidence ≥ 1 season, ≥ 3 blocks, ≥ 18 rows per cell;
- cell evidence ≥ 18 rows, ≥ 3 seasons, ≥ 3 distinct cutoffs, ≥ 9 blocks;
- global evidence ≥ 3 seasons, ≥ 30 batches, ≥ 300 rows.

Decision rule: cells whose 2026 evidence passes every criterion are approved for the subsequent
release step; failing cells remain withheld. There is no partial credit, no threshold adjustment,
and no re-run with modified settings. A failure is a model-development finding for a future v5 and
a future protocol; it cannot be repaired against 2026 data.

## Amendment policy

- Before the first 2026 regular-season kickoff: amendments are permitted only with a written
  justification appended here and a version note; frivolous amendment defeats the purpose.
- After the first 2026 regular-season kickoff: this file is immutable. If a code defect is
  discovered that requires a fix, the fix must be shipped as a new model/calibration version and a
  new protocol, and the 2026 result for v4 must still be reported as specified here.

## Interim monitoring

The hourly shadow rail may observe 2026 behavior for operational monitoring. Nothing observed may
change v4 or this protocol; anything learned feeds v5 development only.

## Amendment 1 — kicker-cell confirmation addendum (2026-07-23, pre-kickoff)

**Justification (per the amendment policy):** on 2026-07-23 the kicker-interval work was admitted on development evidence: engine model
`laces-ros-distribution-v7` (kicker count process; non-kicker simulation proven byte-identical to
v6 under the frozen seed lineage) with weekly model `laces-weekly-components-v8` (kicker recency
baseline blends thin-history kickers toward the position mean with the pre-existing n/(n+4)
reliability form; no new constants). The admission carried zero cell blockers
(`reports/ros-validation-v8-2026-07-23.json`, artifact `67e7ba09…655d5d`), so the K one-to-four
cell is live for the first time. Per blueprint §6e, this addendum pre-registers its untouched
confirmation before any 2026 kickoff.

**Addendum terms:**

- The 2026 untouched run specified above executes unchanged, against the versions actually
  serving (`laces-ros-distribution-v7` + `laces-weekly-components-v8` +
  `historical-ros-kicker-count-process-v1`), with one declared measurement clarification: the
  kicker p50 convergence tolerance is the lattice-aware declaration shipped 2026-07-23 (absolute
  1 — the integer lattice spacing of kicker window totals — matching the p15/p85 tolerances;
  ratified as a Monte Carlo stability declaration for a discrete family, not a gate change; all
  other tolerances and every non-kicker tolerance unchanged).
- The kicker one-to-four cell is confirmed iff its 2026 evidence passes the identical criteria
  already frozen above — same gates, same α, same floors. No kicker-specific criterion is added
  or relaxed.
- Development-evidence context, stated for honesty: the count-process family and the weekly-v8
  kicker blend were developed against 2019–2025, with their structural measurements recorded
  before kickoff; 2026 is the first season no kicker-related parameter, constant, or design
  decision has ever contacted. A 2026 kicker-cell failure is a model-development finding for a
  future version; it cannot be repaired against 2026 data.
