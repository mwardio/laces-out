# ESPN live-draft calibration without a disposable league

The ESPN bridge has a separate **local calibration build** for inspecting a salary-cap mock draft
in ordinary Chrome. It validates only the selector candidates and structural assumptions already in
the repository. It does not upload calibration results, read browser cookies, copy credentials,
capture HTML, or include ESPN-rendered text, URLs, league IDs, team IDs, player IDs, or bid values in
its report. If checked-in selectors are wholly or partially insufficient, it also emits a narrowly
filtered structural discovery report so a developer can propose new candidates without requesting
a DOM snapshot.

Calibration never enables live sync. Every selector in `ESPN_DRAFT_SELECTORS` remains
`verified: false` until a developer reviews the sanitized report, updates the selector table, and
runs the adapter tests. The separate auction/snake profile approval also remains false until its
authenticated state matrix passes. The ordinary live-room recognizer still rejects mock routes
because they do not belong to a paired league.

## Build on the headless machine

Using the workspace dependencies already installed in this checkout, run from the repository root:

```bash
npm run build:calibration -w @laces-out/espn-bridge
```

This creates:

```text
apps/espn-bridge/dist-package/laces-out-espn-bridge-calibration-v0.8.0.zip
```

The normal `build` and `build:store` commands do not declare the calibration content script. The
calibration ZIP is deliberately minimal: it contains no service worker, cookie or storage
permission, pairing surface, popup, optional host permission, or upload-capable script. It is for
local unpacked installation only; do not submit it to the Chrome Web Store.

## Transfer and load it on the browser computer

The project and API can remain on the headless machine. Copy only the generated ZIP to the computer
where ordinary Chrome and the ESPN draft room will run. For example, run this on the browser
computer, substituting the SSH host:

```bash
scp user@headless-host:/path/to/laces-out/apps/espn-bridge/dist-package/laces-out-espn-bridge-calibration-v0.8.0.zip .
unzip laces-out-espn-bridge-calibration-v0.8.0.zip -d laces-out-espn-bridge-calibration
```

Then:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted directory containing `manifest.json`.
4. Sign in to ESPN normally in that browser. Do not export or copy cookies to the server.
5. Enter an ESPN football **salary-cap mock draft room**, not merely the mock-draft lobby.
6. Open that tab's DevTools Console, enable **Preserve log**, and filter for
   `LACES_OUT_ESPN_`. If the waiting-room line was emitted before DevTools opened, reload once now;
   treat that reload as the start of a new page session.
7. Before the first bid, wait for a `LACES_OUT_ESPN_SESSION_EVIDENCE_V1` line whose
   `auctionEvidenceObserved.currentOnlyZero` or `currentOnlyPositive` field is `true`. Keep the
   console open through an accepted bid, a completed sale, and a later nomination. When available,
   also observe the waiting, paused, and completed states as described below.
8. Before leaving or reloading the page, copy the newest line for each marker that appeared:
   `LACES_OUT_ESPN_CALIBRATION_V1`, `LACES_OUT_ESPN_SESSION_EVIDENCE_V1`, and, if selectors missed,
   `LACES_OUT_ESPN_STRUCTURAL_DISCOVERY_V2`. Copy only those complete one-line reports, not arbitrary
   console output.

The snapshot line records current selector candidate indexes and cardinalities. The session-evidence
line is a bounded in-memory aggregate of changed snapshots from one loaded page. It records only
fixed booleans and enums for:

- waiting/live/paused/complete states seen during that page lifetime;
- salary-cap mode, first and later nominations, and current-only versus accepted-bid frames;
- whether the highest-bid line parsed with a nonempty full team name and matched the current offer;
- bounded budget-row, completed-sale-row, and completed-state history shape; and
- row-count-bucket advancement or regression and fixed selector-problem categories.

No bid amount or team name appears in the aggregate. The pre-bid current offer is classified only
as zero or positive. The recorder cannot know whether the user copied a frame before another drafter
bid, so perform that step while the bid history is visibly empty. If the first captured frame already
contains an accepted bid, use the opening state of a later salary-cap mock rather than guessing.

