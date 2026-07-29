# Schedule Edge Implementation Record

- Status: implemented; locked matchup decision is **descriptive-only**
- Last updated: 2026-07-27
- Target surface: `/schedule`
- Product name: **Schedule Edge**
- Validation artifact:
  [`schedule-edge-validation-2026-07-27.json`](../schedule-edge-validation-2026-07-27.json)

## 1. Objective

Schedule Edge turns the old NFL Schedule reference page into a focused fantasy decision tool. It
answers three questions:

1. What has each upcoming opponent allowed at my players' positions under this league's scoring?
2. Where will bye weeks leave my roster unable, or barely able, to field a legal lineup?
3. Which NFL teams and positions carry the highest or lowest descriptive allowance percentiles
   across near-term and playoff windows?

The official schedule remains available as supporting evidence. It is not the primary product.

## 2. Product decision

The implementation keeps the schedule data, public endpoints, and `/schedule` route. The navigation
and page hierarchy now use **Schedule Edge**, with the official schedule retained as supporting
evidence rather than the primary product.

The page leads with personalized analysis for an authenticated member with a selected league. A
signed-out visitor sees a clearly labeled, fixed demo plus the real public NFL schedule. A member
without a usable league sees the official schedule and a direct explanation of what league data is
needed to unlock the analysis.

The locked validation did not admit directional matchup language for any position. Production
therefore exposes league-scored points allowed, percentiles, sample support, and bye feasibility as
descriptive context only. Schedule Edge does not change lineup, waiver, trade, or projection values.
That boundary must remain in place unless a future pre-registered validation clears an untouched
confirmation set.

## 3. Scope

### 3.1 Implemented surface

- League-scored, position-specific defensive matchup context for QB, RB, WR, and TE, with
  favorable/difficult language withheld by the locked policy.
- Upcoming schedule-context percentiles for each NFL team and supported position.
- A personalized roster outlook for the selected league.
- Deterministic bye-week lineup feasibility for the claimed roster.
- A configurable near-term window and a fantasy-playoff window.
- Transparent sample size, freshness, confidence, and source provenance.
- A compact official-schedule reference view beneath the analysis.
- A complete signed-out demo and a useful mobile layout.
- Links from relevant roster findings to Decision Desk, Projections, or player detail rather than
  duplicating those tools.

### 3.2 Deliberately deferred

- Kicker and D/ST matchup ratings. Their scoring and available source components require separate
  completeness validation.
- Weather, travel distance, stadium surface, betting totals, and injury/news overlays.
- AI-written schedule summaries. The deterministic findings stand on their own.
- Automatic projection or waiver-value adjustments based on the new matchup rating.
- Push notifications derived solely from matchup difficulty.
- A new external data vendor. The implementation uses admitted Laces Out data already refreshed by
  the worker.

### 3.3 Explicit non-goals

- Predicting game winners or NFL point spreads.
- Presenting last season's raw defensive ranking as a confident current-season forecast.
- Treating a missing schedule or weekly-stat row as a bye, zero, or neutral matchup.
- Producing a universal matchup grade that ignores league scoring.
- Rebuilding the lineup optimizer, waiver engine, trade engine, or Projections page inside this
  surface.

## 4. Implemented foundation

The implementation now includes:

- Public `GET /v1/schedule` and `GET /v1/schedule/byes` routes.
- Admitted nflverse schedule observations with checksums, coverage, freshness, rejected-row counts,
  rest days, kickoff times, results, and explicit `game`, `bye`, or `unknown` team-week states.
- Daily schedule and weekly-stat refreshes plus on-demand data refresh paths.
- Canonical NFL team and player identities.
- Stored league scoring rules, roster snapshots, roster-slot rules, team claims, and current week.
- League-scored weekly and rest-of-season projections.
- A production Schedule Edge calculation that enumerates completed games from admitted schedule
  facts, joins week-scoped roster positions, and withholds incomplete game-position slices.
- Existing scoring normalization and component scoring through
  `normalizeLeagueScoringProfile`, `scoreProjectionStatComponents`, and
  `projectionScoringProfileKey`.
