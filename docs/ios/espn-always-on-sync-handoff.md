# iOS ESPN sign-in and always-on sync handoff

Status: server contract complete; native implementation merged in the separate iOS repository;
end-to-end release verification remains
Contract date: 2026-08-05
Mobile API version: 1
Target repository: `mwardio/laces-out-ios`

## Outcome

Add an extension-free ESPN connection flow to the native app. The member signs in on an
ESPN-hosted page inside a tightly scoped `WKWebView`; Laces Out never renders, receives, or stores
the ESPN username or password. After ESPN establishes its web session, the app captures only the
`SWID` and `espn_s2` session values, sends them once through an authenticated and league-scoped
iOS Bridge device, and discards its local copy. The server encrypts the authorization at rest and
becomes responsible for scheduled and stale-on-view refreshes.

The native app should present this as the normal ESPN setup path. Do not make **always-on** a second
opt-in after sign-in. The consent screen immediately before ESPN sign-in must clearly say that Laces
Out will store revocable, encrypted ESPN session authorization for read-only fantasy sync.

Web users keep the Chrome companion path. Live ESPN draft observation still requires an open ESPN
draft room in the Chrome companion; this native work covers league discovery, initial import, and
ordinary in-season data refresh, not the live draft feed.

## Why this shape

ESPN does not offer a third-party Fantasy OAuth flow. A Laces Out-owned username/password form would
put ESPN credentials inside the app and may still fail when Disney requires reCAPTCHA. The approved
shape keeps credential entry entirely on ESPN/Disney pages and transfers only the established
read-only fantasy session after an explicit member action.

The production flow supersedes the cookie-opaque experiment in
[`espn-automated-sync-handoff.md`](espn-automated-sync-handoff.md). Keep that document only as a
reference for existing refresh, artifact, checksum, and Bridge upload contracts. Do not carry its
blanket prohibition on session capture into this implementation; the narrower rules in this
document govern the one-time native exchange.

## Server prerequisites and feature gates

The selected deployment must:

- run migration `0036_espn_server_session.sql`;
- set `ESPN_SERVER_SESSION_SYNC_ENABLED=true` in API and worker;
- provide `CREDENTIAL_ENCRYPTION_KEY`;
- advertise `espn-automated-refresh` and `espn-sync-agent-v1`; and
- advertise both `espn-native-session-grant-v1` and `espn-server-session-v1` in
  `/health/ready.mobileCapabilities`.

Use `espn-native-session-grant-v1` to show the native sign-in action. Use
`espn-server-session-v1` to decode and manage the stored connection. Older deployments must retain
the current browser handoff without exposing a native setup button.

## Existing server contract

### 1. Register a scoped iOS device

Member-authenticated request:

`POST /v1/bridge/espn/devices`

```json
{
  "name": "Mack's iPhone",
  "clientKind": "ios-app",
  "agentCapabilities": ["refresh-intents-v1"],
  "season": 2026,
  "allowedLeagueIds": ["123456789", "987654321"]
}
```

The response includes a one-time `deviceToken`. Validate `clientKind == "ios-app"`,
`agentCapable == true`, a UUID `deviceId`, a 32–512 character token, and a future `expiresAt`.
Store the Bridge device token only in the existing origin- and user-bound Keychain store. If
Keychain storage fails, revoke the newly created device immediately.

Registration requires at least one and at most 32 unique numeric league IDs plus an exact season.
League IDs remain strings everywhere.

### 2. Grant the ESPN session

Bridge-authenticated request:

`POST /v1/bridge/espn/session-grants`

Headers:

```text
Authorization: Bridge <deviceToken>
Accept: application/json
Content-Type: application/json
Cache-Control: no-store
```

Body:

```json
{
  "swid": "{123e4567-e89b-42d3-a456-426614174000}",
  "espnS2": "<fresh ESPN session value>",
  "capturedAt": "2026-08-05T18:00:00.000Z"
}
```

