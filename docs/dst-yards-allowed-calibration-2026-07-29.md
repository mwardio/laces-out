# D/ST yards-allowed tier model — calibration evidence and pre-registered bars

- Date: 2026-07-29
- Plan: `docs/plans/ROS_GATE_AND_DST_PLAN.md` WP1 Steps 5–6
- Status of this file: the dispersion measurement and the pass bars below were recorded **before**
  any backtest measurement ran, per WP1 Step 6. Measured results are appended afterwards as dated
  sections; nothing above the "Measured results" heading may be edited after the first measurement.

## 1. Dispersion measurement (WP1 Step 5)

Source: nflverse `stats_team_week_<season>.csv` (the exact dataset
`packages/source-nflverse/src/team-weekly-stats-source.ts` ingests), seasons 2023–2025, REG only —
the same four-season window the weekly run loads at a 2026 as-of (`projectionHistorySeasons(2026)`
= 2023..2026; 2026 holds no completed regular-season rows on 2026-07-29). `yards_allowed` computed
exactly as the repo does: opponent net offensive yards = `passing_yards + sack_yards_lost +
rushing_yards` (sack yardage negative), reciprocal team-week join, floored at 0 by the worker's
`component()` guard.

- Sample: **1,632 team-weeks**, **96 team-seasons**. Zero rows floored at 0 (minimum observed 58).
- Weekly `yards_allowed`: mean 331.9, SD **84.97**, min 58, max 726.
  Quantiles: p1 139, p5 193, p10 223, p25 273, p50 333, p75 389, p90 436, p95 470, p99 526.
  The distribution is near-symmetric (p1 and p99 sit 193 and 194 yards from the median).
- Per-team-season residual SD around the team-season mean (≥4 games, n=96): mean 81.3,
  min 50.4, p5 62.9, p25 72.1, p50 79.9, p75 91.2, p95 106.2, p99 111.2, max 112.8.
- Observed frequency per ESPN ladder bracket (denominator 1,632):
  0–99: 0.0037 · 100–199: 0.0558 · 200–299: 0.2996 · 300–349: 0.2108 · 350–399: 0.2206 ·
  400–449: 0.1342 · 450–499: 0.0539 · 500–549: 0.0153 · 550+: 0.0061.

## 2. Constants derived from the measurement (recorded before implementation)

The derivation mirrors `deriveTeamDefensePointBuckets` structurally: the σ it uses is the
league-wide recency-weighted dispersion of the training window around its own recency-weighted
center, computed at projection time; the constants below only bound degenerate estimates and fix
the integration grid. None of the points model's scale constants (grid `0..80`, σ clamp `[5,18]`,
variance fallback 100) are reused.

- **Grid: integers 0..800, step 1.** nflverse net yards are integers, every ladder boundary is an
  integer, and 800 is `COMPONENT_CAPS.yards_allowed` — the same cap that bounds the projected
  center. 801 nodes cost nothing measurable. A step-1 grid also keeps the bucket predicate exact at
  the 99/100 and 349/350 boundaries, which a coarser grid would blur.
- **σ clamp: [55, 115].** The measured per-team-season residual SDs span 50.4–112.8 over 96
  team-seasons; the league-wide weekly SD is 84.97. The clamp bounds a degenerate thin-history
  estimate to just outside the measured support: 55 sits between the observed minimum (50.4) and
  the 5th percentile (62.9); 115 sits just above the observed maximum (112.8).
- **Variance fallback (fewer than 2 usable rows): 7225 (σ = 85).** The measured league-wide weekly
  SD, 84.97, rounded — the analogue of the points model's fallback variance 100 (σ = 10, its own
  league-wide weekly SD).
- **Guard `totalMass > 0`** before renormalizing. With σ ≥ 55 on a 0..800 grid the Gaussian mass at
  the node nearest any in-range center is ≈ 1, so this cannot fire in practice; it exists so a
  degenerate input degrades to a thrown-out projection rather than `NaN` probabilities reaching
  `scoreProjectionStatComponents`, which asserts finiteness over every component.

## 3. Pre-registered pass bars (WP1 Step 6 — written before measurement)

Recorded verbatim from the plan before any backtest ran; a bar moved afterwards must carry a
recorded reason.

1. The nine probabilities sum to 1 ± 1e-6 and each lies in [0, 1], for every projected team-week.
2. **Brier skill score > 0 against climatology** on strictly-prior walk-forward predictions, for
   the ladder as a whole. Climatology for a prediction at week _w_ is the observed frequency of
   each bracket over history rows strictly prior to _w_ — the same strictly-prior discipline the
   backtest itself obeys.
3. **Reliability:** for each bracket with ≥ 100 walk-forward samples,
   |mean predicted − observed frequency| ≤ 0.05.
4. The existing weekly D/ST gate (`defenseEvaluationClearsGate`) clears on the three leagues'
   ESPN-default D/ST profile — sample floor, beat-the-recency-baseline, interval coverage in
   [0.62, 0.78] with ≥ 100 samples, and the bias bound.

Bar 4 measures the whole D/ST score under the league profile; bars 2 and 3 are what test the tier
model itself, because champion and baseline share the bucket derivation (plan WP1 Step 8).

## Measured results

_Appended after the bars above were frozen._

### 2026-07-29 — WP1 walk-forward measurement: all four bars pass

Run: `npm run projections:validate -w @fantasy/worker` (seasons 2023–2025, REG), 1,632 walk-forward
defense predictions, constants exactly as frozen in §2 — none adjusted.

1. **Probability sum — pass.** Max |Σ − 1| over all 1,632 predictions: 2.89e-15 (bar ≤ 1e-6);
   every bracket probability finite in [0, 1].
2. **Brier skill vs climatology — pass.** n = 1,600 (the 32 week-1-2023 predictions have no
   strictly-prior rows and are excluded from both sides). Multi-class Brier, ladder as a whole:
   model 0.787402 vs climatology 0.797506 → **BSS +0.01267 > 0**.
3. **Reliability — pass, every bracket ≤ 0.05** (all at 1,632 samples ≥ 100):
   0–99 gap 0.0160 · 100–199 0.0134 · 200–299 0.0146 · 300–349 0.0032 · 350–399 0.0291 (worst) ·
   400–449 0.0071 · 450–499 0.0088 · 500–549 0.0077 · 550+ 0.0018.
4. **Weekly D/ST gate on the leagues' ESPN-default D/ST profile — pass, all five conditions.**
   samples 1,632 ≥ 100; MAE 4.8164 ≤ baseline 5.1529 (6.53% better, baseline > 0); interval
   coverage 0.7000 ∈ [0.62, 0.78] at 1,600 samples; |bias| 0.0690 ≤ 0.7225.

The unchanged publication-gate profile run stayed `publishable` with no reasons (defense overall:
MAE 4.3193 vs baseline 4.5309, coverage 0.7169, bias −0.0392).

**What the gate does and does not prove (plan WP1 Step 8):** champion and baseline share the
bucket derivation, so bar 4's league-scored margin discriminates only the context/opponent/
shrinkage adjustment of the yards center. Bars 2 and 3 are the evidence for the tier model itself
— the ladder's walk-forward probabilities beat strictly-prior climatology and sit within 0.03 of
observed frequencies in every bracket. Neither bar is evidence about ESPN's own definition of
"yards allowed"; that remains the stated method assumption the flip must disclose (WP4 Step 4).
