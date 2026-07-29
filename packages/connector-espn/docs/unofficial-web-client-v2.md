# ESPN web-client normalizer contract v2

This document describes Laces Out's parser contract for an observed ESPN Fantasy Football web-client response. It is **unofficial**, read-only, and versioned by this project. ESPN does not publish or guarantee this schema.

## Contract history

| Version | Change                                                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1      | Initial contract.                                                                                                                                                                                                                                                                                                           |
| v2      | ESPN re-encoded two `acquisitionSettings` fields (observed 2026-07-28). `waiverProcessDays` carries uppercase day names, and `matchupLimitPerScoringPeriod` is a boolean flag rather than the count v1 read it as. Both encodings parse; the boolean is never read as a count, which changes what a normalized limit means. |

The version bump follows this document's own drift protocol: a new encoding of the same meaning
extends a version, but `matchupLimitPerScoringPeriod` **changed meaning**, so the parser contract
and the normalized output it produces are versioned as v2. The bridge envelope's `schemaVersion`
is a separate contract between the browser extension and the server and remains `1`.

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

Contract v2 requires the fields used to produce normalized data:

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

Contract v2 accepts only the observed acquisition types `WAIVERS_TRADITIONAL`, `WAIVERS_CONTINUOUS`, and `FREE_AGENTS_ONLY`. A new ESPN value requires a reviewed contract version rather than a guessed mapping.

### Waiver processing days

`acquisitionSettings.waiverProcessDays` has been observed in two encodings. Both parse; a mixture
of the two in one array does not, because that would interleave numbers whose convention ESPN never
established with names this contract does map.

| Observed ESPN value                          | Normalized `operationalRules.waiverProcessDays` |
| -------------------------------------------- | ----------------------------------------------- |
| `["MONDAY","WEDNESDAY","FRIDAY","SUNDAY",…]` | `[0, 1, 3, 4, 5, 6]`                            |
| `[2, 4, 6]` (encoding observed before 2026)  | `[2, 4, 6]`, passed through unchanged           |
| `[]`                                         | `[]` — a real "no scheduled day" answer         |

Day names map to **`Date.prototype.getDay()` numbering (0 = Sunday)**. That convention is a
deliberate project decision rather than an ESPN fact: when the encoding changed, nothing downstream
consumed the field, `parseLeagueRules` did not read it, and no other connector populated it, so no
existing meaning constrained the choice. The pre-2026 numeric values `[2, 4, 6]` are ambiguous —
they read as Tue/Thu/Sat under both 0 = Sunday and 1 = Monday — so they neither settle nor
contradict the choice. The platform convention was taken because every future JavaScript consumer
compares against `getDay()`. Legacy numeric values are still passed through as ESPN encoded them,
so a legacy `7` (which 0 = Sunday cannot express) would survive as provider-encoded data.

ESPN's array is unordered and its order differs between leagues, so output is de-duplicated and
sorted ascending for deterministic normalization and stable checksums.

### Per-matchup acquisition limits

`matchupLimitPerScoringPeriod` was read as a count in v1. It is a **boolean flag** in the current
API — "is there a per-scoring-period acquisition limit", not "how many". It is never read as a
count: `false` must not flow into a limit, and `true` must not be invented into a number. Numeric
values are still accepted as counts for older responses.

| ESPN `matchupAcquisitionLimit` | ESPN `matchupLimitPerScoringPeriod` | `matchupAcquisitionLimit` | `matchupAcquisitionLimitEnabled` |
| ------------------------------ | ----------------------------------- | ------------------------- | -------------------------------- |
| absent                         | `false`                             | `null`                    | `false`                          |
| absent                         | `true`                              | `null`                    | `true`                           |
| `7`                            | `true`                              | `7`                       | `true`                           |
| `7`                            | `false`                             | `null`                    | `false`                          |
| `7`                            | absent                              | `7`                       | `true`                           |
| `-1`                           | absent or `false`                   | `null`                    | `false`                          |
| absent                         | `5` (numeric, pre-2026)             | `5`                       | `true`                           |
| absent                         | absent                              | `null`                    | `null`                           |

`matchupAcquisitionLimitEnabled: true` with a `null` limit means "a limit applies, count unknown",
which is deliberately distinguishable from "no limit". A `false` flag is authoritative over a
numeric limit ESPN left behind, since no limit is then in force.

`false` was observed on both active leagues captured on 2026-07-28. `true` was observed only on a
league ESPN had not activated for the season, so it is accepted and passed through verbatim and
nothing about active-league semantics is inferred from it.

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
4. Add an invented regression fixture and either extend the current version for a truly optional shape or add a new contract version for changed meaning. Keep the superseded fixture: it is the evidence of what was previously observed. `test/fixtures/web-client-v1.json` holds the pre-2026 numeric encodings; `web-client-v2-active-day-names.json` and `web-client-v2-active-empty-waivers.json` hold the 2026-07-28 shapes captured from active leagues.
5. Do not weaken an enum or identity check to “accept anything.” Unknown values require an intentional mapping.

## Known limitations

- This is a point-in-time current-league snapshot; it stores the schedule rows returned by ESPN but
  does not reconstruct artifacts ESPN omitted from that response.
- The core snapshot intentionally does not normalize draft-event, transaction, or free-agent data;
  those reads use the independently admitted supplemental contract below. Lineup writes remain out
  of scope.
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

## Supplemental read contract v1

The browser bridge admits the following bounded read-only artifacts independently after every
successful core league refresh. Each artifact has its own endpoint allowlist, checksum, strict
schema, idempotent receipt, normalized immutable snapshot, and failure boundary:

1. `kona_player_info` for league-specific `FREEAGENT`/`WAIVERS` state and ownership context;
2. `mMatchupScore` plus `mScoreboard` for weekly player-level actual/projected scoring and lineup
   efficiency;
3. `mTransactions2` for structured adds, drops, waiver claims, and bids; and
4. `mDraftDetail` for completed/on-demand draft results, including auction bids and keepers.

The core league snapshot is uploaded first. Current-period availability, box scores (once the
season has begun), transactions, and draft state then refresh separately on the same six-hour
schedule and on demand. A missing or drifting supplemental response is reported as partial
coverage and cannot invalidate the stored core roster, another supplemental feed, or the last
known-good artifact.

Contract validation was established with sanitized captures from three structurally distinct
leagues (two auction and one snake) and is preserved with invented regression fixtures. The real
captures are not retained in the repository or runtime.

Do not ingest the league message board. If transaction communication is ever evaluated, request
only the explicitly filtered activity feed and prove that no conversational content crosses the
bridge. ESPN player news, positional ratings, and global schedule/catalog reads remain lower-value
duplicates of the application's blended first-party sources.

## Research basis

Because ESPN provides no supported fantasy-league API contract, v1 was checked against maintained open-source clients that consume the same web-client structures:

- [`cwendt94/espn-api`](https://github.com/cwendt94/espn-api), especially its [base league](https://github.com/cwendt94/espn-api/blob/master/espn_api/base_league.py), [football settings](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/settings.py), [team](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/team.py), [player](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/player.py), and [constant maps](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/constant.py).
- [`mkreiser/ESPN-Fantasy-Football-API`](https://github.com/mkreiser/ESPN-Fantasy-Football-API), a JavaScript client using the v3 fantasy-football responses.

Those projects are implementation evidence, not an ESPN guarantee. This project owns the contract, tests, security posture, and future migration decisions.