The aggregate intentionally has `scope: "single-page-lifetime"` and uses no extension or page
storage. Reload, navigation, or a late join starts a new empty aggregate. To collect reload or
late-join evidence, copy the newest marker lines **before** the page transition, keep DevTools'
Preserve log enabled, then copy the newest marker lines emitted by the new page session. A completed
room reload likewise requires pre-reload and post-reload line sets. The aggregate's fixed
`continuityLimits` fields make this boundary explicit.

The on-page badge uses fixed Laces Out copy and is non-interactive. The console line contains only:

- fixed selector-family and invariant names;
- the zero-based index of a matching checked-in selector candidate;
- bounded `none`/`one`/`many` and row-count buckets;
- fixed draft-state and draft-type classifications; and
- fixed accumulated session-evidence booleans and zero-versus-positive opening-offer categories;
- pass/fail/inconclusive states.

It is safe to transfer those marker reports back for review. Do not send a DevTools DOM snapshot, page
source, HAR file, cookie export, screenshot containing private league information, or arbitrary
console output.

### Partial-selector structural fallback

The second structural-discovery line appears when structural calibration fails and at least one
checked-in family is cleanly missing, ambiguous, inconsistent, or missing its configured attribute.
Thus a valid root match no longer suppresses discovery of missing descendants. Query failures alone
do not trigger a scan. The report remains a bounded, local console diagnostic. It scans at most
2,048 elements and returns at most 18 signatures, with at most three generations of ancestry, three
class tokens, and three attribute names per generation. Element and occurrence counts are buckets
rather than exact page values. Report V2 includes the selector-table revision so candidate indexes
remain reproducible after candidate ordering changes.

Each signature contains only:

- a tag reduced to a fixed HTML tag allowlist (or `other`);
- class tokens containing ASCII letters, `_`, or `-` that have no digits, fit the length and
  entropy limits, and decompose entirely into a fixed draft/UI vocabulary; and
- allowlisted `data-*` **attribute names**, never their values.

For example, a structural path may safely reveal that a `div.auction-current` is beneath a
`section.draft-room`, or that an element has a `data-auction-panel` attribute. This is enough to
suggest a selector for a later reviewed build. The report never reads rendered text, HTML, URLs,
ID values, numeric provider values, ARIA labels, non-class attribute values, cookies, storage, or
network state. Opaque hashes and class tokens containing a private/user-defined word are discarded
instead of partially redacted.

The discovery line does not add selectors, change any `verified` flag, enable the live feed, or
authorize an upload. If its `paths` list is empty, do not compensate by sharing page source or a DOM
snapshot; the privacy boundary takes precedence over additional evidence.

ESPN's public mock flow may launch a room with an ephemeral numeric, league-shaped URL rather than
an explicit `mockDraftId`. The calibration recognizer accepts either exact room shape locally. The
ordinary live-feed activation still requires a service-worker preflight matching the stored league
pairing. A seasonless numeric league route is usable only when that pairing resolves one exact
season; malformed, unpaired, or multi-season scopes remain inert. This allowance does not turn a
mock room into an upload source and never infers a season from the calendar.

## Static candidate provenance (not live verification)

Selector-table revision 2 incorporates render-code evidence from ESPN's official football draft
bundle, anonymously fetched on 2026-08-11 (build
`90216808-e960-4555-8614-95ab1fc2d5b4`):

`https://cdn1.espn.net/kona/03952a533239-1.461/_next/90216808-e960-4555-8614-95ab1fc2d5b4/page/football/draft.js`

That static evidence supports provisional candidates for the room root, scenario markers,
salary-cap budget rows, completed-sale rows and their text cells, current player and offer, and the
first/highest bid-history line. It also supports parsing that line as an amount plus full fantasy
team name, and deriving a missing nomination number as `completed sales + 1` only when the
completed-history surface was observed and every sale reconciled contiguously. All such candidates
and both draft-mode profiles remain unapproved (`verified: false` / `approved: false`).