The capture must reach the server within ten minutes. The endpoint accepts only an active,
unexpired, agent-capable ESPN device whose `clientKind` is `ios-app` or `chrome-extension`.

Success is `201`:

```json
{
  "connectionId": "00000000-0000-4000-8000-000000000000",
  "state": "healthy",
  "linkedLeagueCount": 0
}
```

`linkedLeagueCount == 0` is valid for a first import. Once the initial native core snapshot is
accepted, canonical persistence links that season to the encrypted connection automatically.

Add this method to `EspnAgentAPIProtocol` and `EspnAgentAPI`, not the member-cookie API:

```swift
func grantServerSession(_ request: EspnSessionGrantRequest) async throws
    -> EspnSessionGrantResponse
```

It uses the existing fixed Laces Out origin, `Bridge` authorization, redirect refusal, omitted
cookies, response-size bound, and problem-details handling.

### 3. Bootstrap each selected league

Immediately after the grant, perform one foreground core-plus-supplemental read for every selected
league using the in-memory ESPN session and the existing fixed request builder. Upload artifacts
through the existing iOS Bridge endpoints with:

- `authority: "native-local"`;
- canonical JSON v1 SHA-256 checksums;
- the registered league ID and exact season; and
- the current core, availability, weekly box score, transaction, and completed-draft contracts.

This is the same bounded bootstrap already orchestrated by `EspnAgentDeviceManager`; provide it a
temporary session-backed `EspnArtifactReading` implementation instead of the release-gated reader.
Do not enable native background polling. After bootstrap, the server session owns ordinary refresh
cadence.

If every selected league fails to bootstrap, remove the new server connection, revoke the device,
delete its Keychain token, clear the web data store, and show the provider-safe error. If only some
leagues fail, keep successful links and offer a retry for the failed scopes.

### 4. List and remove stored authorization

Member-authenticated list:

`GET /v1/connections/espn/sessions`

```json
{
  "available": true,
  "connections": [
    {
      "connectionId": "00000000-0000-4000-8000-000000000000",
      "displayName": "ESPN Fantasy",
      "health": "healthy",
      "lastSuccessfulAt": "2026-08-05T18:05:00.000Z",
      "lastErrorCode": null,
      "lastErrorAt": null,
      "leagues": [
        {
          "leagueId": "00000000-0000-4000-8000-000000000001",
          "leagueSeasonId": "00000000-0000-4000-8000-000000000002",
          "name": "The Android Dungeon",
          "externalKey": "123456789",
          "season": 2026,
          "lastSyncedAt": "2026-08-05T18:05:00.000Z"
        }
      ]
    }
  ]
}
```

Contract limits:

- at most 8 connections and 32 leagues per connection;
- health is `pending`, `healthy`, `degraded`, `reauthorize`, or `disabled`;
- timestamps are ISO 8601 or `null`; and
- ESPN external keys remain strings, never `Double` or `Int`.

Member-authenticated removal:

`DELETE /v1/connections/espn/sessions/{connectionId}`

Success is `204`. It deletes encrypted authorization and provider links but retains last-known
synced league data. Also revoke the related iOS Bridge device and delete its local token when the
member disconnects from this phone.

### 5. Refresh compatibility

Continue using the existing member endpoint:

`POST /v1/leagues/{leagueSeasonId}/refresh`

An always-on response can contain:

```json
{
  "request": {
    "fulfillmentMode": "server-session",
    "latestAttempt": { "mode": "server-session" }
  }
}
```

Add the missing enum case immediately:

```swift
enum EspnAttemptMode: String, Codable, Sendable {
    case serverDirect = "server-direct"
    case serverSession = "server-session"
    case chromeAgent = "chrome-agent"
    case nativeAgent = "native-agent"
}
```

Label it **Always-on**. Without this case, an otherwise valid refresh document can fail decoding.

## ESPN-hosted sign-in flow

### Web view boundary