- Week-scoped roster observations containing the position held by each player in that week.
- A deterministic lineup optimizer and roster eligibility model.
- Existing source-admission, freshness, provenance, and fail-closed conventions.
- A pure analytics package for bye feasibility, game-position totals, raw and opponent-adjusted
  ratings, confidence, and schedule-strength windows.
- Authenticated member and matrix APIs with bounded, checksum-pinned reads and deterministic input
  hashes.
- A responsive member experience, complete signed-out demo, public official schedule, provenance,
  partial states, and cross-links to the tools that own decisions.
- A bounded worker diagnostic that runs locked selection, confirmation, and full-window audits.

Stats Center still exposes its older fantasy-points-allowed availability boundary rather than this
league-scored implementation. Unifying those two surfaces is an honest follow-up; Schedule Edge is
the only production caller of the new definition today.

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

Schedule Edge uses this implementation and definition. Stats Center still uses its older
availability boundary; consolidating it onto this implementation remains follow-up work.

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

The diagnostic compared equal game weights with bounded recency-weighted candidates. The selected
candidate used equal game weights; the descriptive production policy therefore has no recency
decay. No target-week or future result enters the offense expectation.

### 5.4 Early-season baseline

Before the current season has enough completed games:

- use the prior season's same defense-position result when it cleared the same completeness checks;
- regress that result substantially toward the league-wide positional mean; and
- reduce the prior-season weight as current-season complete games accumulate.

The locked implementation uses four prior-season pseudo-games and four offense- and
defense-shrinkage games. If a team identity or prior sample cannot be trusted, it uses the
positional league mean rather than a guessed team prior.

During preseason and Weeks 1–4, the page leads with bye feasibility and official schedule facts.
Prior-season matchup context may appear only as **Low confidence**, with its prior-season basis
visible. The locked policy supplies no favorable/difficult language at any support level.

### 5.5 Matchup score

For a scheduled offensive team and position, the opponent's adjusted fantasy points allowed becomes
the matchup input. Convert it to a within-position percentile:

- `0` means the most difficult admitted matchup in the comparison set;
- `50` is approximately league average; and
- `100` means the most favorable admitted matchup.

The analytics primitive supports these candidate groupings:

- **Favorable:** 67–100
- **Neutral:** 34–66
- **Difficult:** 0–33

Percentile alone does not earn a directional label. The candidate gate also required a versioned
minimum league-scored point differential from the positional mean, but no position cleared both
folds. The current API therefore returns directional labels as unavailable even when it returns a
numeric percentile and point differential.

The detail view shows the numeric percentile and league-scored point differential. Ties use a
stable midrank. A grade remains unavailable under the locked policy and is also unavailable when
its opponent-position input is missing.

### 5.6 Schedule strength

For an NFL team and position over a selected week range:

- join each scheduled game to that week's opponent matchup score;
- omit affirmed byes from the average while counting them separately;
- withhold unknown weeks rather than treating them as neutral; and
- calculate the simple mean of available matchup percentiles.

Future schedule weeks use equal weights. Recency, if validated, applies only while estimating the
defense's current strength; it does not make one future matchup count more than another.

The implementation returns:

- average matchup percentile;
- rank among NFL teams for that position and window;
- bye and unknown week counts, with directional week counts held at zero under the locked policy;
- the week-by-week opponent and rating; and
- coverage and confidence state.

### 5.7 Confidence

Confidence describes input support, not certainty about a player's performance.

- **High:** current-season metric with at least eight complete games under the versioned policy.
- **Medium:** mixed current- and prior-season support.
- **Low:** predominantly prior-season or heavily shrunk support.
- **Unavailable:** schedule, participation, identity, scoring compatibility, or weekly-stat
  completeness failed.

The minimum-game thresholds and shrinkage weights are fixed by the validation work in section 6,
not chosen to make the current data look persuasive.

### 5.8 Roster outlook

Join the claimed roster to canonical NFL team, position eligibility, schedule, and matchup scores.
For each player, the implementation returns:

- next game or affirmed bye;
- opponent and kickoff;
- position-specific matchup percentile, unavailable directional label, confidence, and sample size;
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
controls without adding a new persisted preference.

