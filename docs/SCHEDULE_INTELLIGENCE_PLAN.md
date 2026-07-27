# Schedule Intelligence Enhancement Plan

- Status: proposed; implementation review resolved
- Last updated: 2026-07-27
- Target surface: `/schedule`
- Working product name: **Schedule Edge**

## 1. Objective

Turn the existing NFL Schedule page from a reference table into a focused fantasy decision tool.
The finished surface should answer three questions:

1. Which upcoming matchups materially help or hurt players on my roster?
2. Where will bye weeks leave my roster unable, or barely able, to field a legal lineup?
3. Which NFL teams and positions have the most useful upcoming schedules for waiver, trade, and
   playoff planning?

The official schedule remains available as supporting evidence. It is not the primary product.

## 2. Product decision

Keep the schedule data, public endpoints, and `/schedule` route. Replace the current page hierarchy
and navigation label with **Schedule Edge** once the completed experience passes the release
criteria in section 11. Build the complete experience behind the existing Schedule surface and
release it as one coordinated update.

The page should lead with personalized analysis for an authenticated member with a selected league.
A signed-out visitor should see a clearly labeled, fixed demo of the analytical experience plus the
real public NFL schedule. A member without a usable league should see the official schedule and a
direct explanation of what league data is needed to unlock the analysis.

Do not change lineup, waiver, trade, or projection values merely because an opponent receives an
easy or difficult label. Initially, schedule analysis is explanatory decision context. It may
become an engine input only after historical evaluation shows a repeatable improvement over the
existing projection and recommendation baselines.

## 3. Scope

### 3.1 Required first release

- League-scored, position-specific defensive matchup ratings for QB, RB, WR, and TE.
- Upcoming schedule strength for each NFL team and supported position.
- A personalized roster outlook for the selected league.
- Deterministic bye-week lineup feasibility for the claimed roster.
- A configurable near-term window and a fantasy-playoff window.
- Transparent sample size, freshness, confidence, and source provenance.
- A compact official-schedule reference view beneath the analysis.
- A complete signed-out demo and a useful mobile layout.
- Links from relevant roster findings to Decision Desk, Projections, or player detail rather than
  duplicating those tools.

### 3.2 Deferred until the core analysis is trustworthy

- Kicker and D/ST matchup ratings. Their scoring and available source components require separate
  completeness validation.
- Weather, travel distance, stadium surface, betting totals, and injury/news overlays.
- AI-written schedule summaries. The deterministic findings should stand on their own first.
- Automatic projection or waiver-value adjustments based on the new matchup rating.
- Push notifications derived solely from matchup difficulty.
- A new external data vendor. The first release should use admitted Laces Out data already refreshed
  by the worker.

### 3.3 Explicit non-goals

- Predicting game winners or NFL point spreads.
- Presenting last season's raw defensive ranking as a confident current-season forecast.
- Treating a missing schedule or weekly-stat row as a bye, zero, or neutral matchup.
- Producing a universal matchup grade that ignores league scoring.
- Rebuilding the lineup optimizer, waiver engine, trade engine, or Projections page inside this
  surface.

## 4. Current foundation

The repository already contains most required inputs and safety behavior:

- Public `GET /v1/schedule` and `GET /v1/schedule/byes` routes.
- Admitted nflverse schedule observations with checksums, coverage, freshness, rejected-row counts,
  rest days, kickoff times, results, and explicit `game`, `bye`, or `unknown` team-week states.
- Daily schedule and weekly-stat refreshes plus on-demand data refresh paths.
- Canonical NFL team and player identities.
- Stored league scoring rules, roster snapshots, roster-slot rules, team claims, and current week.
- League-scored weekly and rest-of-season projections.
- A test-only `calculatePositionFantasyPointsAllowed` prototype. It has useful shrinkage and
  completeness concepts but no production caller, and its game-enumeration behavior must be fixed
  before reuse.
- Existing scoring normalization and component scoring through
  `normalizeLeagueScoringProfile`, `scoreProjectionStatComponents`, and
  `projectionScoringProfileKey`.
- Week-scoped roster observations containing the position held by each player in that week.
- A deterministic lineup optimizer and roster eligibility model.
- Existing source-admission, freshness, provenance, and fail-closed conventions.