Create a dedicated `WKWebView` with `WKWebsiteDataStore.nonPersistent()` and begin at
`https://www.espn.com/login`. Reuse the strict navigation policy already developed in
`EspnOpaqueWebProofPolicy`:

- HTTPS only;
- no URL credentials or non-default ports;
- exact ESPN/Disney authentication hosts and their approved subdomains only;
- upgrade only the narrowly allowed ESPN HTTP redirects; and
- open no arbitrary external URL in the same web view.

The app must not inject credentials, observe form fields, receive JavaScript messages containing
credentials, or offer an ESPN username/password native form. ESPN/Disney own every credential and
challenge screen.

### League scope discovery

After sign-in, open `https://fantasy.espn.com/football/` in the same web view.

Prefer scopes already known in the member's Laces Out portfolio. For new leagues, collect only
numeric `leagueId` and bounded `seasonId` values from ESPN football navigation URLs:

1. inspect main-frame navigations with the existing `EspnOpaqueWebProofPolicy.scope(from:)` parser;
2. optionally run a narrow script that returns only ESPN anchor `href` strings, then parse those
   URLs natively with the same allowlist and scope parser; and
3. if ESPN's current page no longer exposes league links, let the member open each league in the
   web view and add that exact scope.

Never scrape team names, messages, password fields, page storage, or arbitrary DOM content during
discovery. Show the discovered leagues and require the member to confirm which ones to connect.

### Session capture

Only after the member confirms scopes, call
`webView.configuration.websiteDataStore.httpCookieStore.getAllCookies`. Immediately filter to:

- cookie name exactly `SWID` or `espn_s2`;
- a normalized domain equal to `espn.com` or ending in `.espn.com`;
- a valid `SWID` matching the server's braced UUID contract; and
- an `espn_s2` between 32 and 4096 characters with no whitespace, semicolon, control character, or
  DEL.

URL-decode a cookie value once if WebKit supplies an encoded representation. Reject duplicates,
missing values, unexpected domains, or an invalid shape. Keep the two strings in a short-lived,
internal, non-`Codable` value used only by the grant and bootstrap readers.

After successful bootstrap—or any cancellation/failure—stop navigation, load `about:blank`, remove
all records from the nonpersistent data store, release the web view, and drop every in-memory
reference. Swift strings cannot promise physical zeroization, so the practical boundary is narrow
lifetime, no persistence, no copying beyond the two required calls, and no logging.

## iOS implementation map

### `LacesOut/Models/EspnRefreshModels.swift`

- Add `EspnAttemptMode.serverSession`.
- Add strict `EspnSessionGrantRequest`, `EspnSessionGrantResponse`,
  `EspnSessionConnectionList`, `EspnSessionConnection`, and `EspnSessionLeague` models.
- Validate UUIDs, timestamps, health values, bounds, seasons, and numeric external-key strings.
- Keep the sensitive grant request internal to the ESPN setup module. Do not make it printable,
  persistable, sample data, or app-wide observable state.

### `LacesOut/Core/EspnAgentAPI.swift`

- Add the Bridge-authenticated session-grant call.
- Keep `credentials` omitted, redirects refused, `Cache-Control: no-store`, and the fixed selected
  deployment origin.
- Never include session fields in problem text or debug contract-mismatch output.

### `LacesOut/Core/EspnRefreshAPI.swift`

Add member-authenticated list and delete operations:

```swift
func sessionConnections() async throws -> EspnSessionConnectionList
func removeSessionConnection(connectionID: String) async throws
```

Reuse the existing member cookie, exact mutation `Origin`, authenticated retry, response bounds, and
deployment isolation. Add an empty-response transport helper for `204`; do not weaken JSON checks on
ordinary requests.

### ESPN login coordinator

Create a foreground-only coordinator responsible for this sequence:

1. validate server capabilities;
2. present the ESPN-hosted sign-in web view;
3. collect and confirm league scopes;
4. capture the two ESPN session values;
5. register or replace the scoped iOS Bridge device;
6. persist the Bridge token in the existing Keychain store;
7. grant the server session through `EspnAgentAPI`;
8. bootstrap selected leagues with a temporary session-backed artifact reader;
9. confirm links through `GET /v1/connections/espn/sessions`; and
10. clear all ESPN web and in-memory authorization state.

Coalesce duplicate taps and support cancellation at every awaited boundary. Keep connection status
outside this coordinator in a small account- and deployment-scoped store modeled after
`YahooSyncStatusStore`.

### Session-backed artifact reader

Implement `EspnArtifactReading` for setup only:

- ephemeral `URLSession` with no persistent cookie store or cache;
- fixed `EspnArtifactRequestBuilder` URLs and filters only;
- explicit `Cookie` header containing only `SWID` and `espn_s2` to ESPN's fixed read origin;
- GET only, no redirects, no URL credentials, and no server-supplied upstream URL;
- existing five-megabyte response bound, content-type/status checks, identity validation, and
  canonical JSON parsing; and
- provider-safe error mapping without response bodies.

Do not write the cookie header, request, response body, or capture value to logs. Destroy the reader
after initial bootstrap. Leave `EspnNativeAgentReleaseGate.backgroundPollingIsEnabled` false.

### `LacesOut/App/AppModel.swift`

Add:

```swift
var supportsEspnNativeSessionGrant: Bool {
    supportsEspnAutomatedRefresh
        && supportsEspnSyncAgent
        && mobileCapabilities.contains("espn-native-session-grant-v1")
        && mobileCapabilities.contains("espn-server-session-v1")
}
```

Reset new connection state on logout, account switch, and deployment switch. Continue using the
existing stale-on-view refresh behavior after setup.

### `LacesOut/Features/Settings/LeagueSyncView.swift`

When the native capability is present, make **Sign in with ESPN** the primary ESPN action. Explain
in one sentence that sign-in happens on ESPN and Laces Out stores encrypted, revocable access for
read-only sync. The confirmation action should read **Continue to ESPN**.

Connection states:

| State         | Primary copy                    | Action                        |
| ------------- | ------------------------------- | ----------------------------- |
| None          | `Connect ESPN`                  | `Sign in with ESPN`           |
| `pending`     | `Finishing the first ESPN sync` | Retry failed scopes if needed |
| `healthy`     | `ESPN sync is on`               | Disconnect                    |
| `degraded`    | `ESPN sync needs attention`     | Refresh or reconnect          |
| `reauthorize` | `Sign in to ESPN again`         | Repeat native hosted login    |
| `disabled`    | Treat as disconnected           | Sign in with ESPN             |

Show linked leagues and latest success. Keep connection IDs and provider error codes in an advanced
disclosure only. When the native capability is absent, retain the authenticated web/Chrome fallback.

## Security and privacy requirements

- Never ask for, receive, submit, log, or store an ESPN username or password.
- Never persist `SWID`, `espn_s2`, a `Cookie` header, or the ESPN web data store in Keychain,
  UserDefaults, files, Core Data, analytics, crash metadata, fixtures, screenshots, or pasteboard.
- Never send ESPN session values through a member-cookie endpoint. The only Laces Out egress is the
  fixed Bridge-authenticated session-grant endpoint.
- Never send the Laces Out member cookie or Bridge token into the ESPN web view.
- Never put the Bridge token in a URL, ordinary app preference, log, or ESPN request.
- Do not allow arbitrary navigation, redirects, upstream URLs, artifact views, filters, seasons, or
  league IDs.
- Preserve exact selected-server origin isolation and clear all connection/setup state on account or
  deployment change.
- Require confirmation before disconnecting and explain that last-known league data remains.
- Update App Store privacy disclosures to describe user-authorized fantasy account data and the
  transient transfer of account session authorization to the selected self-hosted server.
