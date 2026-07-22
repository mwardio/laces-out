# nflverse source adapters

This package admits bounded, attributed data from official `nflverse-data` GitHub releases. It does
not scrape nfl.com, Pro Football Reference, or another presentation site.

## Datasets

### Injury reports

- Release pattern: `injuries/injuries_<season>.csv`; published coverage begins in 2009.
- Grain: one reported player/team/week injury and practice state. Distinct states are preserved. On
  the historical schema, a valid `date_modified` is normalized to UTC and included in snapshot
  identity, so chronologically distinct snapshots are not collapsed; an exact repeated snapshot is
  rejected as a duplicate.
- Schema generations: current releases include `season_type` and omit `date_modified`; historical
  releases omit `season_type` and may include `date_modified`. The adapter validates `season_type`
  when present and otherwise derives it from `game_type`. The timestamp is optional, but a nonblank
  value must be valid UTC ISO-8601.
- Status normalization: report designations normalize to `out`, `doubtful`, `questionable`,
  `probable`, or `note`. Practice participation normalizes to `did-not-participate`, `limited`,
  `full`, `out`, or `note`. Unknown nonblank values fail the row rather than being interpreted as a
  known availability state.
- Completeness respects the sparse source grain: teams with no reported injuries and weeks without
  rows are not required. The gate rejects catastrophically small artifacts, more than 32 season
  teams, mixed game types within a represented week, regular-season rows after postseason rows, and
  postseason weeks exceeding the possible participating-team count.

### Canonical players

- Release: `players/players.csv`
- Identity: GSIS ID is required. ESPN and PFR IDs are retained when valid so downstream ingestion
  can resolve provider observations without name matching.
- Existing coverage: the catalog is the canonical identity layer, not a historical-stat record.

### Weekly player stats

- Release pattern:
  `stats_player/stats_player_week_<season>.csv`
