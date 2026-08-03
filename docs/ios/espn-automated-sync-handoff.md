# iOS ESPN automated sync handoff

Status: backend contract complete; iOS implementation pending  
Contract date: 2026-08-03  
Mobile API version: 1

## Purpose and release boundary

Implement the iOS side of Laces Out ESPN automated refresh in the separate iOS repository. The
server, persistence model, Chrome reference agent, member web experience, and operational controls
already exist. The iOS client should consume those contracts without adding an iOS-only server
path.

The native ESPN authentication/read mechanism has a mandatory release gate. Before shipping it:

1. validate the current App Store review and ESPN policy boundary for the proposed implementation;
2. prove on a disposable league that the selected Apple web-authentication surface can make the
   fixed, origin-bound ESPN reads while keeping cookie values inside that surface; and
3. document the limitation that foreground refresh is primary and iOS background execution is best
   effort.

Do not automate ESPN credentials, enumerate or export cookies, copy `SWID` or `espn_s2` into
`URLSession`, accept pasted request headers/HAR files, or advertise guaranteed background refresh.
If the policy or technical proof fails, still ship the member-facing refresh/status UI and public
direct support, but keep the native sync-agent switch unavailable.

Provider writes remain out of scope. The app must not set lineups, add/drop players, bid, trade,
draft, or change commissioner settings.

## Server functionality already completed

The Laces Out repository implements the following:

- one durable, 24-hour refresh intent per ESPN league season, shared by all authorized members;
- server-side membership, freshness, cooldown, idempotency, expiry, rate-limit, and dispatch logic;
- independent freshness for `core`, `available-players`, `weekly-box-scores`, `transactions`, and
  `completed-draft`;
- active, near-lock, and offseason freshness policies (30/15 minutes, 15/10 minutes, and 6/1 hours
  for stale-after/minimum-refresh respectively);
- a default-off, evidence-gated anonymous direct path for already-known public league seasons;
- a shared sync-agent relay for `chrome-extension` and `ios-app` clients;
- bounded agent polling, scope checks, attempt reporting, login backoff, and device last-seen state;
- accepted/unchanged uploads through the same normalizer, checksum, stale-capture, canonical
  persistence, change-event, and downstream recomputation paths as Chrome;
- shared checksum deduplication across agents and direct work, so racing devices cannot create a
  second canonical snapshot;
- account export of the member's refresh metadata without bearer tokens or another member's device
  provenance, and cascade deletion of user-owned devices/requests/attempts;
- a five-minute Chrome reference implementation with restart recovery and a six-hour baseline;
- member web UI showing cached data immediately, refresh state, artifact freshness, direct health,
  agent availability, and required remediation; and
- operational backoff, circuits, queue retries/dead letters, rollout guidance, and kill switches.

Migration `0034_espn_automated_sync.sql` owns the database contract. The important server types are
in `packages/contracts/src/espn-refresh.ts` and the ESPN bridge section of
`packages/contracts/src/index.ts`. Cross-client checksum behavior is pinned by
`packages/connector-espn/src/payload-checksum.test.ts`.

The complete flow is:

```text
member opens league
  -> POST member refresh (session cookie)
  -> server returns cached freshness + creates/reuses one intent if stale
  -> verified public core may run server-direct
  -> otherwise an authorized device polls with its Bridge token
  -> iOS reads only requested ESPN artifacts with its device-local ESPN session
  -> iOS uploads bounded envelopes with authority=native-local
  -> server validates, normalizes, persists, deduplicates, and fulfills atomically
  -> iOS/web polls Laces Out status and refreshes cached league views
```

An iOS agent never receives an upstream URL from the server. It constructs only the fixed ESPN
origin/path/views described below from the granted numeric league ID and season.

## Authentication and session requirements

There are two separate credentials with separate storage and request rules.

### Laces Out member session

Use the iOS application's existing selected-server and cookie-authentication implementation.

- Release builds accept one normalized HTTPS deployment origin with no user info, path, query, or
  fragment. Loopback HTTP remains development-only.
- Preflight `GET /health/live` or `/health/ready`. Require `mobileApiVersion >= 1` and both
  `espn-automated-refresh` and `espn-sync-agent-v1` in `mobileCapabilities` before exposing native
  agent setup. Absence means an older server, not a failed ESPN account.
- Keep the ordinary Laces Out session cookie in the system-managed website/cookie store. Do not
  copy it into app preferences or Keychain.
- Send the exact selected deployment origin in the `Origin` header on cookie-authenticated
  mutations, including device registration, member refresh, and device revocation. Continue using
  `credentials/include` semantics for these requests.
- A `401` on a member endpoint means the Laces Out session must be renewed. It does not imply that
  the ESPN session or Bridge credential is invalid.

### Sync-device credential

