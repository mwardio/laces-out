# ESPN web-client normalizer contract v1

This document describes Laces Out's parser contract for an observed ESPN Fantasy Football web-client response. It is **unofficial**, read-only, and versioned by this project. ESPN does not publish or guarantee this schema.

The normalizer accepts either:

- the browser-local bridge envelope described below; or
- the raw JSON payload inside that envelope, with optional caller-supplied provenance metadata.

It produces the provider-neutral `LeagueSyncBundle` contract. It does not fetch ESPN, access browser cookies, accept ESPN credentials, or write lineups. Network and credential handling are deliberately outside this module.

## Public API

```ts
normalizeEspnWebClientSnapshot(
  input: unknown,
  options?: {
    now?: () => Date;
    capturedAt?: string;
    endpoint?: string | null;
    checksumSha256?: string | null;
  },
): LeagueSyncBundle;
```

`EspnWebClientNormalizationError` exposes a stable error `code` plus value-free issues containing only a path and a contract message. Imported values are never copied into validation issues.

Serialized input is limited to 5 MiB before schema traversal. JSON numbers used as provider IDs must be safe integers. Numeric strings up to 20 digits are accepted without conversion through JavaScript `number`, so full ESPN league, team, and player IDs are retained.

## Browser-local envelope

The strict envelope is compatible with `EspnBridgeSnapshot`:

```json
{
  "schemaVersion": 1,
  "provider": "espn",
  "authority": "browser-local",
  "readOnly": true,
  "leagueId": "123456789",
  "season": 2026,
  "capturedAt": "2026-09-24T14:30:00.000Z",
  "endpoint": "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456789?view=mSettings&view=mTeam&view=mRoster&view=mStandings&view=mMatchup",
  "checksumSha256": "<64 lowercase hex characters>",
  "payload": {}
}
```

No additional envelope properties are accepted. The endpoint must:

- use `https://lm-api-reads.fantasy.espn.com` with no credentials or fragment;
- use the league path matching the envelope season and league ID;
- contain `mSettings`, `mTeam`, and `mRoster` views;
- contain only the supported view query parameter; and
- optionally include `mStandings` and `mMatchup`.

The payload `id` and `seasonId` must also match the envelope. The bridge parses ESPN's response,
serializes the payload once with `JSON.stringify`, and checksums that canonical upload value. The
server verifies the same serialization before normalization. This protects transport integrity; it
does not turn the unofficial ESPN response into an authenticated ESPN artifact.

For raw payload input, the checksum is calculated over the exact input string. Object input is checked over `JSON.stringify(input)`. A valid caller-supplied checksum is preserved instead. The browser-local envelope always wins over raw-payload options.

## Observed required payload

Contract v1 requires the fields used to produce normalized data:

- Root: `id`, `seasonId`, `scoringPeriodId`, `status.latestScoringPeriod`, `settings`, `members`, and `teams`; `schedule` is required when `mMatchup` was requested.
- `mSettings`: league name/size, acquisition settings, draft settings, lineup-slot counts, playoff team count, and scoring items.
- Optional operating rules retained when ESPN supplies them: acquisition limits, minimum bid,
  waiver processing schedule, keeper count, regular-season/playoff structure, seeding and tie
  rules, median-game scoring, trade deadline/review settings, veto threshold, and divisions.
- `mTeam`: team identity/name, owner member IDs, and optional abbreviation/logo.
- Optional team state retained when ESPN supplies it: waiver priority and FAAB remaining, derived
  from the league budget and that team's reported acquisition-budget spend.
- Members: ID, display name, and league-manager flag.
- `mRoster`: team roster entries with matching IDs at `playerId`, `playerPoolEntry.id`, and `playerPoolEntry.player.id`; `ONTEAM` state; team ownership; lineup slot; full name; eligible slots; pro-team ID; and injury status.
- `mStandings`: an overall record and playoff seed for every team, including wins, losses, ties,
  points for/against, and streak state.