## 6. Locked historical validation

### 6.1 Evidence and the 2022 exception

The diagnostic used admitted, checksum-pinned regular-season schedule, weekly-stat, and
weekly-roster artifacts for 2022–2025. The 2022 data exists only to give the 2023 fold a strictly
prior baseline; it does not expand the recurring production refresh window.

The admitted 2022 schedule contains 271 games because Buffalo–Cincinnati was canceled after the
Damar Hamlin emergency. Admission accepts that season only when BUF and CIN each appear 16 times,
neither team has a Week 17 assignment, no BUF–CIN row exists, every other team appears 17 times, all
32 teams and 18 weeks are present, and no duplicate team-week or self-matchup exists. The exception
is exact and season-bound; every modern 272-game season remains subject to the normal completeness
rule.

The exact source checksums and row counts are stored in the
[locked validation artifact](../schedule-edge-validation-2026-07-27.json). The three evaluation
evidence checksums are:

| Fold                   | Seasons   | Evidence checksum                                                  |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| Candidate selection    | 2023–2024 | `57127464b705f967389d2bb482394862912475d92db6594b7b9bccc0a1e744a1` |
| Untouched confirmation | 2025      | `07e975b9f137e053f59c39f2dbdbf9f87a7e672ba36ac6e65b6befae85f2b3b8` |
| Full-window audit      | 2023–2025 | `db143047024981db6afdf598d7f3eed3585cba62fa57e3f3dfd952d4ad19bdf6` |

The complete diagnostic output used to derive the compact artifact has SHA-256
`bd13d3899892a0be8685ff07432cc5b46d85049deb34488b7f267d416390e9ec`.

### 6.2 Evaluation design

`npm --workspace @fantasy/worker run schedule-edge:validate` runs
`schedule-edge-walk-forward-v1`:

1. Every target week is predicted from defense inputs completed strictly before that week.
2. Active, week-scoped roster players are scored under fixed standard, half-PPR, and full-PPR
   profiles. A rostered active player with no stat row contributes a real zero only after schedule,
   roster, identity, and participation coverage clear admission.
3. Each player's baseline uses at most eight games completed strictly before the target week and
   requires at least two prior observations.
4. Player outcomes are clustered back to the offense-team/game/position grain before gates count
   samples, so a receiving corps does not masquerade as several independent defensive games.
5. Raw, opponent-adjusted, bounded recency, prior/current weighting, current-season support, and
   point-differential candidates are compared on the 2023–2024 selection fold.
6. The selected candidate is frozen before the 2025 confirmation fold is evaluated.
7. Gates run independently for QB, RB, WR, and TE across all three scoring profiles. They require
   enough eligible and directional samples, positive rank signal, a minimum favorable/difficult
   residual spread, and correctly ordered difficult/neutral/favorable buckets in the required
   seasons.
8. The diagnostic also records percentile-band calibration and early- versus late-season
   performance. No 2026 result participates in selection, confirmation, or policy locking.

The selection fold chose `raw-equal` with policy
`schedule-edge-candidate-balanced-equal-v1`: four offense-shrinkage games, four
defense-shrinkage games, four prior-season pseudo-games, equal weighting, six current-season games
before label eligibility, and minimum QB/RB/WR/TE point differentials of 1.5/1/1/0.75.

### 6.3 Locked result

No position cleared both candidate selection and 2025 confirmation:

| Position | 2023–2024 selection | 2025 confirmation | 2023–2025 audit  | Release          |
| -------- | ------------------- | ----------------- | ---------------- | ---------------- |
| QB       | Descriptive only    | Validated         | Validated        | Descriptive only |
| RB       | Descriptive only    | Descriptive only  | Descriptive only | Descriptive only |
| WR       | Descriptive only    | Descriptive only  | Descriptive only | Descriptive only |
| TE       | Descriptive only    | Descriptive only  | Descriptive only | Descriptive only |