The main gaps are safe game/participation enumeration, opponent adjustment, historical validation,
orchestration, a member-scoped API contract, and the new UI.

## 5. Analytical definitions

All displayed metrics must have stable definitions in code and in the API response. Avoid labels
such as “smash spot” or “elite matchup” unless a disclosed numeric rule supports them.

### 5.1 Position fantasy points allowed

For each defensive NFL team and supported offensive position:

1. Enumerate completed defense-games from the admitted schedule, not from observed stat rows.
2. Require the admitted week-level roster artifact to affirm the participating player pool.
3. Join weekly stat rows to week-scoped roster position. Do not use the player's current primary
   position for a historical game.
4. Require every roster and stat row used by an included game to resolve to a canonical player and a
   supported week-scoped position.
5. Score complete player-game components with the selected league's normalized scoring profile.
6. Treat a rostered player with no stat row as zero only when schedule, roster, identity, and
   participation coverage all cleared admission.
7. Sum player points by defensive opponent, game, and position.
8. Calculate raw and opponent-adjusted points allowed over complete games only.
9. Retain the raw average, adjusted average, baseline, complete and incomplete game counts,
   unmatched row counts, and shrinkage weights.

An empty position slice is incomplete, not a complete zero. A completed scheduled game with missing
stat or roster coverage must increment the incomplete count. Any unmatched stat or roster row that
could affect the position total withholds that game-position observation.

Extend the existing league-analytics primitive rather than replacing its useful contracts, but fix
its current silent-zero behavior before connecting it to a production route. Fantasy points allowed
in Stats Center and Schedule Edge must use this one implementation and definition.

### 5.2 Scoring compatibility

Reuse the existing projections scoring stack:

- normalize stored rules with `normalizeLeagueScoringProfile`;
- score weekly components with `scoreProjectionStatComponents`; and
- identify semantically equivalent profiles with `projectionScoringProfileKey`.

Scoring compatibility is a first-class availability result. Fatal unsupported rules withhold the
affected metric. Ignored or separately modeled rule warnings remain visible in provenance and are
allowed only when they cannot change the supported offensive-position totals. Do not silently fall
back to standard or PPR scoring for a league whose rules failed normalization.

### 5.3 Opponent-offense and recency adjustment

Raw fantasy points allowed is confounded by the offenses a defense has faced. For each complete
defense-game-position:

1. Estimate the opposing offense-position expectation using only games completed before that game,
   shrunk toward the league positional mean.
2. Calculate the defense residual: actual points allowed minus that pregame expectation.
3. Express adjusted points allowed as league mean plus the defense's aggregated residual.
4. Carry raw and adjusted values together so the adjustment remains auditable.

The production policy must compare equal game weights with bounded recency-weighted candidates in
the historical gate. Select recency weighting only if it improves held-out performance without
making early-season estimates unstable. No target-week or future result may enter the offense
expectation.

### 5.4 Early-season baseline

Before the current season has enough completed games:

- use the prior season's same defense-position result when it cleared the same completeness checks;
- regress that result substantially toward the league-wide positional mean; and
- reduce the prior-season weight as current-season complete games accumulate.

The exact prior weight must be selected in historical evaluation and then locked in the definition.
If a team identity or prior sample cannot be trusted, use the positional league mean rather than a
guessed team prior.

During preseason and Weeks 1–4, the page leads with bye feasibility and official schedule facts.
Validated prior-season matchup context may appear only as **Low confidence**, with its prior-season
basis visible. A position receives no favorable/difficult language until its production policy's
minimum current-season support or validated preseason rule is satisfied.

### 5.5 Matchup score

For a scheduled offensive team and position, the opponent's adjusted fantasy points allowed becomes
the matchup input. Convert it to a within-position percentile:

- `0` means the most difficult admitted matchup in the comparison set;
- `50` is approximately league average; and
- `100` means the most favorable admitted matchup.

The UI may group percentiles into:

- **Favorable:** 67–100
- **Neutral:** 34–66
- **Difficult:** 0–33