- `mMatchup`: schedule rows with provider matchup ID, week, outcome, home/away team IDs, and total
  points.

Additional response fields are ignored because ESPN returns many view-specific objects that this contract does not consume. Missing required nodes, wrong types, unsupported mapped enum values, and cross-object inconsistencies fail closed as `SCHEMA_DRIFT`.

The following consistency rules are enforced:

- `settings.size` equals the team array length and playoff count does not exceed it;
- member, team, and rostered-player IDs are unique;
- team owners resolve to `members`, and `primaryOwner` occurs in `owners` when present;
- `playerPoolEntry.onTeamId` matches the containing team;
- every occupied lineup slot exists with a positive configured count;
- a roster does not exceed the league's configured slot capacity; and
- every player has a supported concrete position among its eligible slots.
- standings are either complete for every team or omitted, with unique positive ranks; and
- matchup IDs are unique, both sides reference different league teams, historical/future outcomes
  agree with the scoring period, and a declared winner agrees with the scores.

## Normalization choices

### Draft and waivers

| Observed ESPN value                    | Normalized value                           |
| -------------------------------------- | ------------------------------------------ |
| `AUCTION`                              | `auction` with `auctionBudget`             |
| `SNAKE`, `AUTOPICK`, `SNAIL`           | `snake` (`AUTOPICK`/`SNAIL` add a warning) |
| `isUsingAcquisitionBudget: true`       | `faab` with `acquisitionBudget`            |
| `FREE_AGENTS_ONLY`                     | `free-agent`                               |
| waivers with `waiverOrderReset: true`  | `reverse-standings`                        |
| waivers with `waiverOrderReset: false` | `rolling`                                  |

Contract v1 accepts only the observed acquisition types `WAIVERS_TRADITIONAL`, `WAIVERS_CONTINUOUS`, and `FREE_AGENTS_ONLY`. A new ESPN value requires a reviewed contract version rather than a guessed mapping.

### Roster positions

Known ESPN lineup slots 0–25 are mapped explicitly. Slot 22 is ESPN's invalid code and is accepted only as a zero-valued setting; it can never appear on a player. Reserve slots `BN` (20), `IR` (21), `ER` (24), and `ROOKIE` (25) are marked non-starting. Slot 23 is normalized as `FLEX`.

Primary position is the first concrete position in `eligibleSlots`, following the behavior of maintained ESPN clients. `defaultPositionId` is validated as an integer but not interpreted as a lineup-slot ID; those are different ESPN namespaces (for example, a tight end can have `defaultPositionId: 4` while TE is lineup slot 6).

Pro-team IDs are mapped through the observed NFL table. Zero becomes `null`; an unknown nonzero value fails closed so a league move or provider change cannot silently mislabel a player.

### Scoring

ESPN scoring items provide numeric `statId` and `points`. `pointsOverrides` are position-specific and keyed by lineup-slot ID. The normalized schema has no native override field, so v1 expands them as additional rules:

```text
<statId>:slot:<slotId>
```

For example, ESPN stat 122 with a D/ST override becomes `122:slot:16`. A warning records this convention. Downstream scoring evaluators must understand this composite ID before applying override rules.

### Identity and provenance

League, team, and player external IDs remain season-scoped:

```text
espn:<season>:<leagueId>
espn:<season>:<leagueId>:team:<teamId>
espn:<season>:player:<playerId>
```

Manager external IDs retain the full ESPN member ID. Bridge envelopes use the normalized `browser-local` provenance mode. A raw payload without an envelope uses `public-unofficial` because its browser authority cannot be established by this parser.

### Standings and weekly matchups

`LeagueSyncBundle.standings` and `LeagueSyncBundle.matchups` are optional provider-neutral
point-in-time snapshots. When the bridge endpoint requests `mStandings` or `mMatchup`, the matching
payload data is mandatory; omitting it is schema drift rather than an empty league.

