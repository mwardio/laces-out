# Schedule Intelligence Enhancement Plan

- Status: proposed
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
and navigation label with **Schedule Edge** once the first member-facing analysis is complete.

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
- A tested `calculatePositionFantasyPointsAllowed` primitive with complete-dataset gating and
  early-season shrinkage.
- A deterministic lineup optimizer and roster eligibility model.
- Existing source-admission, freshness, provenance, and fail-closed conventions.

The main gaps are orchestration, a league-aware scoring input for fantasy points allowed, historical
validation, a member-scoped API contract, and the new UI.

## 5. Analytical definitions

All displayed metrics must have stable definitions in code and in the API response. Avoid labels
such as “smash spot” or “elite matchup” unless a disclosed numeric rule supports them.

### 5.1 Position fantasy points allowed

For each defensive NFL team and supported offensive position:

1. Score every complete player-game observation with the selected league's stored scoring rules.
2. Sum those player points by defensive opponent, game, and position.
3. Average only complete games.
4. Shrink the observed average toward a pre-period baseline.
5. Retain the raw average, adjusted average, baseline, games observed, incomplete games, and
   shrinkage weights.

The existing league-analytics primitive should be extended rather than replaced. The service must
affirm complete player coverage for the included games. Partial coverage makes the metric
unavailable; it does not become a lower defensive score.

### 5.2 Early-season baseline

Before the current season has enough completed games:

- use the prior season's same defense-position result when it cleared the same completeness checks;
- regress that result substantially toward the league-wide positional mean; and
- reduce the prior-season weight as current-season complete games accumulate.

The exact prior weight must be selected in historical evaluation and then locked in the definition.
If a team identity or prior sample cannot be trusted, use the positional league mean rather than a
guessed team prior.

### 5.3 Matchup score

For a scheduled offensive team and position, the opponent's adjusted fantasy points allowed becomes
the matchup input. Convert it to a within-position percentile:

- `0` means the most difficult admitted matchup in the comparison set;
- `50` is approximately league average; and
- `100` means the most favorable admitted matchup.

The UI may group percentiles into:

- **Favorable:** 67–100
- **Neutral:** 34–66
- **Difficult:** 0–33

Always show the numeric percentile or league-scored point differential in detail. Ties use a stable
midrank. A grade is unavailable when its opponent-position input is unavailable.

### 5.4 Schedule strength

For an NFL team and position over a selected week range:

- join each scheduled game to that week's opponent matchup score;
- omit affirmed byes from the average while counting them separately;
- withhold unknown weeks rather than treating them as neutral; and
- calculate the simple mean of available matchup percentiles.

Use equal week weights in the first release. Recency weighting would make the metric harder to
interpret without established evidence that it improves decisions.

Return:

- average matchup percentile;
- rank among NFL teams for that position and window;
- favorable, neutral, difficult, bye, and unknown week counts;
- the week-by-week opponent and rating; and
- coverage and confidence state.

### 5.5 Confidence

Confidence describes input support, not certainty about a player's performance.

- **High:** current-season metric with the historically validated minimum number of complete games.
- **Medium:** mixed current- and prior-season support.
- **Low:** predominantly prior-season or heavily shrunk support.
- **Unavailable:** schedule coverage, scoring compatibility, or weekly-stat completeness failed.

The minimum-game thresholds and shrinkage weights are fixed by the validation work in section 11,
not chosen to make the current data look persuasive.

### 5.6 Roster outlook

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

### 5.7 Bye-week lineup feasibility

For every affirmed bye week in the selected range:

1. Remove rostered players whose NFL teams are on bye.
2. Apply the league's stored starter-slot and position-eligibility rules.
3. Determine whether any legal complete starting lineup remains.

Return one of:

- **Covered:** a legal lineup remains.
- **Thin:** a legal lineup remains, but at least one starter slot has no alternative eligible
  assignment after the selected assignment.
- **Gap:** no legal complete lineup can be formed.
- **Unknown:** roster, slot, identity, or schedule coverage is insufficient.

Reuse or extract the existing deterministic roster-assignment machinery. Do not implement this as
simple position counts; flex and multi-position eligibility make that answer unreliable.

### 5.8 Fantasy-playoff window

