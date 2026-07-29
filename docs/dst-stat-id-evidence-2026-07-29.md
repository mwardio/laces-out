# ESPN D/ST stat-ID evidence — 206, 209, and the points-allowed ladder

- Date: 2026-07-29
- Method: documented community sources only, quoted from their raw source files, per the
  never-guess rule. ESPN's own support page (`support.espn.com` "Scoring Formats") and
  `nflreadr.nflverse.com` were unavailable during the evidence review, so no ESPN first-party
  document is cited; every conclusion below says so where it matters. This file is the first
  committed evidence record for these IDs.

## 1. ID 206 — established: "2pt Return" (`2PRET`)

Three documented maps agree:

- **cwendt94/espn-api**, `espn_api/football/constant.py`, `SETTINGS_SCORING_FORMAT_MAP`:
  `204: 'O2PRET' / 'Offensive 2pt Return'`, `205: 'D2PRET' / 'Defensive 2pt Return'`,
  `206: '2PRET' / '2pt Return'`. Its player `STATS_MAP` names both 205 and 206
  `defensive2PtReturns` (with an in-source TODO about the 205/206 distinction) — 206 is the
  generic/combined two-point-return category beside the offense/defense-specific 204/205.
  (https://github.com/cwendt94/espn-api/blob/master/espn_api/football/constant.py)
- **nntrn ESPN API gist**, "Stat column names" table (id column):
  `206 · 2PRET · 2pt Return`. (https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c)
- **ffverse/ffscrapr**, `R/espn__helpers.R` `.espn_stat_map()`:
  `"206" = "2PtConversionReturnedForTouchdown"` (its own wording for the same event; the file's
  header cites espn-api's constant.py). (https://github.com/ffverse/ffscrapr/blob/main/R/espn__helpers.R)

This is consistent with the community-described "defensive two-point return" meaning and with the
2-point value the three measured leagues carry.

**Data availability and pricing:** 206 is priced by the de minimis zero model in §4. The obstacle
to a historical-rate model is data, not meaning. Verified against the live datasets and their
generator on 2026-07-29:

- `stats_team_week_2024.csv` (the exact nflverse asset
  `packages/source-nflverse/src/team-weekly-stats-source.ts` ingests) carries only
  `passing_2pt_conversions`, `rushing_2pt_conversions`, `receiving_2pt_conversions`; its `def_*`
  column set has no two-point field. The nflreadr team-stats dictionary
  (`nflverse/nflreadr` `data-raw/dictionary_team_stats.json`) matches.
- `stats_player_week_2024.csv` and its dictionary: same — no defensive two-point column.
- The generator, nflfastR `calculate_stats()` (`R/calculate_stats.R`), computes only the three
  offensive conversion counts; no defensive two-point output exists in it.
- The event exists **only at play level**: nflverse pbp columns `defensive_two_point_attempt` /
  `defensive_two_point_conv` (nflreadr `data-raw/dictionary_pbp.csv`; built from NFL GSIS stat IDs
  403/404 in nflfastR `R/helper_tidy_play_stats.R`). The repo has no play-by-play source
  (`packages/source-nflverse/src/` holds players, injuries, schedules, snap counts, team-weekly,
  weekly-rosters, weekly-stats and nothing else).

Pricing 206 **from history** would therefore require play-by-play ingestion, aggregation, and
walk-forward evidence. Pricing it at a remembered rate is forbidden. Section 4 instead prices it
at constant zero under a citable occurrence bound, a narrower claim with a weaker burden.

## 2. ID 209 — established: "1pt Safety" (`1PSF`)

The same three maps agree exactly:

- **cwendt94/espn-api** `SETTINGS_SCORING_FORMAT_MAP`: `207: 'O1PSF' / 'Offensive 1pt Safety'`,
  `208: 'D1PSF' / 'Defensive 1pt Safety'`, `209: '1PSF' / '1pt Safety'`.
- **nntrn gist** (id column): `209 · 1PSF · 1pt Safety`.
- **ffscrapr**: `"209" = "1PtSafety"`.

This establishes 209 as the one-point safety (the try-play safety), the generic variant beside
207/208, consistent with the 1-point value the measured leagues carry.

**Data availability and pricing:** no ingested source carries the event—no such column exists in
`stats_team_week` or `stats_player_week`—so it can be neither projected nor backtested from the
current corpus. Section 4 prices it at constant zero under a recorded de minimis occurrence bound.

## 3. Points-allowed ladder 121–125 — repository mapping corroborated

All consulted documented maps agree:

| ID  | abbr | label                | repo component                       |
| --- | ---- | -------------------- | ------------------------------------ |
| 121 | PA18 | 18-21 points allowed | `points_allowed_18_21_probability`   |
| 122 | PA22 | 22-27 points allowed | `points_allowed_22_27_probability`   |
| 123 | PA28 | 28-34 points allowed | `points_allowed_28_34_probability`   |
| 124 | PA35 | 35-45 points allowed | `points_allowed_35_45_probability`   |
| 125 | PA46 | 46+ points allowed   | `points_allowed_46_plus_probability` |

Sources: espn-api `constant.py` (both maps; its STATS_MAP misnames 125 "45Plus" while its own
abbr/label say PA46/"46+" — the boundary is unambiguous given 124 = 35-45), the nntrn gist table,
and ffscrapr (122–125; 121 absent from its map). The repo's `ESPN_PLAYER_SCORING_STAT_ID_MAP_V1`
entries for 121–125 match every source, so **no map adjustment is made**. The three leagues'
absent 121/122 rows are consistent with ESPN omitting zero-point rungs, exactly as they omit 131
in the yards ladder. What could **not** be established (ESPN page unreachable): ESPN's default
point values for these rungs; the leagues' −1/−3/−5 stand as the leagues' own observed values,
which is all normalization prices anyway.

## 4. The de minimis zero criterion (adopted 2026-07-29)

This criterion applies **only to the two IDs named here**. It does not touch 204, 205, 207, or 208:
those variants are not present in any of the three measured leagues' rule sets, no occurrence bound
has been recorded for them, and they remain unsupported.

### 4.1 The criterion, stated before it is applied

> **De minimis zero.** A scoring component may be modeled at constant zero ONLY when publicly
> citable occurrence data bounds its expected fantasy points below **0.01 per team-week** at the
> league's own point values. The bound, its source, its denominator and its arithmetic must be
> recorded here before the component is emitted.

**This is a bounded, disclosed model claim, graded by the same gates as every other component — it
is not a dropped rule and it is not a remembered rate.** The three things it is not, spelled out,
because the distinction is the whole point:

- **Not a dropped rule.** The rule is mapped, priced, carried in the emitted profile, and multiplied
  into every scored line. Its coefficient is a modeled quantity that happens to be zero. A dropped
  rule would be silently absent from the profile and would leave the league's own scoring
  misrepresented; this one is present and stated.
- **Not a remembered rate.** Nothing here is recalled from memory or asserted without a source. The
  claim is not "this event happens about X times a year"; it is "publicly citable occurrence records
  bound this event's contribution below the stated threshold," with the records cited and the
  arithmetic shown. The number that gets shipped (zero) is the _lower_ end of that bound, so the
  disclosed error is one-sided and its size is written down.
- **Not exempt from the gates.** The zero components flow into the D/ST league-scored backtest and
  its publication gate exactly like every other component. Contributing exactly 0 to predicted,
  baseline and actual on every line, they cannot move a metric — which is the intended and stated
  consequence of the model, not an exemption from measurement.

**Falsifiability, and what revokes it.** The claim is falsifiable in the ordinary way: ingest a
play-by-play source, count the events per team-week, and compare. If a future measurement puts
either component's expected contribution at or above 0.01 points per team-week at any supported
league's point values, the de minimis licence for that component is revoked, it must be modeled from
data or returned to the unsupported set, and D/ST fails closed again for the leagues that price it.

**Denominator used throughout.** One D/ST scoring opportunity is one team-game, so a "team-week" is
a team-game: 272 regular-season games x 2 = **544 team-games per season** in the 17-game era
(2021-present), and 256 x 2 = 512 per season for 2015-2020. The 2015-2024 span used below is
therefore `6 x 512 + 4 x 544 = 5,248` team-games. 2015 is the correct start for both components:
the NFL's 2015 rule change is what first made either event possible at all.

### 4.2 ID 206 — defensive two-point returns, at the leagues' 2 points

- **Occurrence record.** The Professional Football Researchers Association's all-time compilation of
  defensive two-pointers lists, for 2015-2024: Stephone Anthony (NO, 2015-12-06, blocked PAT
  return), Tavon Young (BAL, 2016-09-18, blocked PAT), Will Parks (DEN, 2016-11-13, blocked PAT),
  Eric Berry (KC, 2016-12-04, intercepted 2pt attempt), Walt Aikens (MIA, 2016-12-11, blocked PAT),
  Aaron Colvin (JAX, 2017-12-24, blocked PAT), Donte Jackson (CAR, 2018-12-17, intercepted 2pt),
  Bobby Okereke (IND, 2019-11-17, intercepted 2pt), Rasheem Green (SEA, 2021-11-29, blocked PAT),
  Amani Hooker (TEN, 2023-12-03, intercepted 2pt), Kelee Ringo (PHI, 2024-09-29, blocked PAT) —
  **11 occurrences across 10 seasons**.
  (https://www.profootballresearchers.com/forum/viewtopic.php?t=8073 — read 2026-07-29 via search
  extraction; the host returned HTTP 403 to a direct fetch from this environment, so the list is
  recorded here as extracted rather than as a verbatim page quote. Wikipedia's
  `Conversion (gridiron football)` independently corroborates the rule's 2015 adoption and the
  Anthony play as the first: https://en.wikipedia.org/wiki/Conversion_(gridiron_football).)
- **The field this would be counted from if the repo ingested it:** nflverse play-by-play
  `defensive_two_point_conv` (with `defensive_two_point_attempt`), nflreadr
  `data-raw/dictionary_pbp.csv`, built from NFL GSIS stat IDs 403/404 in nflfastR
  `R/helper_tidy_play_stats.R` — see §1. The repo has no pbp source, which is why the bound comes
  from the occurrence record rather than from an ingested count.
- **Bound.** `11 / 5,248 = 0.00210` occurrences per team-week; at the 2 points all three leagues
  award, **0.0042 expected points per team-week** — about 2.4x under the 0.01 bar.
- **Sensitivity, because the compilation may be incomplete.** The bar is `0.01 x 5,248 / 2 = 26.2`
  occurrences over the same span. The criterion therefore survives the compiled list being short by
  more than a factor of two; it fails only if the true 2015-2024 count exceeds 26, which would mean
  the compilation missed more events than it recorded.

### 4.3 ID 209 — one-point safeties, at the leagues' 1 point

- **Occurrence record: zero in NFL history.** CBS Sports, "NFL's mysterious one-point safety: The
  bizarre scoring play that's never happened and how it finally could" (read 2026-07-29, page dated
  2026-06-30): the play has "NEVER happened in the NFL" and "we still haven't seen a one-point
  safety, which tells you just how improbable this exact play is." The same piece: "While there
  haven't been any one-pointers in the NFL, there have been two in college at the FBS level" — a
  2004 Texas game and Oregon's against Kansas State in the 2013 Fiesta Bowl.
  (https://www.cbssports.com/nfl/news/nfl-one-point-safety-explained/)
- **Correction to the figure in the ratification brief.** The brief recorded "1pt safeties ~ 2 in
  NFL history." The citable record puts the NFL count at **zero**; the two are FBS college
  occurrences. Recorded here rather than quietly adopted, per the never-guess rule. The correction
  strengthens the de minimis claim rather than weakening it.
- **Bound.** The measured expected value is exactly 0. Because a zero count needs an upper bound
  rather than a point estimate, the rule of three gives the 95% upper bound on the per-team-week
  rate from 5,248 zero-outcome team-games: `3 / 5,248 = 0.00057`; at the 1 point all three leagues
  award, **0.00057 expected points per team-week** — about 17x under the 0.01 bar.
- Note the bound is one the 2015 rule change created: before 2015 the play was not merely rare, it
  was impossible, so 2015 is the only defensible start of the exposure window.

### 4.4 What this changes in the code

- `defensive_two_point_returns` (206) and `one_point_safeties` (209) join the single consolidated
  D/ST component vocabulary, `TEAM_DEFENSE_COMPONENTS` in
  `packages/projections/src/first-party.ts`, whose accessor
  `firstPartyTeamDefenseProjectionComponents()` is what the `:slot:16` acceptance set, the DST
  position vocabulary and all three `availableStatIds` unions already derive from.
- The D/ST projector emits both at exactly 0 on every path (projected, bye/unscheduled, and the
  recency baseline), and they are excluded from the statistical loop, the calibration intervals and
  the backtest residual/metric streams: a constant has nothing to fit and nothing to grade, and
  folding always-zero residuals into the defense metrics would dilute measurements of components
  that are genuinely modeled.
- `ESPN_PLAYER_SCORING_STAT_ID_MAP_V1` maps `206` and `209` to those components; both leave
  `ESPN_UNSUPPORTED_DEFENSE_STAT_ID_REASONS`. 204, 205, 207 and 208 stay there with their existing
  per-ID reasons.
- **Consequence:** D/ST normalization support flips for all three sanitized fixture leagues —
  espn-league-b and espn-league-c become the first leagues supported at all six positions, and
  espn-league-a becomes K + D/ST (its bare per-N-yard bonuses still withhold QB/RB/WR/TE).
- **Disclosure channel:** the emitted profile now carries the two rules mapped to real components,
  so no normalization reason for them can "silently vanish" — there is nothing withheld to report.
  The affirmative disclosure that these two are priced at zero rides on the existing
  `defenseMethodWarnings` channel in `apps/worker/src/first-party-projections.ts`, which already
  carries this exact class of note (`points_allowed_method=...`,
  `blocked_kicks_classification=...`) into every published weekly set's metadata and every league's
  warning list. No new channel was invented.