Register the signed-in installation once with `POST /v1/bridge/espn/devices`. The response returns a
high-entropy `deviceToken` exactly once. PostgreSQL stores only its SHA-256 hash.

- Store `deviceToken` and `deviceId` in an access-group-private, ThisDeviceOnly Keychain item.
  Prefer `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` only if background polling is enabled;
  otherwise use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- Never place the token in `UserDefaults`, SwiftData/Core Data, an URL, analytics, crash metadata,
  notification payload, pasteboard, log, web view, or JavaScript message visible to an ESPN page.
- Send it only as `Authorization: Bridge <deviceToken>` to the selected Laces Out origin. Bridge
  calls do not use the member cookie and should omit URL-session cookies.
- Registration credentials expire after 365 days. Surface the server expiry, renew before it, and
  revoke the old device after the new credential is durably stored.
- On server switch, revoke the old device when reachable, delete its Keychain item regardless of
  network outcome, clear the prior Laces Out cookie under existing server-switch rules, and never
  reuse the token at the new origin.

### ESPN session

Keep the ESPN-authenticated session in a dedicated Apple web-data store associated with the
approved authentication/read surface. The user signs in on ESPN-controlled pages. The app must not:

- observe password fields or inject sign-in automation;
- call `WKHTTPCookieStore.getAllCookies`, serialize cookies, or bridge cookie values into native
  code;
- copy cookies into `URLSession`, Laces Out requests, logs, backups, or crash reports; or
- expose the Laces Out Bridge token to the web view or page scripts.

The technical spike must determine whether a dedicated `WKWebView`, an ephemeral/persistent
`WKWebsiteDataStore`, and an origin-executed or navigation-based read can retrieve the fixed ESPN
JSON while the web engine attaches its own cookies. `ASWebAuthenticationSession` is acceptable for
sign-in only if the resulting session can be used without extracting cookies; it does not by itself
provide response-body access. Treat this as a proved integration choice, not an assumption.

## Server endpoint contracts

All timestamps are RFC 3339/ISO 8601 strings with offsets. UUID fields are lowercase/uppercase
insensitive on input but should be stored canonically. Decode response additions forward
compatibly, but fail closed on unknown enum values that change security or artifact meaning.

All responses carry `Cache-Control: no-store` and `X-Request-Id`. Error responses use the existing
problem-details shape:

```json
{
  "type": "https://fantasy.local/problems/request-rejected",
  "title": "Request rejected",
  "status": 403,
  "detail": "bounded public detail when safe",
  "correlationId": "request-id"
}
```

Record `correlationId` for support without recording bodies or credentials.

### Capability and league discovery

`GET /health/live` and `GET /health/ready` are public. Relevant response fields:

```json
{
  "status": "ok",
  "service": "fantasy-api",
  "version": "0.1.0",
  "time": "2026-08-03T18:00:00.000Z",
  "mobileApiVersion": 1,
  "mobileCapabilities": [
    "cookie-authentication",
    "league-portfolio",
    "espn-automated-refresh",
    "espn-sync-agent-v1"
  ]
}
```

Use the existing authenticated `GET /v1/leagues` response to find non-archived items whose current
season has `provider == "espn"`. The item ID is the internal league ID; `season.id` is the
`leagueSeasonId` required by refresh routes. Do not confuse either with ESPN's numeric league ID.

### Member refresh and status

`POST /v1/leagues/{leagueSeasonId}/refresh`

- Authentication: member session cookie plus exact `Origin`.
- Body: `{}`; clients cannot send `force`, URL, headers, artifact list, or mode.
- Rate limit: 12 calls/minute per member and league path, in addition to global limits.
- Response: `200` if no live work is needed, `202` if queued/processing. Both return the same v1
  status document.

`GET /v1/leagues/{leagueSeasonId}/refresh/status`