The locked release state is therefore **descriptive-only**, with an empty
`validatedPositions` list. The selected raw candidate is not promoted into production, and the API
continues to identify matchup validation as descriptive-only. Schedule Edge may display
league-scored raw and adjusted points allowed, percentiles, coverage, and confidence, but it must
not call a matchup favorable or difficult or present schedule context as a projection adjustment.

This is the intended safe outcome of the gate, not a failed implementation.

## 7. API and service design

### 7.1 Preserve the public facts API

Keep these routes public and user-independent:

- `GET /v1/schedule`
- `GET /v1/schedule/byes`

They remain the official schedule reference and a reusable source for the web page.

### 7.2 Member-scoped roster route

Implemented:

```text
GET /v1/leagues/:leagueId/schedule-edge
  ?startWeek=<1..18>
  &endWeek=<start..18>
  &playoffStartWeek=<1..18>
  &playoffEndWeek=<start..18>
```

The route requires authentication and league membership. Unknown and inaccessible leagues both
return `404`, matching existing league analytics behavior.

The response contains:

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

### 7.3 Separate matrix route

Implemented:

```text
GET /v1/leagues/:leagueId/schedule-edge/matrix
  ?startWeek=<1..18>
  &endWeek=<start..18>
```

This route still requires authentication and league membership because the league chooses the
scoring profile. Its result contains no member roster data. It currently computes on request; its
input identity includes the semantic scoring profile rather than member identity so a future cache
can remain safely league-scored without carrying roster data.

The route returns at most 32 NFL teams by four supported positions, with window summary and bounded
week-by-week detail. A separate request prevents the larger comparison matrix from delaying every
personalized roster read.

### 7.4 Service boundary

The implementation uses a dedicated `ScheduleEdgeService` rather than expanding `ScheduleService`
into league-aware analysis. The existing service remains responsible for admitted schedule facts
and bye lookup.

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
are sufficient inputs. A changed checksum invalidates the result immediately. The UI shows when
schedule facts, matchup observations, roster state, and projections were last checked.

## 8. Web experience

### 8.1 Page hierarchy

For a member with a usable selected league:

1. **Header and controls** — selected league, current week, analysis window, playoff window, and
   freshness.
2. **What matters now** — at most three lineup-gap, major-bye-collision, or incomplete-evidence
   findings. Directional schedule findings remain ineligible under the locked policy.
3. **My roster** — compact player rows sorted by immediate decision relevance, not alphabetically.
4. **Bye pressure** — only weeks with `Thin`, `Gap`, or `Unknown` first; covered weeks remain
   available in detail.
5. **NFL schedule strength** — filterable team-by-position comparison for waiver and trade research.
6. **Playoff window** — a focused view of the same metric for the selected late-season weeks.
7. **Official schedule** — collapsed or secondary reference containing the current schedule board.
8. **Method and sources** — definitions, sample sizes, freshness, coverage, and attribution.

### 8.2 Roster finding priority

The implemented finding priority is:

1. no legal bye-week lineup;
2. upcoming affirmed bye affecting a likely starter;
3. a legal lineup with little remaining margin; and
4. insufficient bye evidence.

Directional matchup findings remain ineligible under the locked policy. If a future
pre-registered policy admits them, they follow the bye findings rather than displacing a legal
lineup warning.

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

The tour does not fall back to an empty shell or a sign-in prompt.

- Render one fixed, internally consistent sample league and roster analysis.
- Mark the personalized analysis as illustrative sample data once at the top.
- Fetch and display the real public official schedule in its secondary section.
- The sample includes one meaningful bye issue and visibly different percentile windows without
  presenting either as a validated directional call.
- Do not show fake live freshness or imply the sample belongs to the visitor.

### 8.5 Mobile requirements

- Put the three highest-value findings and roster outlook before the first long comparison table.
- Use horizontally scrollable week cells only for the team-position matrix; do not make the entire
  page a desktop table squeezed onto a phone.
- Keep player, next opponent, allowance percentile, and bye state visible without horizontal
  scrolling.
- Move samples, provenance, and the official schedule into disclosure panels below the primary
  analysis.
- Preserve accessible labels, keyboard controls, focus states, and reduced-motion behavior.