Percentile alone does not earn a directional label. Favorable or Difficult must also clear a
versioned minimum league-scored point differential from the positional mean selected in historical
validation. A high percentile with a trivial point spread remains Neutral.

Always show the numeric percentile and league-scored point differential in detail. Ties use a
stable midrank. A grade is unavailable when its opponent-position input is unavailable.

### 5.6 Schedule strength

For an NFL team and position over a selected week range:

- join each scheduled game to that week's opponent matchup score;
- omit affirmed byes from the average while counting them separately;
- withhold unknown weeks rather than treating them as neutral; and
- calculate the simple mean of available matchup percentiles.

Future schedule weeks use equal weights. Recency, if validated, applies only while estimating the
defense's current strength; it does not make one future matchup count more than another.

Return:

- average matchup percentile;
- rank among NFL teams for that position and window;
- favorable, neutral, difficult, bye, and unknown week counts;
- the week-by-week opponent and rating; and
- coverage and confidence state.

### 5.7 Confidence

Confidence describes input support, not certainty about a player's performance.

- **High:** current-season metric with the historically validated minimum number of complete games.
- **Medium:** mixed current- and prior-season support.
- **Low:** predominantly prior-season or heavily shrunk support.
- **Unavailable:** schedule, participation, identity, scoring compatibility, or weekly-stat
  completeness failed.

The minimum-game thresholds and shrinkage weights are fixed by the validation work in section 6,
not chosen to make the current data look persuasive.

### 5.8 Roster outlook

Join the claimed roster to canonical NFL team, position eligibility, schedule, and matchup scores.
For each player, return:

- next game or affirmed bye;
- opponent and kickoff;
- position-specific matchup score, label, confidence, and sample size;
- selected-window schedule strength;
- fantasy-playoff schedule strength; and
- current weekly or ROS projection as separate context when a compatible projection exists.

Do not add the matchup score to a projection. Do not claim the schedule “raises” a player by a
specific number unless a future counterfactual projection model can support that statement.

### 5.9 Bye-week lineup feasibility

For every affirmed bye week in the selected range:

1. Remove rostered players whose NFL teams are on bye.
2. Apply the league's stored starter-slot and position-eligibility rules.
3. Determine whether any legal complete starting lineup remains.

Return one of:

- **Covered:** a legal lineup remains.
- **Thin:** a legal lineup exists, and at least one non-bye rostered player exists whose additional
  removal makes the lineup infeasible.
- **Gap:** no legal complete lineup can be formed.
- **Unknown:** roster, slot, identity, or schedule coverage is insufficient.

Reuse or extract the existing deterministic roster-assignment machinery. Do not implement this as
simple position counts; flex and multi-position eligibility make that answer unreliable. Enforce
the optimizer's existing limit of 30 unlocked starter slots and return `Unknown` when a league
exceeds the supported bound.

### 5.10 Fantasy-playoff window

Read provider-supplied regular-season and playoff-period fields from the already persisted
`league_seasons.settings.operationalRules` snapshot through a bounded typed parser. Use them only
when present, valid, and covered by tests for that provider. Otherwise default the view to Weeks
15–17 and label it **Weeks 15–17**, not “your playoffs.” The member may adjust the range in the page
controls without adding a new persisted preference in the first release.

## 6. Historical validation gate

The labels must demonstrate useful signal before they ship as recommendations.

Run locked, week-by-week historical evaluation across the 2023–2025 regular seasons. Add one
bounded 2022 weekly-stat, weekly-roster, and schedule backfill for evaluation support so the 2023
fold has a strictly prior baseline; do not expand the recurring production refresh window merely to
support the backtest.

1. For each target week, build defensive position metrics using only games completed before that
   week.
2. Build opponent-offense expectations using only information available before each evaluated game.
3. Compare unadjusted, opponent-adjusted, and bounded recency-weighted candidate policies.
4. Apply the same prior-season and shrinkage policy intended for production.
5. Compare the target-week result with each player's trailing performance baseline and actual
   league-scored points.
6. Evaluate QB, RB, WR, and TE independently under fixed representative standard, half-PPR, and
   full-PPR profiles.
7. Record sample counts, mean residual by difficult/neutral/favorable bucket, rank correlation,
   calibration by percentile band, and early- versus late-season performance.
