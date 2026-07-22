# Laces Out ESPN browser bridge

This Manifest V3 companion provides read-only sync for private ESPN Fantasy Football leagues even
though ESPN does not publish a supported third-party Fantasy OAuth API. The user signs in on ESPN's
own site. The extension makes a credentialed request from the local browser and uploads only a
bounded, checksummed league snapshot to Laces Out. The snapshot includes league settings, teams,
rosters, standings, and weekly matchups for opponent and league-wide analysis.

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
5. Choose **Sync now**. Optional background sync runs every six hours while the browser and ESPN
   session are available.

## Local development build

```bash
npm run build -w @fantasy/espn-bridge
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the
generated `apps/espn-bridge/dist` directory.

## Web-to-extension pairing

Laces Out pairs directly with the companion through Chrome's `externally_connectable` channel.

- The web app posts a `PAIRING_OFFER` message (`apiBaseUrl`, `deviceToken`, `leagues`, `season`) with
  `chrome.runtime.sendMessage(extensionId, …)`. The device token travels only inside that message —
  never in a URL, log, or the clipboard.
- The service worker validates the offer, requiring the browser-attested sender origin to exactly
  equal the normalized origin of the offered `apiBaseUrl` (a page can only pair itself). It stores the
  offer as a **pending** offer with a timestamp; it never configures the bridge or requests host
  permissions on its own, and never echoes the token back.
- Pending offers expire after 10 minutes. The popup shows a distinct **Pairing offer from &lt;origin&gt;**
  confirmation with **Complete pairing** (runs the same permission-grant + configure gesture as the
  recovery form) and **Dismiss**. The recovery form remains available for local development, but it
  is not part of normal user setup.

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
  contain one) and narrows `externally_connectable` to `https://laces.mward.io/*` only.

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
npm run build:store -w @fantasy/espn-bridge   # store: pinned to https://laces.mward.io, tightened CSP
```

Both builds write their reproducible archives to `apps/espn-bridge/dist-package/` (git-ignored);
neither is copied into the public site. The store manifest drops the
`http://localhost` / `https://*/*` optional hosts down to `https://laces.mward.io/*`, narrows the CSP
`connect-src` to the three named hosts, tightens `externally_connectable` to `https://laces.mward.io/*`
only, and removes the dev `key`, so review sees only fixed, single-purpose origins and the store
assigns the published extension ID. Both targets write to `dist/`, so re-run the dev build before
loading an unpacked dev copy.

### Store publication record

The unlisted listing is published at
`https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj`.
For future releases:

1. Upload `dist-package/laces-out-espn-bridge-store-v<version>.zip`.
2. Privacy policy URL: `https://laces.mward.io/privacy` (required — the extension handles league data).
3. Justify permissions in the listing form: `alarms`/`storage` for scheduled local sync and pairing
   state; the two `fantasy.espn.com` / `lm-api-reads.fantasy.espn.com` hosts for the read-only league
   fetch; the `laces.mward.io` optional host for uploading the bounded snapshot. State that no ESPN
   password, `SWID`, or `espn_s2` is read or transmitted.
4. Complete the data-safety form: league data only, not sold, used solely to sync the user's leagues.
5. Retain **Unlisted** visibility unless the release decision explicitly changes.
6. Provide at least one 1280×800 (or 640×400) screenshot and a 440×280 promo tile.

## Security boundary

- Fixed ESPN read hosts and fixed allowlisted views.
- Dynamically granted access only to the configured Laces Out API origin.
- HTTPS is mandatory outside loopback development.
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
