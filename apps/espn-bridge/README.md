# Laces Out ESPN browser bridge

This Manifest V3 companion provides read-only sync for private ESPN Fantasy Football leagues even
though ESPN does not publish a supported third-party Fantasy OAuth API. The user signs in on ESPN's
own site. The extension makes a credentialed request from the local browser and uploads only a
bounded, checksummed league snapshot to Laces Out. The snapshot includes league settings, teams,
rosters, standings, and weekly matchups for opponent and league-wide analysis.

It never asks for, reads through the cookies API, uploads, or stores an ESPN password, `SWID`,
`espn_s2`, copied request header, or HAR file. It cannot set lineups or perform transactions.

## Local install

```bash
npm run build -w @fantasy/espn-bridge
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the
generated `apps/espn-bridge/dist` directory.

1. Sign in to the Laces Out web app and open `/connections`.
2. Enter up to 32 numeric ESPN league IDs, separated by commas or whitespace, and create one
   bridge device credential scoped to that exact set.
3. Open the extension, grant access to the exact Laces Out API origin, and paste the one-time
   device credential, the same league ID set, and season.
4. Sign in at `https://fantasy.espn.com/football/` in the same Chrome profile.
5. Choose **Sync now**. Optional background sync runs every six hours while the browser and ESPN
   session are available.

The companion processes configured leagues sequentially to keep memory and network use bounded.
One league failure does not stop later leagues. The popup retains a per-league result and reports
full success, partial failure, ESPN sign-in required, or a rejected Laces Out pairing separately.
All configured leagues currently use the same season value.

The packaged Docker deployment uses `http://localhost:3000` by default. A direct local development
API normally uses `http://localhost:4000`; always enter the API URL shown by the Laces Out
connections screen.

Developer mode is appropriate for local testing. Sharing with friends should use a signed Chrome
Web Store package (and later Firefox build) so updates are authenticated and the extension ID is
stable.

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