Use provider-supplied league playoff weeks when they are stored and trustworthy. Otherwise default
the view to Weeks 15–17 and label it **Weeks 15–17**, not “your playoffs.” The member may adjust the
range in the page controls without adding a new persisted preference in the first release.

## 6. Historical validation gate

The labels must demonstrate useful signal before they ship as recommendations.

Run locked, week-by-week historical evaluation across the admitted 2023–2025 regular seasons:

1. For each target week, build defensive position metrics using only games completed before that
   week.
2. Apply the same prior-season and shrinkage policy intended for production.
3. Compare the target-week result with each player's trailing performance baseline and actual
   league-scored points.
4. Evaluate QB, RB, WR, and TE independently.
5. Record sample counts, mean residual by difficult/neutral/favorable bucket, rank correlation,
   calibration by percentile band, and early- versus late-season performance.
6. Lock the minimum-game threshold and prior/current weighting without looking at 2026 outcomes.

Release a position's favorable/difficult language only if the buckets show a stable, correctly
ordered relationship on held-out weeks and are not driven by a small number of games. If a position
does not clear the gate, display the underlying adjusted points-allowed statistic as descriptive
context or withhold it; do not imply predictive value.

Store the evaluation summary and policy version with the metric definition. Tests should use frozen
fixtures, while the full evaluation can run as a bounded script or worker diagnostic.

## 7. API and service design

### 7.1 Preserve the public facts API

Keep these routes public and user-independent:

- `GET /v1/schedule`
- `GET /v1/schedule/byes`

They remain the official schedule reference and a reusable source for the web page.

### 7.2 Add a member-scoped analysis route

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
- NFL team-by-position schedule-strength summaries for both windows; and
- definitions required to interpret every score and label.

Bound the response to the 32 NFL teams, supported positions, regular-season weeks, and the claimed
roster. Do not return all league rosters or another member's private projection set.

### 7.3 Service boundary

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
  readCompatibleProjectionContext(userId, leagueSeasonId)