8. Lock the minimum-game threshold, minimum point differential, opponent adjustment, recency policy,
   and prior/current weighting without looking at 2026 outcomes.

Release a position's favorable/difficult language only if the buckets show a stable, correctly
ordered relationship on held-out weeks, clear a meaningful point differential, and are not driven
by a small number of games. If a position does not clear the gate, display the underlying adjusted
points-allowed statistic as descriptive context or withhold it; do not imply predictive value.

Store the evaluation summary and policy version with the metric definition. Tests should use frozen
fixtures, while the full evaluation can run as a bounded script or worker diagnostic.

## 7. API and service design

### 7.1 Preserve the public facts API

Keep these routes public and user-independent:

- `GET /v1/schedule`
- `GET /v1/schedule/byes`

They remain the official schedule reference and a reusable source for the web page.

### 7.2 Add a member-scoped roster route

Add:

```text
GET /v1/leagues/:leagueId/schedule-edge
  ?startWeek=<1..18>
  &endWeek=<start..18>
  &playoffStartWeek=<1..18>
  &playoffEndWeek=<start..18>
```

The route requires authentication and league membership. Unknown and inaccessible leagues both
return `404`, matching existing league analytics behavior.

The response should contain:

- league, season, current week, selected team, and claimed-team identity;
- selected and playoff windows;
- separate availability states for schedule, scoring, defensive matchup data, roster, roster
  outlook, projections, and bye feasibility;
- source and policy provenance with checksums and observed/fetched timestamps;
- supported position definitions and validation status;
- personalized roster outlook;
- bye-week feasibility findings;
- definitions required to interpret every score and label.

Bound the response to the claimed roster and selected regular-season weeks. Do not return all league
rosters or another member's private projection set. Deterministically prioritized findings must
include the algorithm version and input hash required by ADR 0003.

### 7.3 Add a separately cached matrix route

Add:

```text
GET /v1/leagues/:leagueId/schedule-edge/matrix
  ?startWeek=<1..18>
  &endWeek=<start..18>
```

This route still requires authentication and league membership because the league chooses the
scoring profile. Its result contains no member roster data and is cached by semantic scoring profile
rather than member identity.

Return at most 32 NFL teams by four supported positions, with window summary and bounded
week-by-week detail. A separate request prevents the larger comparison matrix from delaying every
personalized roster read.

### 7.4 Service boundary

Create a dedicated `ScheduleEdgeService` rather than expanding `ScheduleService` into league-aware
analysis. The existing service remains responsible for admitted schedule facts and bye lookup.

Suggested boundaries:

```text
ScheduleEdgeRepository
  authorizeLeague(userId, leagueId)
  readLeagueContext(leagueId)
  readClaimedRoster(userId, leagueSeasonId)
  readRosterSlots(leagueSeasonId)
  readScoringRules(leagueSeasonId)
  readScheduleSource(season)
  readScheduleGames(season)
  readWeeklyStatSource(season)
  readWeeklyPlayerStats(season and optional prior season)
  readWeeklyRosterSource(season)
  readWeeklyRosterPlayers(season and optional prior season)
  readCompatibleProjectionContext(userId, leagueSeasonId)
```

Pure analytics belong in `packages/league-analytics`; authorization, bounded database reads, source
admission, and response assembly belong in `apps/api`.

### 7.5 Caching and refresh

Compute on request first. The expected user count and data bounds do not justify a new materialized
table before measurement.

Use a short in-process cache only if profiling shows a need. Roster-result keys must include:

- league season and claimed team;
- the semantic `projectionScoringProfileKey`;
- schedule source checksum;
- current- and prior-season weekly-stat checksums;
- current- and prior-season weekly-roster checksums;
- roster snapshot identity;
- projection-set identity when projection context is included;
- selected windows; and
- analysis policy version.

Matrix-result keys omit member and roster identity and include the semantic scoring profile key,
source checksums, selected window, and policy version. Hash the semantic key for storage or logging
rather than exposing the raw serialized profile.

