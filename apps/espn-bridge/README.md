# Laces Out ESPN browser bridge

This Manifest V3 companion provides read-only sync for private ESPN Fantasy Football leagues even
though ESPN does not publish a supported third-party Fantasy OAuth API. The user signs in on ESPN's
own site. The extension makes a credentialed request from the local browser and uploads only a
bounded, checksummed league data to Laces Out. The core snapshot includes settings, teams, rosters,
standings, and weekly matchups. Independently admitted supplemental reads add current availability,
player-level box scores, structured transactions, and draft results without allowing one drifting
ESPN view to block the rest of the refresh.

It never asks for, reads through the cookies API, uploads, or stores an ESPN password, `SWID`,
`espn_s2`, copied request header, or HAR file. It cannot set lineups or perform transactions.

## Install and pair

Install the unlisted [Laces Out ESPN Bridge from the Chrome Web
Store](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj).
The signed listing keeps the extension ID stable and delivers updates through Chrome.

1. Sign in to Laces Out and open `/connections`.
2. Choose **Automatic Sync**, enter up to 32 numeric ESPN league IDs and the season, then choose
   **Pair with Chrome companion**.
3. Laces Out sends the scoped pairing offer directly to the extension. Open the extension and choose
   **Complete pairing**. There is no device token to copy or paste.
4. Sign in at `https://fantasy.espn.com/football/` in the same Chrome profile.
5. Choose **Sync now**. Core league data is stored first, followed by independently isolated
   supplemental feeds. Optional background sync repeats the check every six hours while the browser
   and ESPN session are available.

### Self-hosted instances

Version 0.5.0 uses the same signed companion for arbitrary HTTPS deployments; a self-hoster does
not need to rebuild or publish a separate extension.

1. Create the Automatic Sync connection from the self-hosted instance's **League Sync** page.
2. When the page displays its instance URL and one-time pairing code, open the companion and choose
   **Pair a self-hosted instance**.
3. Enter that URL and code. Chrome asks for access to that exact host, the code is exchanged once,
   and the resulting league-scoped device credential stays in extension storage.

Codes expire after 10 minutes, are stored server-side only as SHA-256 hashes, never appear in a URL,
and cannot be replayed after a successful exchange. HTTPS is mandatory except for `localhost` and
`127.0.0.1` development instances.

## Live ESPN draft sync (in development)

Version 0.4.0 adds a narrowly scoped content script for the ESPN football draft room. It passively
reads the draft state ESPN has **already rendered** in the user's own tab and sends a bounded,
sanitized, checksummed observation to the service worker, which uploads it with the existing
league-scoped device credential.

What it does:

- activates only on `https://fantasy.espn.com/football/draft` with a numeric `leagueId` and a
  `seasonId`, and only when that league and season match this browser's stored pairing;
- watches with a `MutationObserver` on a short debounce, plus a full rescan every five seconds so a
  missed mutation is still recovered;
- sends a full cumulative snapshot on attach, reload, a completed pick or sale, a rollback, and
  completion; a small heartbeat about every five seconds while live; and at most two transient
  nomination/high-bid updates per second;
- keeps at most the latest snapshot plus the latest transient state, replacing a queued stale
  snapshot instead of replaying every intermediate mutation; and
- shows a small non-interactive status badge in the corner of the draft room.

What it never does:

- read or transmit an ESPN password, cookie, `SWID`, `espn_s2`, draft security token, WebSocket URL
  or frame, chat, page storage, or raw page HTML;
- intercept, proxy, decode, or hook ESPN's WebSocket, EventSource, or network stack — this is DOM
  observation plus periodic full reconciliation only;
- receive the Laces Out device token; the service worker attaches it and never echoes it back to
  the content script or the page; or
- write anything to ESPN. It cannot pick, nominate, bid, pause, or roll back.

It requires **no new permission and no new host permission**: `https://fantasy.espn.com/*` was
already declared for league reads.

### Selectors are provisional

`src/live-draft/dom-adapter.ts` is the only module aware of ESPN selectors, labels, and routes, and
its `ESPN_DRAFT_SELECTORS` table is still **provisional**. The live DOM contract has not been
validated against a real authenticated draft room, so every family is marked `verified: false` and
the adapter resolves nothing in a real room. Until then the feature is inert by design rather than
wrong.

