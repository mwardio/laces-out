# Laces Out ESPN browser bridge

This Manifest V3 companion provides read-only sync for private ESPN Fantasy Football leagues even
though ESPN does not publish a supported third-party Fantasy OAuth API. The user signs in on ESPN's
own site. The extension makes a credentialed request from the local browser and uploads only a
bounded, checksummed league data to Laces Out. The core snapshot includes settings, teams, rosters,
standings, and weekly matchups. Independently admitted supplemental reads add current availability,
player-level box scores, structured transactions, and draft results without allowing one drifting
ESPN view to block the rest of the refresh.

It never asks for or stores an ESPN password, copied request header, or HAR file, and it cannot set
lineups or perform transactions. The recommended setup explicitly confirms always-on access: a
user-initiated service-worker action uses Chrome's ESPN-scoped cookie API to read only `SWID` and
`espn_s2`, sends them once to the paired HTTPS Laces Out origin, and keeps the raw values out of
extension storage and logs. The server encrypts that authorization at rest and uses it only for
fixed, read-only ESPN Fantasy endpoints. A member can uncheck that choice and keep all ESPN session
material in Chrome instead.

## Install and pair

Install the unlisted [Laces Out ESPN Bridge from the Chrome Web
Store](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj).
The signed listing keeps the extension ID stable and delivers updates through Chrome.

1. Sign in to Laces Out and open **League Sync** (`/connections`). The page detects the installed
   companion automatically and continues on its own once it appears.
2. Choose **Find my ESPN leagues**. The companion lists the fantasy-football leagues on the ESPN
   account signed in to this Chrome profile — no league IDs to look up or type. (If ESPN is signed
   out, the page says so and retries after you sign in. League IDs can still be entered manually.)
3. Untick any league you don't want, then choose **Connect & keep synced**. The scoped pairing
   offer goes directly to the extension, whose popup opens itself (Chrome 127+; otherwise the
   toolbar icon shows a badge). One click on **Connect & keep synced** in the popup completes
   pairing. The recommended always-on choice is visibly preselected and can be unchecked for
   device-only sync. There is no device token to copy or paste.
4. The first sync starts immediately after that confirmation. Core league data is stored first,
   followed by independently isolated supplemental feeds. The maintenance alarm checks Laces Out
   every five minutes for requested work and retains a six-hour full sync as a safety net while
   Chrome and the ESPN session are available.

League discovery is a read-only lookup of ESPN's fan-profile endpoint (`fan.api.espn.com`) using
the existing ESPN session; only the `SWID` cookie is read (for the URL path), the result goes only
to the Laces Out page that asked, and nothing about it is stored by the extension. The
`https://fan.api.espn.com/*` host permission exists solely for this lookup.

### Always-on sync

The current companion makes always-on refresh the recommended connection path for deployments whose
operator enables it. The pairing confirmation displays the authorization behavior and requires a member
click before capture. The companion checks the ESPN football page opened by that action and, if
signed in, asks Chrome for the exact `SWID` and `espn_s2` cookies and sends only those values to the
paired Laces Out origin. This works even when ESPN marks the cookies `HttpOnly`; no page script can
read them. The values exist in extension memory only for the upload. They are never placed in
`chrome.storage`, returned to a Laces Out page, or written to a log.

The server encrypts the authorization with its deployment-owned credential key. Scheduled private
league reads can then continue while Chrome is closed, and a stale mobile view can request the same
server-side refresh. Device-only sync remains available and is used when the member unchecks the
keep-synced choice or the host disables the feature. A member can remove always-on access from
League Sync; an expired ESPN session changes to **Sign-in needed** and requires confirmation again.

### Self-hosted instances

The current signed companion supports arbitrary HTTPS deployments; a self-hoster does
not need to rebuild or publish a separate extension.

1. Create the **Connect & Keep Synced** connection from the self-hosted instance's **League Sync**
   page.
2. When the page displays its instance URL and one-time pairing code, open the companion and choose
   **Pair a self-hosted instance**.
3. Enter that URL and code. Chrome asks for access to that exact host, the code is exchanged once,
   and the resulting league-scoped device credential stays in extension storage.

Codes expire after 10 minutes, are stored server-side only as SHA-256 hashes, never appear in a URL,
and cannot be replayed after a successful exchange. HTTPS is mandatory except for `localhost` and
`127.0.0.1` development instances.

