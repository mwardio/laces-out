# iOS waiver Week and Rest-of-season views handoff

Status: server contract implemented in Laces Out; native implementation required
Contract date: 2026-09-07
Mobile API version: 1 (unchanged)
Target repository: `mwardio/laces-out-ios`

## Outcome

Update the native Decision Desk waiver card so a member can switch between two independent views:

- **Week {N}** ranks add/drop moves from the upcoming scoring week's projections; and
- **Rest of season** ranks them again from the admitted rest-of-season projection release.

There is no blended score or blended view. Switching horizons changes the candidate projections,
target order, recommended drop for each target, every selected-drop comparison, rationale, and FAAB
guidance. Do not calculate one horizon on-device or relabel values from the other horizon.

The same response also adds the comparison matrix needed for the section-level **Player to drop**
picker. A target keeps its server ranking while the member changes the outgoing player; only that
target's displayed impact, FAAB guidance, and comparison rationale change.

Keep **Week {N}** selected on first load. This preserves the current experience and makes the new
server response backward compatible with existing iOS releases.

## Release boundary and score meaning

The server remains the source of truth for both rankings. Native code only selects and presents one
of the two precomputed sections.

| UI concept               | Week view                               | Rest-of-season view                               |
| ------------------------ | --------------------------------------- | ------------------------------------------------- |
| Player `projectedPoints` | Upcoming scoring-week points            | Aggregate points in the published ROS window      |
| `weightedGain`           | Weekly weighted roster-value change     | ROS-window weighted roster-value change           |
| `lineupGain`             | Weekly optimized starting-lineup change | ROS optimized starting-core change                |
| Recommendation order     | Best weekly legal fit                   | Best ROS legal fit                                |
| Recommended drop         | Best weekly drop for that target        | Best ROS drop for that target                     |
| FAAB                     | Derived from weekly gain                | Derived from gain normalized by ROS window length |

The ROS lineup score is an aggregate starting-core model over the published window. It is not a
week-by-week lineup simulation and should not be labeled as next week's projected score.
Weekly lineup impact honors mapped current-week lineup locks. ROS does not freeze one current
starting assignment across an aggregate multi-week horizon, but stored true-locked players remain
protected from drop recommendations in both views.

`projectedPoints` is a fantasy-point projection for the named horizon. `weightedGain` and
`lineupGain` are modeled changes measured in points: weighted roster value includes optimized
starters plus discounted bench depth, while lineup/starting-core gain includes starters only. Keep
the metric name beside each signed value; a bare `+4.8` does not tell the member what changed.

The candidate pools are independent too. Week starts from the highest weekly projections; ROS uses
a position-balanced bounded pool before ranking so aggregate quarterback totals cannot crowd every
other position out. Counts and target names may therefore differ even when both views are current.

The server normalizes ROS gain by the number of weeks in `windowStartWeek...windowEndWeek` before
deriving a FAAB range. The response's `faab` is ready to display; iOS must not divide it again or
borrow the Week view's bid. As in the existing contract, `faab` can be `null` for a non-FAAB league,
when the team has no known budget, or when a comparison does not clear the value bar. A ROS note
explains the normalization and should remain visible with the other section notes.

## Server contract

Continue fetching the authenticated snapshot from:

`GET /v1/leagues/{leagueId}/decisions`

