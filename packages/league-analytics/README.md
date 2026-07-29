# `@fantasy/league-analytics`

Pure TypeScript analytics for normalized fantasy-league data. Nothing in this package calls a
provider or consumes proprietary rankings; callers supply scores, schedules, projections, and
rest-of-season values from whichever public, custom, or user-owned sources they choose.

## Main APIs

- `analyzeLeagueSeason` returns weekly and season points for/against, actual and all-play records,
  all-play expected wins, luck versus actual results, and ratio-of-totals lineup efficiency.
- `analyzePositionalStrength` turns supplied positional values into league-relative midrank
  percentiles, population z-scores, ranks, and per-team coverage-aware aggregates.
- `calculatePowerRankings` builds a disclosed 0-100 composite. Every team result includes raw
  inputs, normalization, configured and effective weights, contribution, deterministic rank, and
  movement. Missing factor weights are redistributed among that team's available factors.
- `buildOpponentScout` computes raw opponent deltas plus direction-aware advantages against the
  subject team and optional league average.
- `simulatePlayoffOdds` runs deterministic, seeded Monte Carlo simulations over the remaining
  schedule and returns playoff/seed probabilities, expected final record, expected seed, and
  Monte Carlo standard error.

## Matchup Outlook

Matchup Outlook scores completed player-game components under the league's normalized scoring
profile, grouped by the player's week-specific roster position and defensive opponent. A completed
game contributes only when schedule, roster, identity, participation, and stat coverage are all
admitted. Missing coverage makes that game-position incomplete rather than a plausible zero.

Opponent adjustment uses only games completed before the target game. It compares the observed
position total with a shrunk pregame expectation for that offense, then aggregates the defensive
residual around the league positional mean. The current policy uses equal game weights, four
offense-shrinkage games, four defense-shrinkage games, and four prior-season pseudo-games. Future
schedule weeks are equally weighted; affirmed byes are counted but excluded from the average.

The output is intentionally descriptive. A locked 2023–2024 candidate-selection fold and untouched
2025 confirmation fold did not establish stable favorable/difficult labels for QB, RB, WR, or TE
across standard, half-PPR, and full-PPR scoring. The API may therefore show league-scored raw and
adjusted points allowed, percentiles, point differentials, coverage, and confidence, but it does
not promote those values into directional matchup claims or projection adjustments. The pinned
validation inputs and checksums are recorded in
[`docs/schedule-edge-validation-2026-07-27.json`](../../docs/schedule-edge-validation-2026-07-27.json).

Roster outlook joins that descriptive context to the claimed roster and separately checks bye-week
lineup feasibility with the deterministic slot-assignment engine. It returns Covered, Thin, Gap,
or Unknown; simple position counts are insufficient because flex and multi-position eligibility
change whether a legal lineup exists.

## Missing data and ties

A team without a score in an included week is marked missing, never assigned a zero or loss.
Scheduled matchups count only when both scores exist. All-play comparisons use only teams with a
score that week. Expected wins are calculated only for completed matchups with a valid weekly
all-play comparison rate. Every relevant API accepts or documents its tie tolerance.

Lineup efficiency requires an optimal score; when present, actual points default to the official
weekly score. Inconsistent inputs where actual exceeds optimal remain visible and are listed in
`inconsistentWeeks` rather than silently capped.

## Playoff simulation model

Future weekly scores are independent normal draws using each team's supplied projected mean and
volatility. Missing means fall back to current points per game and then the league mean; missing
volatility uses the configured league default. A sampled team score is reused across every matchup
in the same week, including doubleheaders. Final standings sort by win percentage, points for, then
team ID. The seed, formulas, fallbacks, and tie-breakers are all returned with the result.