```

Pure analytics belong in `packages/league-analytics`; authorization, bounded database reads, source
admission, and response assembly belong in `apps/api`.

### 7.4 Caching and refresh

Compute on request first. The expected user count and data bounds do not justify a new materialized
table before measurement.

Use a short in-process cache only if profiling shows a need. Its key must include:

- league season and claimed team;
- scoring-rules checksum;
- schedule source checksum;
- current- and prior-season weekly-stat checksums;
- roster snapshot identity;
- projection-set identity when projection context is included;
- selected windows; and
- analysis policy version.

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

### WP1 — League-scored matchup engine and validation

Deliver:

- a reusable league-scoring adapter for admitted weekly stat components;
- an extension of position fantasy points allowed that supports a validated prior/current policy;
- deterministic percentile, window-strength, confidence, and coverage calculations;
- the locked 2023–2025 evaluation harness and policy artifact; and
- unit, property, and fixture tests.

Exit criteria:

- every published metric can be recomputed from stored facts and a versioned policy;
- incomplete data fails closed;
- reorderings of equivalent input rows do not change output; and
- only positions that clear the historical gate receive predictive labels.

### WP2 — Roster and bye intelligence

Deliver:

- canonical roster-to-NFL-schedule joins;
- selected-window and playoff-window roster outlook;
- legal-lineup bye feasibility using stored slot rules; and
- focused, deterministic finding prioritization.

Exit criteria:

- flex, superflex, multi-position eligibility, IR/bench distinctions, and duplicate slot types are
  covered by tests;
- unknown player team or schedule coverage produces `Unknown`, never `Covered`; and
- no other league member's roster appears in the member response.

### WP3 — Member API and provenance

Deliver:

- contracts and parser for the schedule-edge response;
- repository, service, authenticated route, and server wiring;
- bounded reads and response sizes;
- source/policy provenance and per-section availability; and
- route, authorization, repository, and service tests.

Exit criteria:

- a league member receives a deterministic snapshot;
- a nonmember receives the same `404` shape as an unknown league;
- stale, quarantined, partial, and absent inputs are explicit; and
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

- League-scoring correctness for representative ESPN scoring rules.
- Complete versus partial game coverage.
- Duplicate player-game rejection.
- Canonical team alias handling.
- Stable ranks, ties, and percentiles.
- Prior/current shrinkage at Weeks 1, 4, 8, and 14.
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
- Missing, stale, quarantined, oversized, and rejected source inputs.
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
- all schedule absences preserve the existing bye-versus-unknown distinction;
- roster bye feasibility handles the league's actual roster-slot rules;
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
packages/contracts/src/index.ts
apps/api/src/schedule-edge.ts
apps/api/src/schedule-edge.test.ts
apps/api/src/schedule-edge-routes.ts
apps/api/src/schedule-edge-routes.test.ts
apps/api/src/app.ts
apps/api/src/server.ts
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
4. Start with WP1 and the historical validation gate.
5. Do not build favorable/difficult UI labels before a position clears that gate.
6. Complete contracts, service, route, UI, tests, and provenance for one vertical slice at a time.
7. Keep public schedule behavior working throughout.
8. Update this document's status and any fixed metric definitions when implementation decisions are
   locked.
9. Rebuild or deploy only when requested.
10. Commit or push only when requested.

## Appendix A — Implementation review, 2026-07-27

These findings come from checking sections 1 through 13 against the current repository. They are
unresolved review notes, not accepted decisions. Where an item conflicts with the body of this plan,
the body still stands until the conflict is decided and the affected section is edited.

### A.1 Work package order

WP2 has no dependency on the historical gate and every input it needs already exists.
`optimizeLineup` in `packages/engine-lineup/src/index.ts:179` is an exact bitmask assignment search
that selects maximum filled slots before score (`:327`), so `feasible` and `unfilledSlotIds` are a
correct legal-lineup test. `apps/api/src/in-season-decisions.ts:264` and `:1275` already read
`roster_slot_rules`, expand slot counts, and call it.

WP1 depends on evidence that may not arrive, and its launch timing is unfavorable.
`uniqueSeasonWindow` in `apps/worker/src/nflverse-weekly-data.ts:332` admits
`currentSeason - 3` through `currentSeason`, and the 2026 season has not started. At release every
matchup rating would rest entirely on prior-season data regressed substantially toward the
league-wide positional mean under section 5.2, which is the weakest state described in section 5.5,
during the draft-preparation and early-waiver period when schedule strength draws the most interest.

Consider making WP2 the first shippable slice. Section 11 should state what the page shows during
Weeks 1 through 4 of a new season, when no current-season sample exists.

### A.2 Two silent-zero defects in the fantasy-points-allowed primitive

Both are in `packages/league-analytics/src/opportunity.ts`:

- `:782` calls `relevant.every(...)` on a possibly empty array, which returns `true`. A defense,
  game, and position combination with no stat rows is recorded as a complete 0.0-point game. That is
  the behavior section 3.3 lists as an explicit non-goal.
- `:763` builds `defenseGames` from observed stat rows rather than from the admitted schedule. A
  completed game with no admitted stat rows is invisible: `games` shrinks, `incompleteGames` stays
  `0`, and section 5.5 would report **High** confidence on a silently truncated sample.

WP1 should enumerate defense-games from the admitted schedule and require an affirmed participation
basis from `player_weekly_roster_observations` before a zero counts as an observed zero.

Section 4 also overstates the foundation slightly. The primitive has no production caller today; it
is exercised only by fixtures in `opportunity.test.ts` and has never run against the real table.

### A.3 Position at week

`player_weekly_stat_observations` has no position column (`packages/db/src/schema.ts:1777`), and its
`player_id` is nullable with a dedicated unmatched-row index (`:1788`, `:1819`). Stats Center
resolves position through `players.primaryPosition` (`apps/api/src/stats-center.ts:207`), which is a
current position rather than the position held during the game, and which is unavailable for
unmatched rows whose points would then silently disappear from a defense's total.

`player_weekly_roster_observations.position` (`packages/db/src/schema.ts:1920`) is the correct
week-scoped source. Section 5.1's completeness gate should require every stat row in an included game
to be player-matched and positioned, and should say so explicitly.

### A.4 The league-scoring adapter already exists

WP1 lists a reusable league-scoring adapter as new work. `normalizeLeagueScoringProfile`
(`packages/projections/src/league-scoring.ts:764`) and `scoreProjectionStatComponents`
(`packages/projections/src/scoring.ts:108`) already map stored `scoring_rules` into a validated
profile and score the same nflverse component vocabulary the weekly table stores.

Two consequences belong in the plan. First, `normalizeLeagueScoringProfile` reports unsupported and
ignored rules, since ESPN bucket and per-N stat IDs are deliberately excluded from the maps, so
scoring incompatibility needs to be a first-class availability state rather than one clause in
section 5.5. Second, `projectionScoringProfileKey` (`packages/projections/src/scoring.ts:95`) is a
better cache key than section 7.4's raw scoring-rules checksum, because leagues with semantically
identical scoring can then share one cached result.

### A.5 Opponent adjustment and the ENHANCEMENT_PLAN conflict

`ENHANCEMENT_PLAN.md:309` specifies D1 as recent-weighted, schedule-adjusted fantasy points allowed
producing 1-5 ratings. This plan does no opponent adjustment and uses a 0-100 percentile with three
buckets. Raw fantasy points allowed is dominated by which offenses a defense has faced, most
severely in the small early-season samples section 5.2 targets.

Either fold opponent-offense adjustment into section 5.1, which is the largest available accuracy
lever, or amend D1 so the two documents agree. The same applies to `ENHANCEMENT_PLAN.md:311`, where
D7 places fantasy points allowed in Stats Center; `apps/api/src/stats-center.ts:818` already carries
a permanently unavailable `fantasyPointsAllowed` field waiting for this metric. One definition should
serve both surfaces.

### A.6 The `Thin` state is currently matching-dependent

Section 5.7 defines `Thin` as a starter slot with no alternative eligible assignment after the
selected assignment. Which assignment is selected depends on the projections and tiebreaks handed to
the optimizer, so the label is not stable. A deterministic replacement:

> **Thin:** a legal lineup exists, and at least one non-bye rostered player exists whose additional
> removal makes the lineup infeasible.

That is independent of which matching was chosen and costs at most one extra feasibility check per
rostered player. Note also the optimizer's 30 unlocked starter slot limit
(`packages/engine-lineup/src/index.ts:285`).

### A.7 Section 5.8's provider playoff weeks are not stored

`league_seasons` has no playoff week columns (`packages/db/src/schema.ts:442`). The ESPN connector
normalizes `regularSeasonMatchupPeriods` (`packages/connectors/src/normalized.ts:38`), but nothing
persists it, so the conditional in section 5.8 currently resolves to never.

Either add persistence of `regularSeasonMatchupPeriods` into `league_seasons.settings` during sync as
an explicit work item, or remove the branch and ship the labeled Weeks 15-17 default with its
control.

### A.8 Split the member-scoped route

Section 7.2 returns the 32-team by supported-position matrix for two windows, with week-by-week
detail, inside the member-private response. That is a few thousand week entries per request,
recomputed per member, and shareable with no one. The matrix is league-scored but not member-private.

Consider splitting it: `/v1/leagues/:leagueId/schedule-edge` for roster, byes, and findings, and a
second route for the team-by-position matrix keyed by the normalized scoring profile. That also gives
section 7.4 a cache entry that more than one league can use.

### A.9 Smaller items

- Section 6 does not name the scoring profile used for the backtest. The gate cannot run per league,
  so it should fix two or three representative profiles. WR and TE orderings genuinely shift between
  standard and full PPR.
- Section 6's 2023 fold has no prior season. With 2022 outside the admitted window, the section 5.2
  prior and current weighting can only be selected on 2024 and 2025. Either state that constraint or
  add a one-time bounded 2022 backfill used for evaluation only.
- Section 5.3 hands out labels by construction. Fixed 67 and 34 percentile cuts produce roughly
  eleven favorable defenses every week even when the spread is a point and a half per game. The
  label, as distinct from the percentile, should also require a validated minimum point differential
  and otherwise fall back to Neutral.
- Section 8.2's ranked findings are recommendation-shaped. Add one line reconciling them with ADR
  0003: either the ordering is not a recommendation, or it carries the algorithm version and input
  hash that ADR requires.
- `apps/web/src/app/schedule/page.tsx:8` sets `robots: { index: false, follow: false }`. If the
  section 8.4 signed-out tour is meant to be a public surface, that flag has to change.