- Loader contract: seasons 1999 and later, matching nflverse's `load_player_stats(...,
summary_level="week")` contract. A season is usable only when the corresponding release asset
  exists.
- Identity and grain: one GSIS player ID and game ID per observation. Regular-season and postseason
  rows remain distinct.
- Supported fields: common passing, rushing, receiving, return, kicking, fantasy-reference, and
  usage/efficiency fields. `sourceFantasyPoints` is retained only as an upstream cross-check. Laces
  Out should always recompute points from the normalized components and the league's typed scoring
  rules.

### Weekly rosters

- Release pattern: `weekly_rosters/roster_weekly_<season>.csv`; published coverage begins in 2002.
- Grain: one reported player, team, status, season, and week. Historical files can contain multiple
  status observations for the same player/team/week, so the adapter preserves distinct statuses
  rather than inventing an ordering that is absent upstream; exact repeated status rows are
  rejected as duplicates. The raw playoff round is retained as `gameType` and normalized to
  `seasonType` in the same way as the stat and snap-count adapters.
- Identity: GSIS, ESB, smart, GSIS-IT, ESPN, Yahoo, Sleeper, Sportradar, Rotowire, PFF, PFR, and
  FantasyData IDs are normalized independently. At least one canonical-catalog key (GSIS, ESB, or
  smart ID) is required. `weeklyRostersIdentityKey` consistently selects GSIS first, then ESB, then
  smart ID. Downstream model ingestion may quarantine observations without a GSIS match while still
  retaining the source row for later identity reconciliation.
- Status: the upstream short code and detailed status abbreviation are retained. Common codes are
  also classified as active, inactive, reserve, practice squad, suspended, exempt, or unavailable;
  new syntactically valid codes remain visible as `other` instead of being guessed.
- Completeness: a changed artifact must begin at week 1, contain consecutive weeks and all 32 season
  teams, preserve a single game type per week, meet regular-season and playoff team-count bounds,
  and include at least 40 admitted players per represented team-week. These checks prevent a partial
  release from replacing last-known-good roster state.

### Snap counts

- Release pattern: `snap_counts/snap_counts_<season>.csv`
- Loader contract: seasons 2012 and later, matching nflverse's `load_snap_counts` contract. A season
  is usable only when the corresponding release asset exists.
- Upstream origin: nflverse documents these game-level observations as sourced from Pro Football
  Reference.
- Identity and grain: one PFR player ID, team, and game per observation, with offense, defense, and
  special-teams counts and shares. Persistence must resolve the PFR ID through the canonical player
  catalog; name-only matches are not admitted automatically.
- Raw playoff stages (`WC`, `DIV`, `CON`, and `SB`) remain available as `gameType` and are also
  normalized to postseason `seasonType` for cross-dataset filtering.

### Schedules and opponents

- Release: `schedules/games.csv`. This is one cumulative, corrected artifact rather than a
  season-specific file. The adapter retains its whole-file checksum while selecting one validated
  season and a non-empty `REG`/`POST` filter context. Callers must persist the returned
  `selectionKey` with validators; the adapter deliberately bypasses validators from a different
  context so a shared artifact checksum cannot suppress a required season parse.
- Upstream maintenance: nflverse publishes the release from Lee Sharpe's `nflverse/nfldata`
  schedule dataset. Only fields carried by the nflverse release cross the admission boundary.
- Grain: `games` contains one game row; `teamGames` expands every admitted game to two symmetric
  team/opponent rows. A team absent from an otherwise complete regular-season week can therefore be
  identified as on bye without guessing from player statistics.
- Dates remain NFL season-local `YYYY-MM-DD` values and kickoff clock times remain explicitly US
  Eastern, matching the upstream contract. A blank kickoff time is retained as `timeTbd`; the
  adapter does not invent a UTC instant around daylight-saving transitions.
- `status` is deliberately limited to `scheduled` or `final` and is derived from a complete score
  pair. The schedule release is not a live score/status feed, so a past scheduled row must not be
  interpreted as proof that a game is in progress or postponed.
- `REG` remains regular season. `WC`, `DIV`, `CON`, `SB`, and a future normalized `POST` value are
  exposed as postseason while the original playoff round remains available as `gameType`.

## Admission boundary

- URLs are constructed from a validated season and a fixed HTTPS GitHub release path. Redirects are
  manual, limited to three, and restricted to GitHub release-asset hosts.
- Requests time out after 30 seconds. Weekly-stat responses are limited to 24 MiB and 25,000 rows;
  weekly-roster responses are limited to 32 MiB and 100,000 rows; snap-count responses are limited
  to 12 MiB and 75,000 rows; injury and schedule responses are each limited to 8 MiB, with injury
  feeds capped at 50,000 rows and schedules at 20,000 artifact rows. Injury and schedule CSV
  records are limited to 64 KiB.
- Conditional requests retain `ETag` and `Last-Modified`. A SHA-256 body checksum provides stable
  replay detection when release assets omit or change HTTP validators.
- A missing season artifact is classified as `NOT_AVAILABLE`, separate from transient upstream
  failures. Before the active season's first release, schedulers should keep the last completed
  season healthy and probe the new season on their normal low-frequency cadence.
- Required columns, bounded values, identity format, season context, game context, duplicate keys,
  and basic count relationships are checked before rows cross the adapter boundary.
- Schedule admission is stricter than the bulk player datasets: one malformed selected row,
  duplicate game, or team/week collision rejects the complete selection. Unknown seasons or a
  not-yet-published requested season segment return `NOT_AVAILABLE`, preserving the caller's
  last-known-good schedule.
- Small artifacts may reject at most 25 rows. Larger artifacts may reject at most 2 percent of rows.
  Exceeding that allowance rejects the entire artifact so last-known-good persisted data can remain
  active.
- Results include row counts, rejection categories, covered weeks, source URL, validators, checksum,
  check time, license, and attribution. Worker persistence retains admitted observations as
  immutable, checksum-versioned rows linked to an ingestion run and surfaces partial identity
  coverage through source health.

## Attribution and operations

The `nflverse-data` repository is licensed under CC BY 4.0. Display the attribution values exported
by each adapter anywhere these data are presented. Snap-count UI should preserve the included Pro
Football Reference source acknowledgement as well. Schedule consumers should also retain the
published nflverse attribution; check nflverse licensing and upstream field provenance again before
redistributing fields beyond the admitted schedule/opponent subset.

During the season, the worker checks the prior and active seasons daily and replays the full season
artifact when its checksum changes; the release is a corrected cumulative file, not an append-only
feed. Each admitted checksum is stored as a new immutable observation version. Unmatched identities
stay quarantined, and source metadata is publishable only after the complete artifact passes both
adapter and canonical-match thresholds. Backfills use the same path rather than bypassing
validation.