The existing daily source refresh, hourly forecast sweep, provider sync, and on-demand refresh paths
are sufficient inputs. A changed checksum must invalidate the result immediately. The UI should
show when schedule facts, matchup observations, roster state, and projections were last checked.

## 8. Web experience

### 8.1 Page hierarchy

For a member with a usable selected league:

1. **Header and controls** — selected league, current week, analysis window, playoff window, and
   freshness.
2. **What matters now** — at most three findings: lineup gap, major bye collision, or strongest and
   weakest roster schedule swing. Do not fill this area with neutral observations.
3. **My roster** — compact player rows sorted by immediate decision relevance, not alphabetically.
4. **Bye pressure** — only weeks with `Thin`, `Gap`, or `Unknown` first; covered weeks remain
   available in detail.
5. **NFL schedule strength** — filterable team-by-position comparison for waiver and trade research.
6. **Playoff window** — a focused view of the same metric for the selected late-season weeks.
7. **Official schedule** — collapsed or secondary reference containing the current schedule board.
8. **Method and sources** — definitions, sample sizes, freshness, coverage, and attribution.

### 8.2 Roster finding priority

Sort findings by:

1. no legal bye-week lineup;
2. upcoming affirmed bye affecting a likely starter;
3. difficult next matchup for a close lineup decision;
4. strong or weak multiweek schedule with adequate confidence;
5. neutral or low-confidence context.

Projection context may help prioritize which roster players are likely starters. It must remain
visually distinct from the matchup score.

Because this ordering can influence a fantasy decision, treat it as reproducible analysis under ADR
0003: return its algorithm version, exact input hash, factors, and availability warnings. It is not
an independent add/drop, trade, or lineup recommendation.

### 8.3 Cross-links

- A roster player's name links to player detail.
- A close current-week decision links to Decision Desk.
- A projection value links to the relevant Projections view.
- Schedule-strength research does not directly produce an add, drop, or trade instruction.

These links keep Schedule Edge focused while making its evidence useful in the tools that own those
decisions.

### 8.4 Signed-out tour

The tour should never fall back to an empty shell or a sign-in prompt.

- Render one fixed, internally consistent sample league and roster analysis.
- Mark the personalized analysis as illustrative sample data once at the top.
- Fetch and display the real public official schedule in its secondary section.
- Ensure the sample includes one meaningful bye issue, one favorable window, and one difficult
  window so the feature's purpose is obvious.
- Do not show fake live freshness or imply the sample belongs to the visitor.

### 8.5 Mobile requirements

- Put the three highest-value findings and roster outlook before the first long comparison table.
- Use horizontally scrollable week cells only for the team-position matrix; do not make the entire
  page a desktop table squeezed onto a phone.
- Keep player, next opponent, matchup label, and bye state visible without horizontal scrolling.
- Move samples, provenance, and the official schedule into disclosure panels below the primary
  analysis.
- Preserve accessible labels, keyboard controls, focus states, and reduced-motion behavior.

## 9. Work packages

These packages are implementation checkpoints, not separate rollout stages. Complete WP1 through
WP5 in one continuous effort, keeping each checkpoint testable and commit-ready while holding the
public Schedule Edge release until the full criteria in section 11 pass.

### WP1 — Bye intelligence foundation

Deliver:

- canonical roster-to-NFL-schedule joins;
- legal-lineup bye feasibility using stored slot rules;
- focused, versioned finding prioritization;
- the initial authenticated contract and route for roster and bye results;
- a mobile-first Bye Pressure section above the official schedule; and
- a complete signed-out bye-analysis fixture.

Exit criteria:

- flex, superflex, multi-position eligibility, IR/bench distinctions, and duplicate slot types are
  covered by tests;
- unknown player team or schedule coverage produces `Unknown`, never `Covered`;
- no other league member's roster appears in the member response;
- preseason users receive useful bye analysis without pretending current-season matchup evidence
  exists; and
- the existing public schedule stays available.

This is the first complete vertical implementation checkpoint. It can be built and tested without
waiting on matchup-model validation, but it is not intended as a separate public release.

### WP2 — League-scored matchup engine and validation

Deliver:

- fixes for the prototype's empty-slice and missing-game silent-zero behavior;
- schedule-enumerated games and week-scoped roster participation/position joins;
- reuse of the existing scoring normalizer, component scorer, and semantic scoring key;
- first-class scoring compatibility and unmatched-row availability;
- raw and opponent-offense-adjusted fantasy points allowed;
- candidate recency, prior/current, confidence, percentile, and minimum-differential policies;
- the evaluation-only 2022 backfill;
- the locked 2023–2025 evaluation harness and policy artifact;
- one shared fantasy-points-allowed definition for Schedule Edge and Stats Center; and
- unit, property, integration, and frozen-fixture tests.

Exit criteria:

- every published metric can be recomputed from stored facts and a versioned policy;
- empty or missing position rows never become observed zeroes without affirmed roster coverage;
- input row ordering does not change output;
- no evaluation fold uses future information; and
- only positions that clear the historical gate receive predictive labels.

### WP3 — Matchup API and provenance

Deliver:

- the expanded member roster contract and parser;
- the separate team-position matrix contract and parser;
- repository, services, authenticated routes, and server wiring;
- semantic-profile matrix caching and member-specific roster assembly;
- bounded reads and response sizes;
- source, scoring, evaluation-policy, algorithm-version, and input-hash provenance; and
- route, authorization, repository, service, and cache-isolation tests.

Exit criteria:

- a league member receives a deterministic roster snapshot and separately requested matrix;
- semantically identical scoring profiles may reuse a matrix without sharing member data;
- a nonmember receives the same `404` shape as an unknown league;
- stale, quarantined, partial, incompatible, and absent inputs are explicit; and
- the public schedule endpoints remain unchanged.

### WP4 — Schedule Edge UI and demo

Deliver:

- the new page hierarchy and responsive components;
- league, near-term, and playoff window controls;
- personalized findings, roster outlook, bye pressure, and team-position comparison;
- official schedule and provenance as secondary sections;
- a complete signed-out demo fixture; and
- navigation, metadata, loading, empty, partial, and error states.

Exit criteria:

- the feature's purpose and first useful finding are visible in the initial mobile viewport;
- every analysis section has useful demo content;
- a member can distinguish a metric, a projection, and an engine recommendation; and
- no sign-in prompt blocks the public schedule or tour sample.

### WP5 — Integration and release

Deliver:

- contextual Schedule Edge links from Decision Desk, Projections, and player detail where useful;
- operational diagnostics for withheld and stale analysis;
- production smoke checks against at least one real synced league and the signed-out tour;
- updated README or product documentation only where the feature changes supported behavior; and
- restrained landing-page copy only after the production acceptance criteria pass.

Exit criteria:

- source refreshes and provider roster syncs appear without manual cache clearing;
- mobile and desktop production builds pass;
- current recommendation values are unchanged unless separately validated; and
- the page is useful when one optional input, such as projections, is missing.

## 10. Testing strategy

### Pure analytics

- League-scoring correctness for representative ESPN and Yahoo rules plus standard, half-PPR, and
  full-PPR evaluation profiles.
- Unsupported scoring and allowed ignored-rule warnings.
- Complete versus partial game coverage.
- Schedule game with no stat rows, rostered zero-stat player, empty position slice, unmatched stat
  row, and unmatched weekly-roster row.
- Week-scoped position changes versus current player position.
- Duplicate player-game rejection.
- Canonical team alias handling.
- Stable ranks, ties, percentiles, and minimum point-differential labels.
- Raw versus opponent-offense-adjusted values.
- Prior/current shrinkage at Weeks 1, 4, 8, and 14.
- Preseason and Weeks 1–4 low-confidence behavior.
- Bye and unknown weeks excluded correctly from window averages.
- No lookahead in historical evaluation.
- Deterministic output under input reordering.

### Bye feasibility

- Standard, flex, superflex, and multiple-flex lineups.
- Players with multiple eligible positions.
- One bye player affecting multiple possible assignments.
- Legal lineup, thin lineup, impossible lineup, and insufficient-data states.
- An affirmed bye versus a schedule coverage gap.

### API and security