- Authentication: member session cookie.
- Response: `200` with the same status document.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-03T18:00:00.000Z",
  "leagueSeasonId": "00000000-0000-4000-8000-000000000001",
  "provider": "espn",
  "current": false,
  "context": "active",
  "artifacts": [
    { "family": "core", "state": "fresh", "observedAt": "2026-08-03T17:50:00.000Z" },
    { "family": "available-players", "state": "stale", "observedAt": "2026-08-03T16:00:00.000Z" },
    { "family": "weekly-box-scores", "state": "missing", "observedAt": null },
    { "family": "transactions", "state": "aging", "observedAt": "2026-08-03T17:34:00.000Z" },
    { "family": "completed-draft", "state": "fresh", "observedAt": "2026-08-03T17:50:00.000Z" }
  ],
  "direct": {
    "enabled": false,
    "coreState": "disabled",
    "preferredMode": "automatic",
    "lastProbeAt": null,
    "nextProbeAt": null,
    "lastSuccessAt": null,
    "circuitOpenUntil": null
  },
  "agents": { "activeCount": 1, "mostRecentSeenAt": "2026-08-03T17:58:00.000Z" },
  "request": {
    "id": "00000000-0000-4000-8000-000000000002",
    "state": "queued",
    "fulfillmentMode": null,
    "requiredArtifacts": ["available-players", "weekly-box-scores"],
    "minimumCaptureAt": "2026-08-03T18:00:00.000Z",
    "requestedAt": "2026-08-03T18:00:00.000Z",
    "expiresAt": "2026-08-04T18:00:00.000Z",
    "finishedAt": null,
    "latestAttempt": {
      "mode": "native-agent",
      "state": "offered",
      "deviceName": "Mack's iPhone",
      "errorCode": null,
      "startedAt": "2026-08-03T18:01:00.000Z",
      "finishedAt": null
    }
  },
  "display": {
    "code": "refreshing-agent",
    "label": "Refresh offered to Mack's iPhone",
    "actionRequired": false
  }
}
```

Enums:

- context: `active`, `near-lock`, `offseason`;
- artifact state: `fresh`, `aging`, `stale`, `missing`;
- direct core state: `unknown`, `available`, `not-public`, `degraded`, `disabled`;
- preferred mode: `direct`, `assisted`, `automatic`;
- request state: `queued`, `processing`, `succeeded`, `failed`, `cancelled`;
- fulfillment/attempt mode: `server-direct`, `chrome-agent`, `native-agent`;
- display code: `up-to-date`, `refreshing-direct`, `refreshing-agent`, `queued-no-agent`,
  `login-required`, `last-good`.

Render `display.label` as the primary truth. Use `display.actionRequired` to decide whether to show a
route to setup/sign-in. Do not say “syncing” solely because a request exists. Cached league data
stays usable throughout.

### Native sync-device management

`POST /v1/bridge/espn/devices`

- Authentication: member cookie plus exact `Origin`.
- Request:

```json
{
  "name": "Mack's iPhone",
  "clientKind": "ios-app",
  "agentCapabilities": ["refresh-intents-v1"],
  "season": 2026,
  "allowedLeagueIds": ["123456789", "987654321"]
}
```

`name` is trimmed, 1–80 characters. `season` is 2000–2100. There are 1–32 unique numeric league IDs
of at most 20 digits. Always send `season`; omission exists only for compatibility with legacy
browser registrations and creates a broader all-season grant.

Response `201`:

```json
{
  "deviceId": "00000000-0000-4000-8000-000000000003",
  "clientKind": "ios-app",
  "agentCapable": true,
  "deviceToken": "lo_espn_<one-time bearer>",
  "expiresAt": "2027-08-03T18:00:00.000Z"
}
```

Fail setup unless `clientKind == "ios-app"` and `agentCapable == true`. Store the token before
dismissing setup. If storage fails, immediately revoke `deviceId` while the member session exists.
For an exact season the server immediately links each scope to a known league only when that user
already has membership. A scope for a not-yet-connected league remains unlinked until its first
locally authenticated core upload proves the existing bridge join flow; it cannot poll another
user's shared intent merely by guessing a league ID.

`GET /v1/bridge/espn/devices` returns `{ generatedAt, devices[] }`. Each device contains
`deviceId`, `clientKind`, `agentCapable`, `name`, `state` (`active|expired|revoked`),
`allowedLeagues[]` (`externalLeagueId`, nullable `season`, nullable internal `leagueId` and
`leagueName`), and created/expiry/last-seen/revoked timestamps.

`DELETE /v1/bridge/espn/devices/{deviceId}` uses the member cookie plus exact `Origin` and returns
`{ deviceId, revokedAt }`. A member can list/revoke only their own devices.

The Chrome pairing-code endpoints are not needed for a signed-in native app. Do not route the iOS
token through Chrome's pairing flow.

### Agent poll

`POST /v1/bridge/espn/refresh-requests/poll`

- Authentication: `Authorization: Bridge <deviceToken>`; no member cookie.
- Body: `{}` exactly.
- Rate limit: 24/minute/device. Normal cadence is on activation and approximately every five
  minutes while foreground-active; respect the returned cadence and local backoff.
- Response `200`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-03T18:00:00.000Z",
  "pollAfterSeconds": 300,
  "requests": [
    {
      "requestId": "00000000-0000-4000-8000-000000000002",
      "externalLeagueId": "123456789",
      "season": 2026,
      "minimumCaptureAt": "2026-08-03T18:00:00.000Z",
      "expiresAt": "2026-08-04T18:00:00.000Z",
      "requiredArtifacts": ["core", "available-players", "transactions"]
    }
  ]
}
```

The array contains at most eight unique requests and only exact device grants. Polling updates
server `lastSeenAt` even when empty. Drop any locally queued item after `expiresAt`; never widen its
scope or add artifact families. A server-side 30-minute login-required backoff suppresses the same
device/request from poll results.