## 9. Work-package status

These packages were implementation checkpoints, not separate rollout stages. Their final state is
recorded here so a future session can distinguish completed work from deliberate withholding.

### WP1 — Bye intelligence foundation

**Status: complete.**

Delivered:

- canonical roster-to-NFL-schedule joins;
- legal-lineup bye feasibility using stored slot rules;
- focused, versioned finding prioritization;
- the initial authenticated contract and route for roster and bye results;
- a mobile-first Bye Pressure section above the official schedule; and
- a complete signed-out bye-analysis fixture.

Verified behavior:

- flex, superflex, multi-position eligibility, IR/bench distinctions, and duplicate slot types are
  covered by tests;
- unknown player team or schedule coverage produces `Unknown`, never `Covered`;
- no other league member's roster appears in the member response;
- preseason users receive useful bye analysis without pretending current-season matchup evidence
  exists; and
- the existing public schedule stays available.

This was the first complete vertical implementation checkpoint and did not depend on admitting a
predictive matchup model.

### WP2 — League-scored matchup engine and validation

**Status: complete for Schedule Edge; directional labels are deliberately withheld.** The
game-enumeration, scoring, adjustment, validation, and evidence work shipped. Reusing this exact
fantasy-points-allowed implementation in Stats Center remains a cross-surface follow-up.

Delivered:

- fixes for the prototype's empty-slice and missing-game silent-zero behavior;
- schedule-enumerated games and week-scoped roster participation/position joins;
- reuse of the existing scoring normalizer, component scorer, and semantic scoring key;
- first-class scoring compatibility and unmatched-row availability;
- raw and opponent-offense-adjusted fantasy points allowed;
- candidate recency, prior/current, confidence, percentile, and minimum-differential policies;
- the evaluation-only 2022 backfill;
- the locked 2023–2025 evaluation harness and policy artifact;
- a production fantasy-points-allowed definition for Schedule Edge, with Stats Center consolidation
  recorded as follow-up; and
- unit, property, integration, and frozen-fixture tests.

Verified behavior:

- every published metric can be recomputed from stored facts and a versioned policy;
- empty or missing position rows never become observed zeroes without affirmed roster coverage;
- input row ordering does not change output;
- no evaluation fold uses future information; and
- only positions that clear the historical gate receive predictive labels.

### WP3 — Matchup API and provenance

**Status: complete.**

Delivered:

- the expanded member roster contract and parser;
- the separate team-position matrix contract and parser;
- repository, services, authenticated routes, and server wiring;
- semantic-profile matrix identity and member-specific roster assembly;
- bounded reads and response sizes;
- source, scoring, evaluation-policy, algorithm-version, and input-hash provenance; and
- route, authorization, repository, service, and cache-isolation tests.

Verified behavior:

- a league member receives a deterministic roster snapshot and separately requested matrix;
- matrix responses remain independent from member roster and private projection data;
- a nonmember receives the same `404` shape as an unknown league;
- stale, quarantined, partial, incompatible, and absent inputs are explicit; and
- the public schedule endpoints remain unchanged.

### WP4 — Schedule Edge UI and demo

**Status: complete.**

Delivered:

- the new page hierarchy and responsive components;
- league, near-term, and playoff window controls;
- personalized findings, roster outlook, bye pressure, and team-position comparison;
- official schedule and provenance as secondary sections;
- a complete signed-out demo fixture; and
- navigation, metadata, loading, empty, partial, and error states.

Verified behavior:

- the feature's purpose and first useful finding are visible in the initial mobile viewport;
- every analysis section has useful demo content;
- a member can distinguish a metric, a projection, and an engine recommendation; and
- no sign-in prompt blocks the public schedule or tour sample.

### WP5 — Integration and release

**Status: implemented.** Cross-links, source diagnostics, documentation, responsive production
components, and partial-data behavior are present. Container rebuild, deployment, and post-deploy
smoke checks remain operational release steps whenever this worktree is promoted.

Delivered:

- contextual Schedule Edge links from Decision Desk, Projections, and player detail where useful;
- operational diagnostics for withheld and stale analysis;
- production-shaped API, worker, member-shell, and signed-out Schedule Edge smoke coverage;
- updated README or product documentation only where the feature changes supported behavior; and
- restrained landing-page copy only after the production acceptance criteria pass.

Promotion checks:

- source refreshes and provider roster syncs appear without manual cache clearing;
- mobile and desktop production builds pass;
- current recommendation values are unchanged unless separately validated; and
- the page is useful when one optional input, such as projections, is missing.

The automated production-shaped smoke passes. A live member-result smoke remains an operational
promotion check because the current deployment has no synced league or membership to exercise; no
synthetic member data was inserted into the live database to manufacture that result.

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

## 11. Release disposition

The implemented surface satisfies the safe-release product boundary:

- QB, RB, WR, and TE are explicitly descriptive-only rather than silently receiving unsupported
  directional labels.
- Metrics use the selected league's normalized scoring rules; incompatible scoring and unmatched
  weekly identity or position inputs withhold affected slices.
- Completed schedule games and weekly roster participation prevent missing rows from becoming
  silent zeroes.
- Schedule absences preserve the bye-versus-unknown distinction.
- Bye feasibility uses the league's actual starter slots and position eligibility.
- Preseason and Weeks 1–4 lead with bye analysis and never imply that 2026 games informed the
  historical model.
- The first mobile viewport contains a useful member or demo finding.
- The official schedule remains public and secondary.
- Provenance, coverage, and confidence remain available without masquerading as a recommendation.
- Existing lineup, waiver, trade, projection, and draft outputs do not consume the matchup metric.

Directional language has a separate promotion criterion: a pre-registered candidate must clear its
selection fold and an untouched confirmation fold for that position under every representative
scoring profile. A full-window pass cannot override a failed selection or confirmation fold. No
position met that rule in the locked artifact, so manufacturing a proprietary grade would violate
the plan.

## 12. Implemented file map

Primary additions and integrations:

```text
packages/league-analytics/src/schedule-edge.ts
packages/league-analytics/src/schedule-edge.test.ts
packages/projections/src/scoring.ts
packages/contracts/src/index.ts
apps/api/src/schedule-edge.ts
apps/api/src/schedule-edge.test.ts
apps/api/src/schedule-edge-routes.ts
apps/api/src/schedule-edge-routes.test.ts
apps/api/src/app.ts
apps/api/src/server.ts
apps/worker/scripts/validate-schedule-edge.ts
apps/worker/src/schedule-edge-evaluation.ts
apps/worker/src/schedule-edge-evaluation.test.ts
apps/web/src/lib/api-client.ts
apps/web/src/lib/demo-schedule-edge.ts
apps/web/src/components/schedule-edge-workbench.tsx
apps/web/src/components/schedule-edge-workbench.module.css
apps/web/src/components/schedule-board.tsx
apps/web/src/components/app-shell.tsx
apps/web/src/app/schedule/page.tsx
docs/schedule-edge-validation-2026-07-27.json
```

Pure calculations remain separate from database access and UI formatting.

## 13. Remaining follow-up

These items are intentionally not hidden behind “done” language:

1. Keep `SCHEDULE_EDGE_DESCRIPTIVE_POLICY` and the API's descriptive-only validation status in
   place. The locked artifact does not authorize any favorable/difficult position label.
2. Unify Stats Center fantasy points allowed with the schedule-enumerated, week-position-aware
   implementation rather than maintaining two definitions.
3. Add response caching only if production profiling justifies it. Any matrix key must include the
   semantic scoring-profile identity, source checksums, window, and policy version; member results
   must also include claimed-team and roster identities.
4. If the predictive model is revisited before the 2026 season, pre-register the materially changed
   policy and identify a genuinely untouched historical confirmation set before inspecting its
   result. Do not turn 2026 outcomes into a prerequisite for the current product.
5. Keep Schedule Edge explanatory. Automatic lineup, waiver, trade, or projection adjustments
   require a separate validation against those engines' existing baselines.
6. Run the normal integrated typecheck, lint, production build, container rebuild, and live member
   plus signed-out smoke checks before deployment.
