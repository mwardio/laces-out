# Scoring transform evidence

## Yahoo yardage settings

[Yahoo's scoring FAQ](https://help.yahoo.com/kb/fantasy-football/SLN6441.html) documents independent fractional and negative yardage settings. It also explicitly combines field-goal total yardage with distance-category awards. Therefore stat 84 must honor fractional-points settings, and disabling negative points requires the expectation of the positive part of each actual game total.

The implementation learns `*_yards_nonnegative` and whole-group counts from historical game observations. It never replaces `E[max(0, yards)]` with `max(0, E[yards])`, nor rounds a projected mean. [Yahoo's negative-points details](https://football.fantasysports.yahoo.com/f1/details/negative_points) do not establish sub-group negative rounding sufficiently to choose floor versus truncation. Signed Yahoo whole-group scoring remains explicitly unsupported unless its integer multiplier makes rounding irrelevant.

## ESPN every-N and incomplete passes

The public [ESPN 2025 player-stat API](https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2025/players?view=kona_player_info), read on 2026-09-17, carries these realized observations (`statSourceId=0`, `statSplitTypeId=1`):

| Player/week       | Raw category               | Observed every-N categories                 |
| ----------------- | -------------------------- | ------------------------------------------- |
| De'Von Achane / 4 | rushing stat 24 = 99       | stat 27 = 19; stat 28 = 9                   |
| Justice Hill / 1  | rushing stat 24 = -14      | stats 27 and 28 absent, representing zero   |
| Nick Chubb / 7    | receiving stat 42 = -5     | stats 47 and 48 absent, representing zero   |
| Derius Davis / 14 | punt-return stat 115 = -10 | stats 118 and 119 absent, representing zero |

Thus these whole-group categories count complete positive groups; signed per-yard scoring remains a separate category. Negative observed yardage contributes a zero group observation rather than being excluded from training. The same feed directly identifies incompletions as stat 2: Josh Allen has 26 attempts (0), 15 completions (1), and 11 incompletions (2). Incomplete-pass coefficients are lowered exactly onto attempts minus completions.

## Supported threshold bonuses

The existing learned events distinguish passing 300–399/400+, rushing 100–199/200+, and receiving 100–199/200+ games. A matching bounded bonus uses one event probability; an at-least bonus uses the exact union of the disjoint events. Arbitrary thresholds and missing event components remain unsupported. The later long-touchdown extension below supplies six additional exact event counts; it does not infer touchdowns from ordinary explosive plays.

## Yahoo bonus ingestion evidence limit

[Yahoo's category FAQ](https://help.yahoo.com/kb/SLN6442.html) establishes that bonuses accumulate with regular category points and with other reached bonuses. Its current [API reference](https://sports.yahoo.com/developer/docs/) demonstrates ordinary stat modifiers, but does not establish a bonus modifier payload shape.

A bounded read-only check on 2026-09-17 fetched official settings for all six active connected Yahoo leagues in the 2026 season, using existing tokens without refreshing them or writing application state. Every modifier contained only `stat_id` and `value`; no bonus node occurred. All six settings explicitly enabled fractional points and negative points. One included field-goal total yards (stat 84) at 0.1 points per yard. Only scoring node keys and numeric rule values left the running API container; tokens, league identities, and personal XML fields were neither logged nor copied.

The current connector preserves modifier IDs and values only. The new projection normalization can price the supported explicit bonus rows, but end-to-end Yahoo bonus ingestion remains unverified until an official payload containing bonuses establishes its structure. No speculative XML interpretation or claim of complete Yahoo bonus support is made.

## Kicker scenario semantics

ROS model v10 samples integer fine-distance makes and misses conditionally within each simulated coarse count. Extra-point misses use their explicit weekly center, preserving zero; when that component is absent but attempts are supplied, attempts minus makes supplies the center. Extra-point attempts then equal sampled makes plus misses. The existing extra-point dispersion controls both count laws, with independent draws conditional on their shared volume multiplier.

Made-field-goal distance means start at fine-bucket midpoints and receive a common bounded shift to match the projected total yardage mean. Each make's modeled distance is one of the two adjacent integers surrounding its bucket's mean. The sum is therefore an integer, its conditional expectation matches the fitted total, and whole-group scoring rounds each game's realized total before season aggregation. This is a minimal within-bucket distance-spread model, not a claim that the full observed distance distribution has been reproduced. An infeasible total-yard center is bounded to the range allowed by its fine-distance counts and emits `kicker_yardage_mean_bounded`, retained with reusable outcome metadata.

Every kicker week consumes 23 uniforms, including byes, unavailable weeks, and zero-intensity weeks: seven original broad-count draws, three fine-make splits, five fine-miss splits, two extra-point-miss draws, and six integer-distance draws. Scoring coefficients consume no randomness. New model calibration and release evidence remain required; these mathematical scoring checks do not replace held-out statistical validation.

## Historical observation completeness and missed extra points

The cached official 2019–2025 player-week feeds contain the required field-goal distance, return yardage, extra-point, and bonus-source yardage columns. All 44,782 regular-season fantasy-position rows have finite values for these categories; the source parser rejects missing columns or invalid stat cells. Missing raw categories in other inputs remain unknown, rather than being converted into observed zero events. Canonical-only aggregate observations survive repeated normalization.

Played snap-only appearances are different: a matched completed-game snap observation without a player-stat row establishes an observed zero-production game. These rows now carry explicit zeros for the full position vocabulary, including derived groups and indicators. Previously their missing raw stats excluded the game from weighted means while their derived zeros remained included. In a two-game regression, 100 receiving yards followed by a zero-production appearance now forecasts 47.115 yards under the fixed recency baseline instead of 100. Roster-only completed nonappearances also have explicit zero components and remain marked `played: false`.

Both providers count a blocked extra-point attempt as a missed extra point. The official ESPN endpoint above reports Joshua Karty's 2025 week 2 as makes (86) = 3, attempts (87) = 4, misses (88) = 1. A read-only authenticated request to [Yahoo's corresponding historical player endpoint](https://fantasysports.yahooapis.com/fantasy/v2/players;player_keys=461.p.41081/stats;type=week;week=2) reports makes (29) = 3 and misses (30) = 1. The same nflverse observation has `pat_missed = 0` and `pat_blocked = 1`. Across the cached 2019–2025 kicker rows, attempts minus makes is 461, comprising 398 ordinary misses and 63 blocks. Canonical `extra_points_missed` therefore derives from known attempts minus makes; the immutable source facts retain nflverse's original ordinary-miss value. When attempts or makes are absent, an existing canonical miss count is retained and no count is invented.

These historical observation corrections change fitted forecasts and are bound to weekly model v12. They require new chronological backtest evidence; prior v11 results do not qualify the corrected model.

## Blocked field goals and source replay

Both providers also include blocked field goals in total and distance-specific misses. For Joshua Karty's 2025 week 3, nflverse records zero ordinary misses and two blocks at 36 and 44 yards. The official ESPN endpoint reports total misses (85) = 2, 0–39 misses (82) = 1, and 40–49 misses (79) = 1. [Yahoo's same historical player/week endpoint](https://fantasysports.yahooapis.com/fantasy/v2/players;player_keys=461.p.41081/stats;type=week;week=3), checked read-only, reports 30–39 misses (26) = 1, 40–49 misses (27) = 1, and total misses (86) = 2.

The source parser now requires `fg_blocked` and `fg_blocked_list`, validates the integer distances against the exact blocked count, and adds those events to canonical total and fine-distance misses. Separate blocked counts/buckets and the original ordinary-miss total remain available for auditing. It rejects missing/malformed blocked distances, inconsistent distance totals, and inconsistent attempts rather than allocating unknown blocks to an assumed bucket. All cached 2019–2025 rows satisfy these checks: 138 blocked attempts including postseason, zero invalid stat/context rows, and no normalization idempotence failures among the 44,782 regular-season fantasy-position rows.

The parser component schema is `nflverse-player-week-components-v3`, and weekly model v13 supersedes v12 for this correction. Player-week source metadata binds that component schema separately from shared worker schema 4. Legacy archived observations trigger an unconditional reparse when due; corrected observations receive a distinct immutable checksum, and subsequent 304/identical-body checks preserve the corrected selection. Other source types retain their existing schema and replay behavior. New release evidence must use these corrected observations, including the source schema/checksums, rather than treating old database fine-miss buckets as current.

## Position isolation before the long-touchdown extension

Normalization v6 retains the unsupported offense scope of ESPN's six long-touchdown bonus categories while allowing independently complete kicker and D/ST scoring. ESPN's [official scoring formats](https://support.espn.com/hc/en-us/articles/360003914032-Scoring-Formats) classify these as passing, rushing, and receiving categories. The [current official application bundle](https://cdn1.espn.net/kona/4267ee551fba-1.495/_next/static/commons/main-ea37851d1a90339e9ae6.js), retrieved 2026-09-17, explicitly binds IDs 15/16 to passing 40+/50+, 35/36 to rushing 40+/50+, and 45/46 to receiving 40+/50+ touchdown bonuses. Its SHA-256 is `b070e111e8151ff580ac3ccc48520b84a1d2a09f8c1ff8a43b020ac2a5b26873`.

All QB/RB/WR/TE projections remain withheld when any of these rules is nonzero. Unknown categories and IDP rules keep their existing conservative scope; a known offensive bonus cannot narrow an unrelated unknown failure. No long-touchdown statistic is inferred, and physical weekly v13/ROS v10 outcomes remain unchanged. Newly available kicker/DST profiles still need their own exact scoring validation against the locked weekly predictions and shared ROS outcomes.

## Lineup display precision

Decision algorithm v8 retains a complete legal current lineup when the optimum's entire projected gain is strictly below 0.05 points, half the interface's 0.1-point display unit. The comparison uses the full coherent assignment, including FLEX, bench eligibility and kickoff locks. Missing projections, absent schedule evidence, known inactive/bye/out statuses, and zero-projection starters cannot invoke retention. The retained response states the alternative's exact small gain and reports zero proposed gain. Larger combined gains remain actionable even if individual swaps are small. This is a presentation stability rule, not a claim that projection error is 0.05 points; close substantive choices retain their ordinary uncertainty assessment.

## Exact long-touchdown events and composite source snapshots

Weekly model v14, ROS model v11, scoring map v7, and player-source component schema v4 supersede the earlier long-touchdown restriction. The six supported ESPN categories are nested event counts: a touchdown of at least 50 yards also earns the 40-yard bonus. In the official [ESPN 2024 actual-stat feed](https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2024/players?view=kona_player_info), Saquon Barkley's week 12 has two rushing touchdowns (25), two 40+ touchdowns (35), and two 50+ touchdowns (36). The captured response SHA-256 is `16d4679b14fd644e1a2c6d8b8642355edaf2e765a7b8901de6fec722daddc915`; only realized regular-season rows (`statSourceId=0`, `statSplitTypeId=1`) establish these semantics.

The source reducer streams official nflverse play-by-play and attributes passing, rushing, and receiving touchdowns to the credited player and credited distance. It uses explicit touchdown flags, passer/receiver/rusher/TD-player IDs, primary yardage, and lateral-player yardage; the [nflfastR field reference](https://nflfastr.com/reference/fast_scraper.html) documents these fields. The weekly CSV's ordinary 40-yard-play counters include non-touchdowns and cannot substitute for this event data. The four lateral touchdowns in the audited 2019–2025 data reconcile through their credited lateral player and yards. One concrete check is Detroit's 2024 week 17 lateral touchdown: Jameson Williams receives the 40+ receiving event; Amon-Ra St. Brown does not. ESPN's same actual-stat feed confirms that allocation.

The offline reconciliation covers 345,005 play-by-play rows, 130,777 identified player-games, and 9,651 offensive touchdown plays across 2019–2025 and the available 2026 week 1. It found no missing touchdown attribution/distance and no per-player/game mismatch against player-week passing, rushing, or receiving touchdown totals. This proves the captured source coverage, not the predictive accuracy of the new components. The 2026 play-by-play SHA-256 is `b69f55a172965e16c2ac9104dc96e268dd56dc357ebdfd8ac2c68151afe9da59`; the paired player-week CSV is `af043a5d702df0f745da0496198cf817407415ca4857e84a6b815713fd19fd05`.

Each admitted player-week now requires matching play-by-play game/team/opponent coverage and exact reconciliation of all three touchdown totals. Only then can absence of a positive event establish zero. Invalid distances, ambiguous attribution, conflicting totals, or incomplete game coverage reject the whole replacement snapshot. Both providers' inclusive blocked-kick miss corrections and signed-yardage observations remain intact. The immutable source checksum binds schema v4, raw player CSV bytes, and raw play-by-play bytes. A play-by-play-only correction therefore creates a new source identity even when the CSV is unchanged. Player and team refreshes share one season-scoped play-by-play result; its lifetime ends with that batch.

The weekly model preserves missing long-touchdown components when relevant training history is incomplete, including mixed legacy rows and synthetic zero-production appearances. ROS likewise requires coherent scheduled-week component coverage; bye zeros cannot establish a missing capability. Point publication rejects priced missing components in any locked predicted, baseline, or actual row, and checks current live components separately. Independent complete positions can still publish. Fresh chronological weekly evidence and a new ROS corpus are required for v14/v11; earlier v13/v10 forecasts cannot certify the new event model.

The pinned weekly audit overlays 55,539 matched historical rows with zero unmatched rows while preserving every other snapshot field. For 2023–2026 it verifies the raw player CSV against the original stored player-source checksum and the raw play-by-play against the original paired team-source composite checksum. Its provenance records old and new source identities; the original input snapshot remains unchanged.