Validation edits that one table: replace each `candidates` list with selectors observed in a real
room (most specific first, preferring `data-testid`, ids, and explicit data attributes over text),
extend `ESPN_DRAFT_LABELS` with the exact rendered strings, and set `verified: true` per family.
Nothing else—including the tests, which key off the exported table rather than hard-coded selector
strings—needs to change. The complete release gate lives in
[`docs/provider-notes/espn.md`](../../docs/provider-notes/espn.md#live-draft-release-gate).

Every extraction fails closed. A family that matches nothing, or that matches more than one node,
yields no value; a row whose identity cannot be read is counted in `completeness.unresolvedRows`
instead of being guessed, and the server holds rather than advancing the board.

The content script is compiled separately as an IIFE (`content-script.global.js`) because Manifest
V3 static content scripts are classic scripts, not ES modules. `scripts/copy-assets.mjs` asserts for
both build targets that the manifest still declares it, that it stays scoped to
`fantasy.espn.com`, and that the file was actually produced.

## Local development build

```bash
npm run build -w @fantasy/espn-bridge
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the
generated `apps/espn-bridge/dist` directory.

## Pairing architecture

The two pairing paths issue the same bounded `BridgeConfiguration`, require an explicit extension
gesture, and end at the same service-worker validation:

- **Hosted direct pairing:** the web app posts a `PAIRING_OFFER` message (`apiBaseUrl`,
  `deviceToken`, `leagues`, `season`) with
  `chrome.runtime.sendMessage(extensionId, …)`. The device token travels only inside that message —
  never in a URL, log, or the clipboard.
- The service worker validates the offer, requiring the browser-attested sender origin to exactly
  equal the normalized origin of the offered `apiBaseUrl` (a page can only pair itself). It stores the
  offer as a **pending** offer with a timestamp; it never configures the bridge or requests host
  permissions on its own, and never echoes the token back.
- Pending offers expire after 10 minutes. The popup shows a distinct **Pairing offer from &lt;origin&gt;**
  confirmation with **Complete pairing** and **Dismiss**.
- **Self-hosted pairing:** the member creates a 10-minute one-time code while authenticated to their
  instance. The extension normalizes the entered origin, rejects non-HTTPS remote hosts, asks Chrome
  for only that host, and sends the code in a redirect-free POST with credentials omitted. The server
  atomically consumes the hashed code and returns the long-lived scoped credential once. A failed
  exchange removes a newly granted host permission.

For `chrome.runtime.sendMessage` from a page to reach a specific extension, the page needs the
extension's ID:

- **Dev (unpacked) build:** the base `manifest.json` pins a public `key`, which fixes the unpacked
  extension ID to `jmbijafllioopigmpacjkdjhbjkplndh`. The web app targets this ID by default. The
  private key was used only to derive that public key and is intentionally not retained; only the
  public key matters for a stable unpacked ID.
- **Store build:** the published listing's permanent ID is `hmilkmcjlkpnigcfnlfogeafacjpmkbj`,
  baked into the web app as the primary target (store IDs never change across updates).
  `NEXT_PUBLIC_BRIDGE_EXTENSION_ID` remains an optional override in case the listing is ever
  recreated. The store manifest drops the `key` (uploads must not
  contain one) and limits externally initiated messages to `https://laces.mward.io/*` and
  `https://lacesout.app/*`. Self-hosted sites never receive external-messaging access.

The companion processes configured leagues sequentially to keep memory and network use bounded.
One league failure does not stop later leagues. The popup retains a per-league result and reports
full success, partial failure, ESPN sign-in required, or a rejected Laces Out pairing separately.
All configured leagues currently use the same season value.

The popup defaults to the hosted deployment at `https://laces.mward.io`. A packaged local Docker
deployment uses `http://localhost:3000`; a direct local development API normally uses
`http://localhost:4000`. Always confirm against the API URL shown by the Laces Out connections
screen.

Developer mode is only for local testing. Friends should use the signed, unlisted Chrome Web Store
listing so updates are authenticated and the extension ID remains stable.

## Chrome Web Store build

The build has two targets. They share identical compiled code — only the manifest differs.

```bash
npm run build -w @fantasy/espn-bridge         # dev: localhost + broad optional host, for Load unpacked
npm run build:store -w @fantasy/espn-bridge   # store: hosted direct pairing + optional self-host access
```

Both builds write their reproducible archives to `apps/espn-bridge/dist-package/` (git-ignored);
neither is copied into the public site. The store manifest keeps HTTPS and loopback hosts
**optional**: Chrome grants none at install time and prompts for the exact instance only after the
user starts self-hosted pairing. `externally_connectable` remains limited to the two hosted Laces
Out domains, and the store build removes the dev `key` so the listing assigns the published
extension ID. Both targets write to `dist/`, so re-run the dev build before loading an unpacked dev
copy.

### Store publication record

The unlisted listing is published at
`https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj`.
For future releases:

1. Upload `dist-package/laces-out-espn-bridge-store-v<version>.zip`.
2. Privacy policy URL: `https://laces.mward.io/privacy` (required — the extension handles league data).
3. Justify permissions in the listing form: `alarms`/`storage` for scheduled local sync and pairing
   state; the two `fantasy.espn.com` / `lm-api-reads.fantasy.espn.com` hosts for the read-only league
   fetch and the draft-room content script; and optional HTTPS/loopback hosts so a user may connect
   the signed companion to their own Laces Out deployment. State that optional host access is
   requested only for the exact URL entered by the user, no remote HTTP host is accepted, and a
   failed exchange removes newly granted access. No ESPN password, `SWID`, or `espn_s2` is read or
   transmitted; the draft-room content script reads only already-rendered draft results.
4. Complete the data-safety form: league data only, not sold, used solely to sync the user's leagues.
5. Retain **Unlisted** visibility unless the release decision explicitly changes.
6. Provide at least one 1280×800 (or 640×400) screenshot and a 440×280 promo tile.

## Security boundary

- Fixed ESPN read hosts and fixed allowlisted views.
- The live draft content script is restricted to the ESPN draft-room route, the top frame only, and
  a league that matches the stored pairing. The service worker independently re-validates the
  browser-attested sender (own extension, real tab, top frame, recognized draft URL), re-validates
  the observation contract, re-derives the checksum, and requires the claimed league and season to
  match both that URL and the paired device's scope — so an ESPN page mutation cannot select another
  Laces Out origin, another league, or another device token.
- Live observations carry only bounded enumerated fields: pick order, team and player identity,
  keeper flag, price, nomination state, and counts. Names are whitespace-normalized, length-capped,
  and rejected outright if they contain control or bidirectional-override characters.
- Dynamically granted access only to the configured Laces Out API origin.
- HTTPS is mandatory outside loopback development.
- Self-hosted pairing codes carry 80 bits of entropy, expire after 10 minutes, are stored only as
  hashes, are rate-limited at redemption, and are consumed atomically before a device is created.
- ESPN responses are JSON-only, redirect-free, capped at 5 MiB, minimally shape-checked, and
  SHA-256 checksummed before upload.
- Device tokens are scoped to explicit ESPN league IDs; the server stores only a token hash and can
  revoke a device independently of the user's application session.
- “Forget on this browser” removes only the browser's local pairing. Revoke the device from the
  Laces Out Connections screen to disable its server credential.
- Each device and browser configuration is limited to 32 unique 1–20 digit league IDs. Every
  response remains independently capped at 5 MiB and is discarded on validation failure.
- No remote JavaScript; all executable code ships in the extension bundle.
- The server treats extension messages and ESPN payloads as untrusted and performs its own schema,
  authorization, checksum/provenance, and normalization checks.
- Provider league, team, and matchup IDs are transmitted as decimal strings and never rounded
  through JavaScript number conversion.
- Roster, standings, and matchup history are committed together; schema drift rolls back the whole
  sync and retains the last good point-in-time state.

ESPN's web-client contract is unofficial and can change. Parser drift must fail closed, retain the
last good normalized snapshot, and surface a reconnect/import recovery action. The compatibility
mode needs a terms and store-policy review before broader distribution.

Platform references:

- <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>
- <https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3>