### Attempt reporting

`POST /v1/bridge/espn/refresh-requests/{requestId}/attempts`

- Authentication: Bridge token; no member cookie.
- Rate limit: 60/minute/device.
- Before an ESPN read, send `{ "state": "started" }`; response is `202`.
- If no valid snapshot can be uploaded, send one terminal outcome; response is `200`:

```json
{ "state": "login-required", "errorCode": "ESPN_LOGIN_REQUIRED" }
```

Allowed request states are `started`, `login-required`, `retryable-error`, and `rejected`.
Terminal states require an `errorCode` of 1–64 trimmed characters; optional `detail` is 1–500, but
the server intentionally stores its own bounded generic detail instead of client/provider text.
Response is `{ attemptId, state, recordedAt }`.

Recommended bounded codes:

- `ESPN_LOGIN_REQUIRED` for 401/403/404 or a known ESPN sign-in document;
- `ESPN_RESPONSE_TOO_LARGE`;
- `ESPN_CONTENT_TYPE_INVALID`;
- `ESPN_JSON_INVALID`;
- `ESPN_SCHEMA_REJECTED`;
- `ESPN_TEMPORARY_FAILURE` for timeout/5xx/network loss;
- `LACES_OUT_AUTH_REJECTED` for Bridge 401/403;
- `LACES_OUT_UPLOAD_REJECTED` for non-retryable 400/409 after local validation.

Do not report `accepted` or `unchanged` through this endpoint. Successful upload admission creates
that attempt and fulfills eligible intents server-side.

### Artifact upload

Core: `POST /v1/bridge/espn/snapshots` (request body limit 6 MiB).  
Supplemental: `POST /v1/bridge/espn/supplemental` (request body limit 21 MiB; normalized artifact
limit 20 MiB). The native client should retain the Chrome agent's stricter 5 MiB per ESPN response
limit unless evidence justifies a change.

Core uploads are limited to 30/minute/device. Supplemental uploads are limited to 180 per ten
minutes/device. Both are also subject to the global API limit.

Both use the Bridge header, no member cookie, `Content-Type: application/json`, `Cache-Control:
no-store`, omitted credentials to Laces Out, and redirect refusal. A native core envelope is:

```json
{
  "schemaVersion": 1,
  "provider": "espn",
  "authority": "native-local",
  "readOnly": true,
  "leagueId": "123456789",
  "season": 2026,
  "capturedAt": "2026-08-03T18:02:00.000Z",
  "endpoint": "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456789?view=mSettings&view=mTeam&view=mRoster&view=mStandings&view=mMatchup",
  "checksumAlgorithm": "canonical-json-v1-sha256",
  "checksumSha256": "<64 lowercase hex characters>",
  "payload": {}
}
```

The endpoint origin must be exactly `https://lm-api-reads.fantasy.espn.com`. `leagueId` and
`season` must match both the grant and returned payload. `capturedAt` must be no more than 24 hours
old and no more than five minutes in the future; use the actual completed capture time, not poll
time. Core envelopes accept seasons 2000–2100. Supplemental envelopes accept 2019–2100; do not
offer native supplemental-agent setup for an older season unless the server contract is deliberately
versioned and expanded after provider evidence.

Supplemental envelopes add one of:

| Required artifact   | Wire kind                 | Extra fields                              | ESPN views/filter                                                    |
| ------------------- | ------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| `available-players` | `available-free-agents`   | `week: 0...30`                            | `kona_player_info`; `x-fantasy-filter` status `FREEAGENT`, limit 250 |
| `available-players` | `available-waivers`       | `week: 0...30`                            | `kona_player_info`; status `WAIVERS`, limit 250                      |
| `weekly-box-scores` | `weekly-box-scores`       | `week: 1...30`, `matchupPeriodId: 1...30` | `mMatchupScore`, `mScoreboard`, exact matchup-period filter          |
| `transactions`      | `structured-transactions` | `week: 0...30`                            | `mTransactions2`, fixed allowlisted transaction types                |
| `completed-draft`   | `completed-draft`         | `week: null`                              | `mDraftDetail`, no filter                                            |

Match Chrome's fixed request construction in the backend repository rather than inventing views or
accepting an URL/filter from poll data. For `available-players`, attempt both free-agent and waiver
captures. Derive the current scoring period and week-to-matchup-period mapping from the validated
core payload. Continue other requested families after one supplemental failure, then report a
retryable terminal attempt if not every requested family completed.

The server tracks the free-agent and waiver capture times separately and exposes the
`available-players` family time as the older of the two. Both component captures must therefore be
at or after the request's `minimumCaptureAt` before that family can fulfill an intent. Upload the
two envelopes independently with their real capture times; one successful half must remain useful
without being reported as a complete available-player refresh.

Upload responses use the same receipt:

```json
{
  "receiptId": "00000000-0000-4000-8000-000000000004",
  "state": "accepted",
  "receivedAt": "2026-08-03T18:02:02.000Z"
}
```

`accepted` normally returns `202`; `unchanged` returns `200`. Treat both as success. The server may
fulfill only after all required family timestamps meet `minimumCaptureAt`, so do not infer request
completion from one receipt—read refresh status.

### Portable checksum algorithm

Native agents must send `checksumAlgorithm = canonical-json-v1-sha256`. The checksum is SHA-256 over
UTF-8 bytes of Laces Out canonical JSON v1:

1. `null`, booleans, finite numbers, and strings use ECMAScript JSON spelling;
2. arrays retain order and canonicalize each element;
3. object keys sort lexicographically by UTF-16 code unit at every depth;
4. object values canonicalize recursively; and
5. whitespace is absent.

Pin the Swift implementation to this golden vector:

```text
canonical JSON:
{"10":{"a":1,"é":"snowman ☃"},"2":"numeric-looking keys are sorted as text","alpha":{"x":1,"y":2},"zebra":[true,null,"line\nfeed",0,12.5]}

SHA-256:
54cf737c0dd3548b299f364e15f7b2b7e73c30dcf24b00d841aa7fc5e34429a2
```

Do not hash the raw ESPN byte stream and do not rely on Swift dictionary iteration order. Parse the
JSON, validate it, canonicalize the same object embedded as `payload`, then hash. The server accepts
legacy insertion-order checksums only from `browser-local` authority for published Chrome
compatibility; `native-local` fails closed unless the portable algorithm is declared and matches.
After admission, the server stores the canonical checksum for every authority, so matching Chrome,
iOS, and server-direct captures share one deduplication identity even if a legacy Chrome envelope
arrived with its older insertion-order checksum. Deduplication compares the incoming checksum only
with the current canonical artifact, not all historical checksums; a real provider transition
`A → B → A` is accepted as a new current snapshot rather than mistaken for a replay.

## HTTP and error-state behavior