Authenticated passes must still confirm rendered selector cardinality, exact text formats,
team-row count semantics, non-virtualized complete history (including reload/late join), first and
later nominations, and the waiting/live/complete transitions used by the normal auction path. A
paused-state pass is required before a paused-specific selector can be trusted, but an unobserved
paused-only path does not need to block activation of otherwise validated auction states: leave that
selector `verified: false`, and the runtime must HOLD if ESPN later enters a pause that cannot be
resolved through a verified state source. Static code does not expose the
provider team/player IDs, nominating team, keeper/round/ownership data, snake-versus-linear
distinction, or completed-room reload behavior needed to approve those paths.

The pass must explicitly record `.current-amount` before the first bid and after an accepted bid.
Static code alone does not establish whether the pre-bid number is an accepted `$0` offer or the
next/opening offer (for example `$1`). Calibration therefore requires the current-offer amount to
correlate with the first/highest bid-history line in an active-bid frame, and the auction profile
must remain unapproved until the opening-state meaning is confirmed. Runtime never promotes a
standalone current-offer label into an accepted high bid.

The session aggregate reports only `currentOnlyZero` versus `currentOnlyPositive`, followed by
`acceptedCurrentAmountCorrelated`; it never reports the amount. That is sufficient to classify the
opening label without exporting a live bid value.

## Build the ordinary bridge after selector review

Once the sanitized evidence has been reviewed and the confirmed selector families have been
updated in `dom-adapter.ts`, run its tests before changing their `verified` flags. Then build the
ordinary local bridge on the headless machine:

```bash
npm run build -w @laces-out/espn-bridge
```

Transfer and unzip this artifact on the browser computer using the same process as above:

```text
apps/espn-bridge/dist-package/laces-out-espn-bridge-v0.8.0.zip
```

Disable the calibration extension, load the ordinary bridge's extracted directory through
`chrome://extensions`, and pair it from Laces Out. Keeping the two builds separate makes it obvious
which artifact can communicate with the API. An unreviewed or structurally mismatched selector
table continues to produce no live observations.

## Keeping Laces Out services headless on draft day

A normal browser computer is required for the current design because the read-only sensor observes
the already-rendered ESPN draft room. The repository, API, database, and other local clients do
**not** need to move off the headless machine. The minimal calibration extension cannot feed the
API; after the selector evidence is reviewed, build and transfer the ordinary bridge for the live
rehearsal and draft.

If the headless services are not already reachable through a private HTTPS address, an SSH tunnel
from the browser computer can expose their loopback ports locally:

```bash
ssh -N \
  -L 3000:127.0.0.1:3000 \
  -L 4000:127.0.0.1:4000 \
  user@headless-host
```

With the tunnel running, open the Laces Out app at `http://localhost:3000` on the browser computer
and pair the extension there; its API requests to `http://localhost:4000` traverse the tunnel. Keep
the tunnel, Chrome, the ESPN room tab, and the Laces Out headless services running for the draft.
The browser continues to hold its own ESPN session; no ESPN session material crosses the tunnel.

Use the exact ports configured for the local deployment if they differ. Prefer a private network or
SSH tunnel over exposing an unauthenticated development port publicly.

## What mock calibration proves—and what it cannot prove

A salary-cap mock room can validate current DOM selector shapes, active-auction field presence,
mutation timing, and completed-sale row structure without creating a league. The session aggregate
can record bucket advancement and can expose a bucket regression as negative continuity evidence.
No regression is not positive proof that offscreen rows are non-virtualized. Calibration cannot
prove:

- that ESPN uses the identical DOM in a private league's scheduled draft;
- league/team/player identity reconciliation against the paired Laces Out league;
- pause, reconnect, source failover, commissioner rollback, or final-draft reconciliation;
- that a late join exposes every completed sale rather than only a virtualized window; or
- end-to-end upload/API/client latency, because calibration intentionally has no upload path.

For those reasons the runtime feed stays fail-closed. Before relying on it for the actual draft,
rehearse the full headless-to-browser connection with fixture data and keep manual draft entry
available. On draft day, the local calibration report can run alongside the real paired room; a
structural mismatch blocks observations instead of promoting guessed selectors.