No query parameter, second request, capability flag, or mobile API version bump is required.
The authoritative wire validator is `waiverDecisionSectionSchema` in
[`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts); use it to refresh
fixtures if this handoff and a later server revision ever differ.

### Authoritative ROS release boundary

An available ROS view means the server selected one authoritative, complete release. It does not
mean the server found any projection set whose horizon happened to say rest of season. Before
evaluation, the server requires a league-shared, explicitly identified first-party ROS set from a
full release whose publication did not signal that a prior good set had to be preserved. It also
checks the season/window timing, exact current scoring-profile compatibility for every evaluated
position, and projection coverage for every player in the member's modeled active roster.

Partial, sampled, shadow, synthetic, private/user-imported, withheld, or scoring-incompatible sets
must never appear as an available ROS view. A newer incompatible artifact does not displace an older
compatible authoritative set. The nested `projectionSet` identifies the exact set selected, and its
own `projectionFreshness` may still be `aging` or `stale`.

These admission facts are intentionally enforced server-side and are not all repeated on the wire.
iOS must not recreate the release gate, inspect the display `source` string as an admission flag, or
manufacture ROS recommendations from another set. Consume `restOfSeason.state`; when it is
unavailable, render its reasons.

### Backward-compatible response shape

Every pre-existing top-level `waivers` field retains its Week-view meaning. When that section has
`state == "available"`, the server also adds a nested `restOfSeason` discriminated union:

```json
{
  "waivers": {
    "state": "available",
    "candidateCount": 24,
    "evaluatedMoveCount": 312,
    "dropCandidates": [],
    "recommendations": [],
    "execution": {
      "mode": "provider-required",
      "provider": "espn",
      "label": "Open ESPN to verify and apply manually",
      "url": "https://fantasy.espn.com/football/"
    },
    "notes": ["No bounded add/drop pairing improved projected roster value."],
    "restOfSeason": {
      "state": "available",
      "label": "Rest of season · Weeks 2–18",
      "windowStartWeek": 2,
      "windowEndWeek": 18,
      "projectionSet": {
        "id": "80000000-0000-4000-8000-000000000001",
        "source": "laces-out-first-party-ros",
        "version": "2026-week-2",
        "horizon": "rest-of-season",
        "sourceObservedAt": "2026-09-15T10:00:00.000Z",
        "sourceObservedAtStatus": "verified",
        "importedAt": "2026-09-15T10:05:00.000Z"
      },
      "projectionFreshness": {
        "state": "fresh",
        "observedAt": "2026-09-15T10:00:00.000Z",
        "label": "Fresh ROS projections"
      },
      "candidateCount": 24,
      "evaluatedMoveCount": 288,
      "dropCandidates": [],
      "recommendations": [],
      "notes": [
        "No bounded add/drop pairing improved aggregate rest-of-season roster value.",
        "Starting-core impact optimizes one legal lineup against aggregate ROS totals; it is not a week-by-week lineup simulation."
      ]
    }
  }
}
```

The empty arrays above keep the example compact; production recommendation and player objects use
the existing shapes described below.

When weekly waiver analysis succeeds but no compatible admitted ROS projection set can be used,
the nested union is unavailable:

```json
{
  "state": "unavailable",
  "reasons": [
    {
      "code": "PROJECTIONS_MISSING",
      "message": "No current admitted rest-of-season projection release is available for this league."
    }
  ]
}
```

Render server reason messages instead of mapping particular codes to native copy. Codes may become
more specific over time.

If the outer `waivers.state` is `unavailable`, its existing shape does not gain
`restOfSeason`. ROS does not bypass a failed roster, rules, identity, projection, or other core
weekly decision prerequisite. Keep the current unavailable experience and do not show a horizon
control.

This rollout makes three additive changes to an available weekly waiver payload:

- `waivers.dropCandidates` is new;
- every `waivers.recommendations[]` item gains `dropComparisons`; and
- `waivers.restOfSeason` is new.

Swift's synthesized `Decodable` ignores unknown object keys, so a current released client continues
to read the pre-existing fields and show its one fixed weekly add/drop pairing. Pin that behavior
with a new-server fixture before rollout if the app uses a custom decoder.

The reverse direction matters too: a newly released iOS app can connect to an older or self-hosted
server. Decode all three additions as optional in the weekly transport model. When
`restOfSeason` is absent, show only Week. When the weekly comparison fields are absent, hide the
player picker and retain the legacy fixed-pairing presentation from each move's top-level `drop`,
`weightedGain`, `lineupGain`, and `faab`. Do not create a one-item comparison matrix because that
would falsely imply the server evaluated alternatives. A current ROS `available` payload always
requires its drop candidates and every move's comparisons.

Do not introduce unknown-key rejection for this response.

### Available ROS fields

An available `restOfSeason` object contains:

- `state`: exactly `"available"`;
- `label`: server display text for the admitted release window;
- `windowStartWeek` and `windowEndWeek`: required integers in `1...25`, with end greater than or
  equal to start;
- `projectionSet`: the ID, source, version, horizon, observed-at verification, and import time for
  the exact admitted ROS set used to calculate the view; its `horizon` must be exactly
  `"rest-of-season"`;
- `projectionFreshness`: the ROS set's independent `fresh`, `aging`, `stale`, or `missing` state,
  observed time, and display label;
- `candidateCount`: the bounded available-player pool evaluated by the server;
- `evaluatedMoveCount`: legal add/drop pairings evaluated, not the number displayed;
- `dropCandidates`: selectable roster-player objects;
- `recommendations`: at most eight ranked waiver-target objects; and
- `notes`: horizon-specific disclosure strings.

It intentionally has no separate `execution` object. Applying either horizon's recommendation is
the same provider action, so reuse the outer weekly section's existing `execution` link.

The snapshot's top-level `provenance.projectionSet` and `provenance.projectionFreshness` continue to
describe the weekly calculation for compatibility. Never use them to source a ROS label or
freshness indicator. The nested `projectionSet` and `projectionFreshness` are the ROS provenance
boundary. Nested `aging`, `stale`, or `missing` freshness describes provenance quality; it does not
override an `available` union state. Show the app's normal freshness warning while retaining the
result. The union's `unavailable` state preserves the ROS view but replaces its recommendations
with the server's explanation.

### Existing move and comparison shapes

ROS uses the same waiver player, move, market, FAAB, and drop-comparison wire shapes as the current
weekly response:

```json
{
  "add": {
    "id": "70000000-0000-4000-8000-000000000001",
    "name": "Incoming Player",
    "positions": ["WR"],
    "nflTeam": "CHI",
    "status": "ACTIVE",
    "projectedPoints": 188.4
  },
  "drop": {
    "id": "70000000-0000-4000-8000-000000000002",
    "name": "Outgoing Player",
    "positions": ["WR"],
    "nflTeam": "DET",
    "status": "ACTIVE",
    "projectedPoints": 121.1
  },
  "weightedGain": 54.37,
  "lineupGain": 18.2,
  "faab": { "low": 6, "recommended": 9, "high": 13 },
  "market": null,
  "rationale": "Adding Incoming Player and dropping Outgoing Player improves weighted roster value by 54.37 points (Rest of season · Weeks 2–18).",
  "dropComparisons": [
    {
      "dropPlayerId": "70000000-0000-4000-8000-000000000002",
      "weightedGain": 54.37,
      "lineupGain": 18.2,
      "faab": { "low": 6, "recommended": 9, "high": 13 }
    }
  ]
}
```

Preserve these server invariants in the view model:

- `dropCandidates` have unique IDs;
- `dropCandidates` contains at most 64 players, and each present comparison array contains 1–64
  entries;
- recommendation `add` IDs are unique within each view;
- no recommendation `add` ID also appears among rostered `dropCandidates`;
- each recommendation's `drop` is its best modeled drop and appears in `dropCandidates`;
- `dropComparisons` contains that recommended drop and has at most one entry per drop-player ID;
- the recommended-drop comparison exactly matches the move's top-level `weightedGain`,
  `lineupGain`, and nullable FAAB range;
- every selectable drop candidate appears in at least one recommendation's legal comparison array;
- a section-level drop candidate need not be legal for every target, so a recommendation may omit
  that player's comparison; and
- recommendations stay in server order. The selected drop changes displayed impact, not target
  ranking.

## Native UI behavior

### Horizon control

Place a segmented control immediately below the **Waiver wire** heading and before the player-to-drop
control. Use **Week {N}** when `snapshot.league.week` exists and **This week** otherwise. Use
**Rest of season** in visible copy rather than the unexplained abbreviation **ROS**.

- Default to Week whenever the member first opens a league's Decision Desk.
- When `restOfSeason.state == "available"`, both segments are enabled and switch local view state
  without another network request.
- When `restOfSeason.state == "unavailable"`, keep Rest of season selectable. Selecting it shows an
  unavailable panel containing the server reasons instead of recommendations. Ensure VoiceOver can
  discover the availability state and explanation.
- When `restOfSeason` is absent, treat the deployment as an older server and show the existing Week
  UI without a second segment or an error.
- When the outer waiver section is unavailable, show the existing unavailable card and no horizon
  control.

Do not silently substitute Week data inside a visible Rest-of-season view. If a refresh changes ROS
from available to unavailable while it is selected, keep Rest of season selected, replace its
recommendations with the server reasons, and announce the change for assistive technology.
While Week remains selected, show a concise **Rest of season unavailable** explanation below the
horizon control so the selectable empty view is not a surprise.

Keep unavailable distinct from an available view with zero recommendations. The former means the
server could not authoritatively model ROS and must show its reasons; the latter means legal pairs
were evaluated but none improved aggregate roster value and should show the horizon-specific clear
state.

The entire snapshot arrives in one response, so there is no separate tab-loading request. Retain
the existing snapshot loading and last-good-data behavior. Switching segments should be immediate.
When Rest of season is active, source any projection age/status treatment from its nested
`projectionFreshness`; the snapshot's top-level freshness remains Week-only.

### Active-view labels

Every number and summary must come from the active section. Recommended compact labels are:

| Element           | Week                                     | Rest of season                                           |
| ----------------- | ---------------------------------------- | -------------------------------------------------------- |
| Target projection | `{value} pts · Week {N} projection`      | `{value} pts · Rest-of-season projection`                |
| Primary metric    | `Week {N} roster impact`                 | `ROS roster impact`                                      |
| Secondary metric  | `Lineup impact` + `Week {N}` context     | `Starting core impact` + rest-of-season context          |
| Clear state       | `No worthwhile add/drop move this week.` | `No worthwhile rest-of-season add/drop move.`            |
| Window context    | `Week {N}`                               | Server `label`, with `Weeks {start}–{end}` as a fallback |

The compact `ROS` abbreviation is acceptable next to a numeric value when the full phrase is
already visible in the selected segment. Its accessibility label must still say “rest of season.”
Do not place Week and ROS point values side by side or imply their magnitudes are directly
comparable. When `snapshot.league.week` is null, replace **Week {N}** with **This week** throughout
visible and accessibility copy.

Use the active recommendation's server `rationale` for its recommended drop. The current server
returns a complete standalone sentence with the action, direction, weighted magnitude, explicit
horizon, and terminal punctuation, for example:

```text
Adding Tyrone Tracy Jr. and dropping Josh Jacobs improves weighted roster value by 4.75 points (Week 1).
```

Do not apply a line limit, fade, fixed-height frame, or overlay that makes this text appear cut off.
In SwiftUI, allow the text to wrap vertically (for example, `fixedSize(horizontal: false,
vertical: true)` where the surrounding layout otherwise compresses it), place the divider after
the full text, and give it enough vertical layout priority to resist truncation. Inset the scroll
content above the actual floating bottom-navigation height plus the device bottom safe area—prefer
`safeAreaInset(edge: .bottom)` or the app's shared tab-bar inset over a device-specific constant.
The final card's full rationale and divider must be able to scroll completely above the navigation
on both home-indicator and non-home-indicator iPhones. A legacy server rationale without terminal
punctuation may receive one presentation-only period; do not rewrite or guess at missing rationale
clauses.

For another selected drop, build a complete comparison sentence from that active horizon's
`dropComparisons`. Use **improves ... by {absolute value} points**, **reduces ... by {absolute value}
points**, or **leaves ... unchanged** instead of combining “changes by” with a signed number. Name
the Week or rest-of-season horizon and the lineup/starting-core effect, and always end the sentence
with punctuation.

```text
Adding Brock Purdy while dropping Josh Jacobs improves Week 1 weighted roster value by 4.24 points and improves the projected starting lineup by 2.80 points.
```

Format the roster and lineup deltas independently; either clause can improve, reduce, or remain
unchanged. Use **but** when their directions conflict.

Render all active-section `notes`. The ROS FAAB-normalization note must not be filtered as duplicate
weekly boilerplate.

### Player-to-drop selection

The player picker remains section-level. Its options come only from the active horizon's
`dropCandidates`; never merge Week and ROS candidate arrays.

Keep one shared selected-drop ID for each league, not hidden Week and ROS selections. On switching
or refreshing the active horizon, resolve that shared selection in this order:

1. carry the shared selected player across when its ID appears in the new view's `dropCandidates`;
2. only when that player is illegal or absent in the new view, select
   `recommendations.first.drop` when present; then
3. fall back to `dropCandidates.first`; if neither exists, show no picker selection.

When a view-specific fallback is required, it becomes the new shared selection. Returning to the
other view carries that player when legal; do not restore an older per-horizon choice behind the
member's back.

An unavailable ROS payload has no candidate list against which to validate the player. Hide the
drop picker in that unavailable view and retain the shared ID unchanged. Validate it against the
active candidates only after the member returns to Week or a later refresh makes ROS available.

For every target, find the active comparison by exact `dropPlayerId`. If none exists, display **Not
legal** and the existing roster-rule explanation for that target. Do not substitute the target's
recommended drop behind the member's selection.

Once a current comparison matrix is present, render `weightedGain`, `lineupGain`, and `faab` from
the matching comparison even when the selected player happens to equal the recommendation's
top-level `drop`. The top-level move values describe the server's best pairing and remain the
legacy fallback only when the entire weekly matrix is absent.

For FAAB presentation, a missing comparison means **Not legal**, a nonpositive comparison gain
means **No bid**, a positive gain with a range shows the range, and a positive gain with null `faab`
means budget guidance is unavailable. Never let a target-level or Week-level bid fill one of those
gaps.

The “best modeled drop” indicator compares the selected ID with that active recommendation's
`drop.id`. A different choice can have a negative impact or no bid while the target remains in its
server-ranked position.

Scope horizon and drop state to the selected deployment, account, and league. Clear it on logout,
account switch, deployment switch, or league removal.

## Codable model sketch

These are response-only models, so `Decodable` is sufficient even if the existing project names
them `Codable`. Reuse the current `DecisionPlayer`, `WaiverMove`, `DecisionUnavailableReason`, and
comparison models rather than creating ROS copies.

```swift
struct WeeklyWaiverAvailable: Decodable, Sendable {
    let candidateCount: Int
    let evaluatedMoveCount: Int

    // Optional only so this client can still read an older server.
    // Preserve nil versus [] to distinguish legacy absence from a current empty matrix.
    let dropCandidates: [DecisionPlayer]?
    let recommendations: [WaiverMove]
    let execution: DecisionExecution
    let notes: [String]

    // Optional is required for older-server compatibility.
    let restOfSeason: RestOfSeasonWaivers?
}

struct WaiverMove: Decodable, Sendable {
    let add: DecisionPlayer
    let drop: DecisionPlayer
    let weightedGain: Double
    let lineupGain: Double
    let faab: FaabRange?
    let market: WaiverMarket?
    let rationale: String

    // Optional only for older-server compatibility in the weekly view.
    let dropComparisons: [WaiverDropComparison]?
}

struct WaiverDropComparison: Decodable, Sendable {
    let dropPlayerId: String
    let weightedGain: Double
    let lineupGain: Double
    let faab: FaabRange?
}

enum RestOfSeasonWaivers: Decodable, Sendable {
    case available(RestOfSeasonWaiverAvailable)
    case unavailable(reasons: [DecisionUnavailableReason])
    case unsupportedState(String) // Local forward-compatible fallback.

    private enum CodingKeys: String, CodingKey {
        case state, reasons
    }

    private enum KnownState: String, Decodable {
        case available, unavailable
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let rawState = try values.decode(String.self, forKey: .state)

        guard let state = KnownState(rawValue: rawState) else {
            self = .unsupportedState(rawState)
            return
        }

        switch state {
        case .available:
            self = .available(try RestOfSeasonWaiverAvailable(from: decoder))
        case .unavailable:
            self = .unavailable(
                reasons: try values.decode(
                    [DecisionUnavailableReason].self,
                    forKey: .reasons
                )
            )
        }
    }
}

struct RestOfSeasonWaiverAvailable: Decodable, Sendable {
    let label: String
    let windowStartWeek: Int
    let windowEndWeek: Int
    let projectionSet: DecisionProjectionSetReference
    let projectionFreshness: ProjectionFreshness
    let candidateCount: Int
    let evaluatedMoveCount: Int
    let dropCandidates: [DecisionPlayer]
    let recommendations: [WaiverMove]
    let notes: [String]
}
```

Decode known `available` and `unavailable` payloads strictly enough that missing required fields are
contract errors. Treat a future unknown nested state as an unavailable optional feature so it does
not make the otherwise valid Week view disappear. Validate the available window and collection
bounds in the same layer that currently validates Decision Desk responses.

For local `unsupportedState`, keep Week usable and present Rest of season as unsupported with a
short local update-required explanation. Do not infer recommendations from unknown-state fields.

For Week, treat `dropCandidates == nil` together with every `dropComparisons == nil` as the legacy
fixed-pairing contract. Treat a partially present matrix as malformed. For a current Week response
or any available ROS response, require the arrays and enforce the server invariants; do not let the
transport optionals weaken current-contract validation. Normalize to a separate view-data type only
after making that distinction.

If the existing native waiver union stores its available fields in an associated payload, add
`restOfSeason` to that payload. Do not add it to the outer unavailable case.

## Accessibility and adaptive layout

- Give the control an accessibility label such as **Waiver projection period** and expose the
  selected value.
- Expand `ROS` to “rest of season” in every VoiceOver value and hint.
- After a horizon change, announce **Showing Week {N} waiver recommendations** or **Showing
  rest-of-season waiver recommendations, Weeks {start} through {end}**. Move accessibility focus to
  the updated summary, not the first claim button.
- When an unavailable Rest-of-season view is selected, announce **Rest-of-season waiver
  recommendations are unavailable** followed by its first server reason, and focus the unavailable
  panel. Do not announce that Week recommendations are showing.
- Announce drop changes with both player and horizon, for example **Showing rest-of-season impact if
  you drop Josh Jacobs**.
- Express signed values as **improves by** or **reduces by** in accessibility values. Do not rely on
  green/red or a plus/minus glyph alone.
- Let player names, unavailable reasons, rationales, notes, and window labels wrap at all Dynamic
  Type sizes. Do not horizontally scroll the full card.
- If the standard segmented picker cannot keep both labels readable at accessibility sizes, switch
  to two full-width accessible buttons or a labeled menu while preserving the same two choices.
- Respect Reduce Motion when updating rows and preserve a stable focus target across refreshes.

## Required tests

### Contract and model tests

1. Decode a legacy available waiver payload with no `dropCandidates`, `dropComparisons`, or
   `restOfSeason`; Week remains usable in fixed-pairing mode.
2. Decode the new available and unavailable ROS variants, including nested projection provenance,
   freshness, notes, and window bounds.
3. Prove the current released decoder ignores all three additive fields and still shows weekly
   values.
4. Reject a partial weekly comparison matrix and known available payloads with a missing label,
   invalid window, duplicate target/candidate ID, a target also offered as a drop, an unreferenced
   drop, unknown comparison ID, missing recommended-drop comparison, or top-level/recommended-
   comparison value mismatch according to existing validation policy.
5. Degrade an unknown future nested state without losing the Week section.
6. Decode null and populated FAAB independently in Week and ROS moves and comparisons.
7. Decode the server's unavailable responses for partial, withheld, or scoring-incompatible ROS
   inputs, and prove that a `projectionSet.source` display label never changes the decoded union
   state.

### View-model and UI tests

1. Week is the initial selection and uses only outer waiver values.
2. Switching to ROS replaces target order, projections, recommended drops, comparisons, rationale,
   counts, provenance/freshness treatment, notes, and FAAB with ROS values.
3. One shared drop selection carries across horizons when legal and uses the documented active-view
   fallback only when a switch or roster refresh makes it illegal.
4. A selected drop absent from one target's comparisons renders **Not legal** without changing the
   target's rank or silently using another drop.
5. A matching comparison supplies all three dynamic values; ROS null FAAB never displays the Week
   or target-level bid, and populated ROS FAAB is not renormalized on-device.
6. Missing optional ROS data produces Week-only UI; missing legacy weekly comparison fields also
   hide the player picker without hiding fixed weekly recommendations.
7. Unavailable ROS remains selectable and shows its server explanation; weekly unavailable produces
   the existing whole-section state with no horizon control.
8. An available-to-unavailable refresh keeps ROS selected, replaces its recommendations with the
   reasons, retains the shared drop ID, and makes one accessibility announcement without exposing
   Week values.
9. Empty recommendation arrays show the horizon-specific clear state.
10. Switching league, account, or deployment does not leak a prior horizon or player selection.
11. Snapshot tests cover narrow width, long player names, maximum Dynamic Type, dark mode, and both
    provider execution-link states.
12. VoiceOver tests cover segment labels, unavailable ROS reasoning, signed impacts, the selected drop,
    and focus after switching.
13. Long and legacy rationales wrap above the divider without clipping, and the final card scrolls
    fully above bottom navigation on home-indicator and non-home-indicator iPhones; every displayed
    rationale reads as a complete, punctuated sentence.

Run the full native regression suite after the focused Decision Desk tests. Existing lineup, trade,
provider deep-link, stale snapshot, and authentication behavior must remain unchanged.

## Rollout and acceptance checklist

Roll out server first. The change is additive, so released iOS builds continue showing weekly
recommendations. Then:

1. verify the production endpoint with one authoritative complete ROS release, one partial/withheld
   release that returns unavailable, and one newer scoring-incompatible release that does not
   displace an older compatible set;
2. verify an older/self-hosted deployment that omits the additive fields;
3. add the optional decoder and fixtures in `mwardio/laces-out-ios`;
4. add the horizon and selected-drop view state, then the native control and labels;
5. validate TestFlight on compact and large iPhones with VoiceOver and large Dynamic Type; and
6. ship the native control response-driven, with Week as its default.

No client feature flag is required. If the server rolls back or a self-hosted deployment has not
upgraded, the optional fields disappear and the native app naturally returns to Week-only,
fixed-pairing behavior without the player picker.

The native work is complete when:

- Week and Rest of season show independently ranked, independently scored moves;
- Rest of season is populated only from the server-admitted authoritative complete release;
- the active horizon and point meaning are unmistakable;
- player-to-drop selection follows the preservation and fallback rules;
- every rationale is complete, punctuated, and visible without clipping;
- unavailable or absent ROS data never masquerades as weekly data;
- ROS FAAB is displayed only from its own server response;
- existing provider execution remains read-only and shared by both views; and
- old servers retain their Week-only fixed-pairing UI, and current released clients remain
  compatible.