| Status              | Meaning and client action                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`               | Successful status/poll/unchanged upload/terminal attempt. Decode the endpoint schema.                                                                  |
| `201`               | Device registered. Persist the one-time token before continuing.                                                                                       |
| `202`               | Refresh queued, attempt started, or new artifact accepted. Continue non-blocking status flow.                                                          |
| `400`               | Contract, checksum, content, or normalization rejection. Do not retry unchanged bytes; report a bounded rejected/schema code and preserve cached data. |
| `401` member        | Laces Out session expired; run existing sign-in flow.                                                                                                  |
| `401` Bridge        | Device revoked/expired/unknown; delete Keychain token and require device re-registration.                                                              |
| `403` member        | Mutation origin rejected or membership unavailable; verify selected origin, otherwise show inaccessible league without enumeration detail.             |
| `403` Bridge        | Request/upload outside device league-season scope; do not retry or widen scope.                                                                        |
| `404` member        | League season is absent or not visible to this member. Remove stale local selection after portfolio reload.                                            |
| `404` poll endpoint | Older server during compatibility rollout. Disable agent mode and keep normal member refresh/status behavior if advertised capabilities permit it.     |
| `409` upload        | Stale/canonical conflict. Treat as non-retryable for those bytes, fetch status, and preserve the server snapshot.                                      |
| `413`               | Body too large. Never split a provider document into invented partial payloads.                                                                        |
| `429`               | Respect `Retry-After`, add jitter, and do not poll/read ESPN until eligible.                                                                           |
| `5xx/503`           | Server/queue unavailable. Exponential backoff with jitter; retain token, queued intent, cached data, and last success.                                 |

Transport failure before a response is retryable only while the intent is unexpired and the app can
prove no newer capture superseded it. Receipt/checksum idempotency makes an exact upload safe to
retry. Cap local exponential backoff at one hour, reset after a successful poll, and honor the
server's `pollAfterSeconds` floor.

## Recommended client architecture

Keep security and lifecycle boundaries visible in separate components:

- `EspnRefreshAPI`: cookie-authenticated member refresh/status and device-management calls;
- `EspnAgentAPI`: cookie-free Bridge poll, attempt, and artifact-upload calls;
- `EspnAgentCredentialStore`: Keychain-only token/device metadata, origin-bound key names, atomic
  replacement, and revocation cleanup;
- `EspnWebSession`: approved user-driven ESPN sign-in and local-session status without cookie
  extraction;
- `EspnArtifactReader`: fixed endpoint/view/filter construction, response status/content-type/byte
  bounds, identity checks, and JSON parsing;
- `EspnCanonicalJSON`: portable canonicalizer and SHA-256 golden tests;
- `EspnAgentCoordinator`: one actor/serialized state machine for poll, deduplication, per-request
  work, cancellation, background expiration, and reconnect;
- `EspnRefreshStatusStore`: observable member-facing state keyed by `leagueSeasonId`; and
- `EspnBackgroundScheduler`: best-effort `BGAppRefreshTask` registration/submission that delegates
  to the same coordinator and never promises cadence.

Use one active coordinator task per device. Coalesce lifecycle, pull-to-refresh, background, and
push-triggered work. Process requests sequentially or with a very small fixed concurrency; never run
unbounded ESPN reads. Continue later requests after a per-league failure.

## Required screens, settings, and flows

### League/locker-room refresh state

- Render cached league content immediately.
- On first authenticated hydration of an ESPN league in an app session, call the member refresh
  endpoint once. Server idempotency tolerates a duplicate, but local session coalescing avoids noise.
- Show `display.label` compactly near the league selector/freshness indicator. Do not cover content
  with a modal or full-screen spinner.
- Poll only Laces Out status at about five seconds while the current request is queued/processing.
  Stop on terminal state, view disappearance, app background, or request expiry.
- Refetch the league dashboard after status becomes current/succeeded. Preserve last-good data and
  navigate to League Sync only when `display.actionRequired` is true.
- Provide one manual **Refresh league** action using the same endpoint. Never expose force/cooldown
  bypass.

### League Sync

For every accessible ESPN season show:

- last accepted core timestamp;
- each relevant supplemental family and `fresh|aging|stale|missing` state;
- detected path (`Direct`, `Paired device`, or `Automatic`) and direct capability health;
- active device count and most-recent seen time;
- current request state, latest attempt mode/state, and own-device label when supplied;
- server `display.label` and the exact required action; and
- **Refresh league**.

Explain public viewability as optional and unofficial. It can enable operator-approved direct core
refresh, does not make a league joinable, and is not required for private device sync.

### Native agent setup

Recommended flow:

1. Capability-check the selected server and require an authenticated Laces Out session.
2. Show the unofficial/read-only/local-session disclosure and policy-dependent availability.
3. Collect a device label, one season, and 1–32 numeric ESPN league IDs. Reuse the existing URL/ID
   parser behavior where practical.
4. Establish or verify the approved device-local ESPN session. Never ask the user to type the ESPN
   password into a Laces Out-owned native form.
5. Register `clientKind=ios-app`, explicit `refresh-intents-v1`, season, and grants.
6. Atomically store token/device ID/expiry in Keychain, then list the device. For every grant whose
   `leagueId` is still null, perform one explicit foreground bootstrap core sync using the fixed
   reader and that new Bridge token. This is the authenticated connection proof that creates or
   joins the league; an unlinked scope cannot receive a poll intent yet. Continue after one league
   fails and never use public-direct data as identity proof.
7. Run one agent poll for already-linked grants and for scopes linked by the bootstrap upload.
8. Show per-league results and resolve internal league names after each accepted import.

### Settings

Add an ESPN Sync Agent section containing:

- enabled/disabled state, device name, selected server, expiration, and last successful poll/sync;
- granted season and league IDs/names;
- ESPN local-session state: signed in, needs sign-in, or unknown (never show cookie/account values);
- foreground refresh toggle only if it changes local behavior truthfully;
- best-effort background refresh toggle with explicit system-controlled wording;
- **Check now**, **Sign in to ESPN**, **Edit league access**, and **Revoke this device** actions;
- per-league last result and bounded remediation; and
- notification permission/action only when a concrete notification feature is implemented.

Editing scope should register a replacement credential, persist it, then revoke the old device.
Do not widen an existing token locally. Disabling/revoking must delete Keychain material and cancel
pending background work after the server revoke attempt.

## iOS lifecycle and background behavior

Foreground is authoritative:

- On cold start, activation, successful Laces Out sign-in, successful ESPN sign-in, and network
  reconnection, coalesce one agent poll after a short jitter.
- If an intent exists, begin a background task assertion for the bounded foreground operation, send
  `started`, read only requested artifacts, upload, then refresh server status.
- Cancel safely when the app loses execution time. Do not report a terminal error merely because
  iOS suspended the process; the durable request will be offered again.
- Persist no raw ESPN response. Keep it in memory only through validation, canonicalization, and
  upload, then release it.

Register `BGAppRefreshTask` as an optimization. Submit an earliest begin date consistent with
server cadence/backoff, but assume iOS may run it hours later or not at all. A background task may
poll Laces Out if Keychain accessibility permits. Perform an authenticated ESPN read in background
only if the approved web-session technology is actually available and policy-compliant without UI;
otherwise record no failure and defer until foreground. Complete/cancel every task before its
expiration handler deadline.

Do not use a timer, persistent socket, location mode, audio mode, or other unrelated background
entitlement. Do not claim five-minute iOS refresh; that cadence describes Chrome's foreground-capable
alarm, not iOS scheduling.

## Push and background-task opportunities

No APNs agent-wake contract is required for the first release. The durable 24-hour intent plus
foreground activation is the recovery mechanism.

A later optimization may add a content-free APNs signal after a member creates a waiting intent.
It must be coalescible, contain no league name/ID/token/provider payload, and only trigger the same
bounded poll. Silent push remains best effort and cannot make WKWebView execution available in the
background. Retain activation polling after adding push.

A user-visible notification such as “Open Laces Out to sign in to ESPN” is reasonable only after a
server/device attempt is `login-required`, the user explicitly grants notification permission, and
deduplication prevents repeated alerts. Tapping should deep-link to the ESPN Sync Agent setting, not
embed a bearer or league identifier in the URL.

## Offline, stale-data, retry, and reconnect behavior

- Keep the last Laces Out dashboard and last decoded refresh status available offline, visibly
  labeled with its `generatedAt`/accepted timestamps. Never recompute “fresh” from an old status
  without showing that the status itself is offline.
- A network-offline action queues no local force request. Retry the idempotent member POST after
  reconnect if that league remains selected and the app session has not already requested it.
- Server requests remain durable for 24 hours. An offline phone or desktop is not an ESPN outage.
- When the device returns, poll; do not create a second member intent from the agent path.
- `login-required` preserves cached data, suppresses repeated reads, and presents **Sign in to ESPN**.
  After successful local sign-in, clear local backoff and poll again; server backoff may keep the old
  request hidden for up to 30 minutes, so a manual foreground retry may use the member refresh/status
  flow without fabricating a new ID.
- On Laces Out member-session loss, pause member UI mutations and sign in again. Preserve the Bridge
  token unless a Bridge call separately returns 401.
- On Bridge loss/revocation/expiry, delete the token, mark the native agent disconnected, and keep
  member refresh/status available through the cookie session.
- On partial supplemental failure, retain successful receipts and show last-good/remaining stale
  families. Retry only the still-requested families when the server offers the intent again.
- On server/ESPN schema drift, preserve the last good data, report a bounded rejection/error code,
  and do not attempt permissive parsing or identity guesses.

## Compatibility and migration concerns

- Require advertised capabilities before enabling the native agent. Older servers continue normal
  league/dashboard behavior and may return 404 for poll routes.
- `schemaVersion` is currently `1` for refresh/poll and upload envelopes. Reject unsupported major
  versions; tolerate additive JSON keys.
- Always send `season` on device registration. Nullable all-season grants exist only for legacy
  browser devices and should be displayed as legacy scope, not created by iOS.
- Existing Chrome devices and iOS devices may race. Never assume an intent belongs exclusively to
  this phone, and stop local UI work when server status is already current/succeeded.
- The server redacts another user's device name even when that device is fulfilling shared league
  data. Do not infer ownership from `activeCount`.
- `authority=native-local` is already accepted by core and supplemental normalizers and records
  `native-agent` provenance. Do not masquerade as `browser-local`.
- Native checksums must declare `canonical-json-v1-sha256`. The legacy JSON-stringify checksum is
  browser-only.
- Device credentials currently have no refresh-token endpoint. Renew by replacement registration
  and revocation, not by extending expiry locally.
- Account deletion cascades the user's device and refresh rows. A surviving shared league may keep
  deterministic canonical snapshots for other members, without the deleted device bearer or user
  attribution.
- Preserve the selected-server isolation rules already used by the iOS app: distinct hostnames for
  cookie isolation, exact mutation origin, and complete credential cleanup on switch.

## Testing plan

### Unit tests

- Codable coverage and unknown-enum failure for every request/status/poll/attempt/receipt shape.
- Canonical JSON recursion, UTF-16 key sorting, escapes, numeric-looking keys, `-0`, finite-number
  rejection, nested arrays/objects, and the golden SHA-256 vector above.
- League ID parsing, uniqueness, 1–32 bound, 20-digit preservation as strings, and season bounds.
- Artifact-family-to-fixed-view/filter mapping, including both availability feeds and matchup-period
  mapping.
- State-machine coalescing across activation/manual/background triggers; one active sync at a time.
- Expiry, poll cadence, Retry-After, exponential jitter/backoff cap, login-required suppression, and
  partial multi-league continuation with a test clock.
- Keychain atomic replace/delete, origin-bound key names, accessibility selection, and no fallback
  to preferences.
- Status presentation for up-to-date, direct refreshing, agent offered/started, queued offline,
  login-required, partial supplemental stale, expired, and last-good.

### Integration tests

- Use `URLProtocol` or the repository's HTTP stub to verify session-cookie/member requests carry
  exact `Origin`, while Bridge requests carry only the Bridge header and no cookies.
- Capability absent/present, 200/201/202 decoding, problem details, 401 separation, 403 scope,
  404 compatibility, 409 stale, 413, 429 Retry-After, 5xx, redirect refusal, wrong content type,
  oversized body, malformed JSON, and cancellation.
- Device setup stores the one-time token before success; Keychain failure revokes; scope edit swaps
  then revokes; server switch removes the old credential.
- Poll returns no work, one request, eight requests, duplicate/unknown IDs, an expired request, and
  a request already fulfilled by another agent.
- A newly registered unlinked grant performs one foreground core bootstrap, links only after a
  valid authenticated upload, and becomes poll-eligible without granting access from the ID alone.
- Upload accepted/unchanged, exact retry deduplication, supplemental partial success, schema reject,
  and status completion only after all required families are sufficiently new.
- Web-session adapter tests prove the Laces Out token never enters the ESPN web view/message bridge
  and that no cookie enumeration API is called.
- `BGTaskScheduler` abstraction tests expiration, no execution grant, offline deferral, task
  completion, and foreground coalescing.

### End-to-end and manual release tests

Use only disposable/non-production ESPN leagues and sanitized observations:

1. stale public league refreshes server-direct with the phone showing cached then current data;
2. stale private league is fulfilled by iOS in foreground;
3. request created while all devices are offline succeeds after iOS activation;
4. ESPN session expiry produces login-required, preserves cached data, and succeeds after sign-in;
5. one phone scoped to several leagues continues after one failure;
6. iOS and Chrome race one request and yield one canonical change/recompute;
7. device revocation during poll/upload and Laces Out logout remain separate;
8. background task granted, denied, expired, and delayed all recover on foreground activation;
9. network loss during read/upload safely retries the same checksum without regression;
10. ESPN 429/5xx, malformed/oversized data, identity mismatch, and schema drift fail closed;
11. server upgrade/downgrade capability negotiation and a legacy Chrome device remain compatible;
12. account deletion/server switch removes local and server device access; and
13. logs, crash captures, analytics, backups, pasteboard, and notification payloads contain no
    password, cookie, `SWID`, `espn_s2`, Bridge token, raw provider body, or unexpected URL.

Do not make an active NFL game or live draft a release prerequisite. Live draft observation remains
a separate default-off feature and is not part of this handoff.

## Recommended implementation order and acceptance criteria

### 1. Contract and capability layer

Implement Codable models, problem details, capability negotiation, member refresh/status, Bridge
poll/attempt/receipt, and canonical JSON.

Acceptance: all golden/decoder tests pass; an older server hides agent setup; no native request needs
a backend contract change.

### 2. Credential and device management

Implement Keychain storage, registration/list/revoke, season/league scope editing, expiration, and
server-switch cleanup.

Acceptance: the token is recoverable only from Keychain, never logged or persisted elsewhere;
replacement is atomic; revocation and 401 cleanup are deterministic.

### 3. Member-facing refresh UI

Add cached-first stale-on-view, compact status polling, manual refresh, League Sync artifact/device
health, and action-required routing.

Acceptance: every server display state is truthful; cached data remains usable; no full-screen
blocking or repeated request loop occurs.

### 4. ESPN authentication/read proof

Complete the policy review and a disposable-league technical spike for the chosen Apple web
surface. Build fixed endpoint readers, byte/content/status bounds, identity validation, filters, and
in-memory payload handling.

Acceptance: a user-driven ESPN session performs core and supplemental reads without code ever
observing/exporting cookie values; failure keeps the native agent unavailable rather than weakening
the boundary.

### 5. Foreground sync-agent coordinator

Wire activation poll, started/outcome reporting, selective artifact reads, portable checksums,
uploads, multi-league continuation, status refresh, and backoff.

Acceptance: a private stale intent completes through `native-agent`; an unchanged/racing upload is
idempotent; partial artifacts remain independently stale; login-required is actionable.

### 6. Lifecycle, offline, and background optimization

Add reconnect triggers, persisted bounded status/backoff, `BGAppRefreshTask`, expiration handling,
and optional local notification UX. Keep foreground as recovery.

Acceptance: delayed/denied background execution never loses or falsely fails an intent; no busy
loop or guarantee is presented; activation always recovers.

### 7. Integration, E2E, privacy, and release gate

Run the full test matrix, disposable live validation, App Store/privacy review, accessibility,
localization, energy/network profiling, and old-server/Chrome coexistence checks.

Acceptance: all release scenarios above pass, direct remains evidence-gated, provider writes remain
absent, credentials never leave their intended stores, and product copy says iOS background refresh
is best effort.

## Definition of done

The iOS work is complete when a signed-in member can see cached ESPN data and truthful refresh
health immediately; a stale public league can complete through server-direct; a stale private league
can create one intent and be fulfilled by an authorized foreground iOS agent; an offline or
signed-out device recovers without data loss or a refresh storm; Chrome and iOS race safely; and no
ESPN credential or cookie reaches Laces Out, native logs, exports, telemetry, or backups.