- ESPN integration remains unofficial and read-only. No lineup, waiver, trade, draft, or league
  setting write is in scope.

## Failure and recovery behavior

- Missing/invalid ESPN cookies: keep the web view open and ask the member to finish ESPN sign-in.
- ESPN challenge or MFA: let ESPN render and complete it; never intercept values.
- Device registration failure: preserve the ESPN web session only while retrying in the same setup
  sheet.
- Keychain failure: revoke the device and stop before session grant.
- Grant `401`: discard the device token, revoke if possible, and restart registration.
- Grant `400`: treat the capture as invalid/stale and repeat ESPN sign-in/capture.
- Grant `404/503`: native setup is unavailable on this deployment; show the Chrome fallback.
- Bootstrap schema drift: retain no newly unlinked connection when every league fails; preserve
  existing last-good data for a reconnect.
- Stored connection `reauthorize`: repeat hosted login and grant against a fresh or still-active
  scoped device.
- Offline/API failures after a successful list: retain last-good connection status and mark it stale.

## Required tests

1. Refresh decoding with `fulfillmentMode` and `latestAttempt.mode` equal to `server-session`.
2. Capability matrix for absent, server-session-only, native-grant-only, and fully supported servers.
3. Navigation allowlist and rejection of HTTP, credentials, ports, lookalike hosts, popups, and
   external redirects.
4. League URL discovery with 1–20 digit IDs, multiple seasons, duplicates, malformed queries, and
   non-ESPN links.
5. Cookie filtering with missing, duplicate, encoded, wrong-domain, malformed, oversized, and valid
   values; assertions that no unfiltered cookie escapes the extractor.
6. Exact Bridge grant path/header/body, redirect refusal, no member cookie, bounds, and handling for
   `201`, `400`, `401`, `404`, `409`, `429`, and `503`.
7. Session reader fixed-origin requests, only-two-cookie header, response limits, identity checks,
   supplemental filters, redirect refusal, and no logging.
8. Setup ordering, cancellation, Keychain compensation, all-failed rollback, partial bootstrap, and
   successful automatic provider linking.
9. Strict list/delete decoding and account/deployment-scoped last-good state.
10. UI states for connect, pending, healthy, degraded, reauthorize, fallback, and disconnect.
11. A regression scan proving ESPN session fields never enter persistence, logs, analytics, exports,
    fixtures, or screenshots.
12. Existing Yahoo, Chrome companion, demo, and live-draft behavior remains unchanged.

## Acceptance checklist

- A new member can connect a private ESPN league from iPhone without Chrome or a pasted token.
- ESPN/Disney, not Laces Out, receives the username, password, MFA, and reCAPTCHA interactions.
- The member confirms exact league scopes before the session grant.
- First bootstrap creates or joins the expected canonical league and links the encrypted connection.
- Closing the app and every browser still allows a later server-side refresh.
- The iOS app retains only the scoped Bridge device token, never the ESPN session.
- Reauthorization repeats the same hosted flow without duplicating leagues.
- Disconnect removes encrypted authorization while preserving last-known league data.
- `server-session` refresh responses decode and display **Always-on**.
- Live draft copy remains truthful about requiring the Chrome draft-room observer.
- No provider write capability exists anywhere in the diff.

## Recommended implementation order

1. Add `EspnAttemptMode.serverSession` and its decoder regression test.
2. Add capability checks plus connection list/delete models and APIs.
3. Add the Bridge session-grant models and `EspnAgentAPI` method.
4. Extract the existing debug web proof's navigation policy into release code.
5. Build hosted sign-in, scope discovery, and the narrowly filtered session extractor.
6. Implement the temporary session-backed artifact reader.
7. Refactor `EspnAgentDeviceManager` into the setup ordering above and keep background polling off.
8. Add the League Sync UI and reauthorization/disconnect flows.
9. Run the full iOS suite, then verify one new private league and one already-linked league against a
   disposable self-hosted server before enabling the production UI.