Standing rows retain both the season-scoped normalized team key and the provider-native team ID as
text. ESPN's current `playoffSeed` supplies both normalized rank and playoff seed. Matchups retain
the provider matchup ID and both provider-native team IDs as text. Decimal IDs up to 20 digits are
never converted through an unsafe JavaScript number.

An ESPN outcome of `HOME`, `AWAY`, or `TIE` is final. An undecided matchup in the current scoring
period is `in-progress`; one in a future period is `scheduled`. Scheduled scores normalize to
`null` rather than a misleading provider placeholder zero. In-progress scores remain available for
weekly opponent analysis.

The bridge payload does not identify which member is currently signed in. Therefore all teams normalize with `isCurrentUser: false`. Consumers must resolve the current user through a separate explicit association rather than guessing from owner ordering.

## Drift response

ESPN can change this response without notice. When a production snapshot fails:

1. Keep the rejected artifact private and preserve its checksum/capture metadata.
2. Compare only field paths and types against the fully invented test fixture; do not commit user payloads, cookies, member names, or real league IDs.
3. Confirm the change against at least one maintained client or multiple independently captured sanitized payloads.
4. Add an invented regression fixture and either extend v1 for a truly optional shape or add a new contract version for changed meaning.
5. Do not weaken an enum or identity check to “accept anything.” Unknown values require an intentional mapping.

## Known limitations

- This is a point-in-time current-league snapshot; it stores the schedule rows returned by ESPN but
  does not reconstruct artifacts ESPN omitted from that response.
- It does not normalize draft-event, transaction, free-agent, or lineup-write data.
- It does not identify the signed-in ESPN member.
- The checksum verifies the bridge's canonical uploaded payload, not ESPN authorship or the original
  response whitespace.
- A configured league ID is transport scope only. The application must independently require
  established owner/commissioner authority before replacing an existing league season.
- Player identity fields are observations. Consumers must not overwrite a trusted shared player
  catalog or create verified global crosswalks from this payload. Any fallback identity must remain
  league-scoped and excluded from unscoped player discovery.
- It supports the observed NFL lineup-slot and pro-team tables only.
- It performs no lineup writes or other ESPN mutations.

## Supplemental read roadmap

The maintained `cwendt94/espn-api` client demonstrates additional read-only web-client surfaces
that are valuable but intentionally remain outside contract v1. Add them as separate bounded,
versioned artifacts so a supplemental failure can never block the core league snapshot:

1. `kona_player_info` for league-specific `FREEAGENT`/`WAIVERS` state and ownership context;
2. `mMatchupScore` plus `mScoreboard` for weekly player-level actual/projected scoring and lineup
   efficiency;
3. `mTransactions2` for structured adds, drops, waiver claims, and bids; and
4. `mDraftDetail` for completed/on-demand draft results, including auction bids and keepers.

Do not ingest the league message board. If transaction communication is ever evaluated, request
only the explicitly filtered activity feed and prove that no conversational content crosses the
bridge. ESPN player news, positional ratings, and global schedule/catalog reads remain lower-value
duplicates of the application's blended first-party sources.

## Research basis

Because ESPN provides no supported fantasy-league API contract, v1 was checked against maintained open-source clients that consume the same web-client structures:

- [`cwendt94/espn-api`](https://github.com/cwendt94/espn-api), especially its [base league](https://github.com/cwendt94/espn-api/blob/master/espn_api/base_league.py), [football settings](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/settings.py), [team](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/team.py), [player](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/player.py), and [constant maps](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/constant.py).
- [`mkreiser/ESPN-Fantasy-Football-API`](https://github.com/mkreiser/ESPN-Fantasy-Football-API), a JavaScript client using the v3 fantasy-football responses.

Those projects are implementation evidence, not an ESPN guarantee. This project owns the contract, tests, security posture, and future migration decisions.