## Automated maintenance

The current companion registers as a `refresh-intents-v1` sync agent. On install, update, Chrome startup,
and every five-minute maintenance alarm it restores any missing alarm, polls the configured Laces
Out origin with the device token, and receives at most eight requests limited to its granted league
IDs and season. It reads and uploads only the requested core/supplemental artifact families. If no
intent is waiting and the last baseline is at least six hours old, it runs the existing sequential
full sweep.

Last poll, last baseline, per-league outcomes, and login/provider backoff are stored in
`chrome.storage.local`; the device token remains service-worker-only. One league failure does not
stop later leagues. Login-required is reported to Laces Out and backed off locally instead of
retrying ESPN every five minutes. A sleeping computer misses alarms, but the request remains durable
and is found after Chrome next starts. If the server predates the poll endpoint, the companion keeps
the established six-hour baseline behavior.

## Live ESPN draft sync (in development)

The companion includes a narrowly scoped content script for the ESPN football draft room. It passively
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
- After storing a valid offer, the worker nudges the member to the one remaining click: it badges
  the toolbar icon and, on Chrome 127+, opens its own popup. The nudge is cosmetic — applying the
  configuration still happens only through the explicit in-popup confirmation.
- Pending offers expire after 10 minutes. The popup shows a distinct **Pairing offer from &lt;origin&gt;**
  confirmation with **Complete pairing** and **Dismiss**.
- Before any offer, an allowlisted page may send two read-only probes. `BRIDGE_PING` reports
  presence, version, pairing state for that origin, whether an offer is pending, and the last-sync
  summary — never the token or league list. `DISCOVER_LEAGUES` reads the `SWID` cookie, fetches the
  ESPN fan profile with the existing session, and returns the account's fantasy-football leagues
  (IDs, names, team names, seasons) so the page can offer a picker instead of manual ID entry.
  Discovery stores nothing, never returns cookie values, and is deduplicated and cached for 30
  seconds in the worker.
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

The popup defaults to the hosted deployment at `https://lacesout.app`. A packaged local Docker
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
2. Privacy policy URL: `https://lacesout.app/privacy` (required — the extension handles league data).
3. Justify permissions in the listing form: `alarms`/`storage` for scheduled local sync and pairing
   state; `cookies` to read the exact ESPN `SWID` value for user-initiated league discovery and,
   with `espn_s2`, after a member explicitly enables always-on sync (including when ESPN marks
   them `HttpOnly`); the `fantasy.espn.com` / `lm-api-reads.fantasy.espn.com` hosts for the
   read-only league fetch and the draft-room content script; the `fan.api.espn.com` host solely
   for the read-only league-discovery lookup; and optional HTTPS/loopback hosts so a user may
   connect the signed companion to their own Laces Out deployment. Note: `fan.api.espn.com` is a
   new required host permission as of 0.8.0 — Chrome disables the extension for existing users
   until they approve it, so call it out in the release notes. State that optional host access is
   requested only for the exact URL entered by the user, no remote HTTP host is accepted, and a
   failed exchange removes newly granted access. No ESPN password is read or transmitted. Standard
   sync keeps ESPN session material local; the optional, user-initiated always-on feature transmits
   `SWID` and `espn_s2` only to the paired Laces Out origin, where they are encrypted at rest. The
   draft-room content script reads only already-rendered draft results.
4. Complete the data-safety form accurately: league data and, for optional always-on sync,
   authentication information are used only to provide the user's read-only sync, are not sold,
   and are sent only after an explicit user action.
5. Retain **Unlisted** visibility unless the release decision explicitly changes.
6. Provide at least one 1280×800 (or 640×400) screenshot and a 440×280 promo tile.

## Security boundary

- Fixed ESPN read hosts and fixed allowlisted views.
- Always-on capture runs only after an explicit extension or paired-page action, accepts a fresh
  ESPN football-page sender, keeps the raw values out of extension storage, and uploads only to the
  normalized paired origin with the Bridge credential. The server independently validates capture
  age/scope and immediately encrypts the authorization.
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
- “Forget on this browser” removes only the browser's local pairing. Revoking the device disables
  that browser credential. Removing **Always-on ESPN sync** from League Sync separately deletes the
  encrypted ESPN authorization.
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