- Membership authorization and indistinguishable unknown/inaccessible leagues.
- Private projection visibility.
- Query bounds and malformed week ranges.
- Semantic scoring-profile cache reuse without roster or membership leakage.
- Missing, stale, quarantined, oversized, and rejected source inputs.
- Unsupported scoring and unmatched identity/position inputs.
- Per-section availability without failing the entire response.
- Contract parsing and response-size limits.

### Web

- Signed-out demo, member data, no claimed team, no projections, no matchup metric, and full-data
  states.
- Mobile layouts at 320, 375, and 430 CSS pixels.
- Desktop layouts at common widths.
- Keyboard navigation and screen-reader labels.
- Loading, retry, source warning, and partial-result behavior.
- No horizontal page overflow.

### Production smoke

- Anonymous official schedule and byes return `200`.
- Signed-out `/schedule` renders sample analysis and the official schedule.
- A real member league returns current roster and scoring context.
- A roster sync changes the personalized result.
- A source checksum change changes provenance and invalidates cached output.

## 11. Release criteria

Schedule Edge is ready to replace the current Schedule navigation label when:

- QB, RB, WR, and TE each either clear the historical gate or are explicitly withheld;
- matchup grades use the selected league's scoring rules;
- scoring incompatibility and unmatched weekly identities/positions withhold affected metrics;
- completed schedule games and weekly roster participation prevent missing rows from becoming
  silent zeroes;
- matchup ratings are opponent-offense adjusted unless the locked evaluation rejects that policy;
- all schedule absences preserve the existing bye-versus-unknown distinction;
- roster bye feasibility handles the league's actual roster-slot rules;
- preseason and Weeks 1–4 lead with bye analysis, show only explicitly low-confidence prior-season
  context, and never imply that 2026 games have already informed the model;
- the first mobile viewport shows a meaningful personalized or demo finding;
- the official schedule remains available and public;
- provenance and confidence are visible without dominating the main experience;
- focused tests, full typecheck, lint, production build, and live smoke checks pass; and
- no existing lineup, waiver, trade, projection, or draft output changes as a side effect.

If the historical gate finds that opponent-position points allowed adds little predictive value,
do not manufacture a proprietary score. Ship bye feasibility and transparent descriptive schedule
context, or keep the raw schedule secondary until a better validated signal exists.

## 12. Expected file map

Likely additions or changes:

```text
packages/league-analytics/src/schedule-edge.ts
packages/league-analytics/src/schedule-edge.test.ts
packages/league-analytics/src/opportunity.ts
packages/projections/src/league-scoring.ts
packages/projections/src/scoring.ts
packages/contracts/src/index.ts
apps/api/src/schedule-edge.ts
apps/api/src/schedule-edge.test.ts
apps/api/src/schedule-edge-routes.ts
apps/api/src/schedule-edge-routes.test.ts
apps/api/src/stats-center.ts
apps/api/src/app.ts
apps/api/src/server.ts
apps/worker/src/schedule-edge-evaluation.ts
apps/worker/src/schedule-edge-evaluation.test.ts
apps/web/src/lib/api-client.ts
apps/web/src/lib/demo-schedule-edge.ts
apps/web/src/components/schedule-edge-workbench.tsx
apps/web/src/components/schedule-edge-workbench.module.css
apps/web/src/components/schedule-board.tsx
apps/web/src/components/app-shell.tsx
apps/web/src/app/schedule/page.tsx
```

The exact file split may change, but pure calculations must remain separate from database access and
UI formatting.

## 13. Fresh-session execution checklist

1. Read this plan, `ENHANCEMENT_PLAN.md`, and the three architecture decisions under
   `docs/architecture`.
2. Run `git status -sb` and preserve unrelated changes.
3. Verify current schema and source coverage rather than relying only on this file map.
4. Start with the WP1 bye-intelligence foundation; it does not depend on historical matchup
   evidence.
5. Complete WP2's data-correctness fixes and historical gate before building favorable/difficult
   labels for any position.
6. Proceed through WP3–WP5 without a partial public release; keep each implementation checkpoint
   testable and commit-ready.
7. Keep public schedule behavior working throughout.
8. Update this document's status and any fixed metric definitions when implementation decisions are
   locked.
9. Rebuild or deploy only when requested and after the complete release criteria pass.
10. Commit or push only when requested.
