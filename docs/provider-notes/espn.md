# ESPN Fantasy Football provider

Verified: 2026-08-03

## Supported boundary

The official ESPN support and Disney developer materials reviewed for this project do not publish
a supported, general third-party ESPN Fantasy Football OAuth/API contract. ESPN support does
document league IDs, public/private league behavior, snake and salary-cap formats, and the normal
user sign-in experience. That is not an API authorization grant.

Consequently this product must not show an official “Connect ESPN” OAuth button. It implements
two read-only modes:

### 1. Browser-local private-league bridge

The primary private-league compatibility path is a Manifest V3 browser companion. The user signs
in on ESPN's own site. An extension service worker with explicit ESPN host permission makes a
credentialed read using that browser profile, bounds and checksums the response, and sends the
league artifact to a fixed Laces Out server chosen by the user.

The server issues a high-entropy device token scoped to explicit ESPN league IDs and stores only
its hash. It revalidates device state, scope, capture time, endpoint, checksum, and the versioned
ESPN shape before atomically writing roster, standings, and weekly matchup snapshots. A rejected
or partially invalid payload cannot replace the last good state. The extension never asks for an ESPN
password, requests the browser cookies API, serializes cookies, or sends ESPN session material to
Laces Out. The current companion polls Laces Out every five minutes for bounded refresh intents,
reads only requested artifact families, and retains the six-hour full sweep as a safety net while
Chrome and the ESPN session are available. A sleeping computer is simply an offline agent; the
request remains queued until an authorized device returns or the 24-hour intent expires.

Hosted Laces Out domains can hand the scoped credential directly to the signed companion through
Chrome's allowlisted external-messaging channel. Any HTTPS self-hosted instance can use that same
companion through an extension-led exchange: the authenticated app creates a 10-minute,
single-use pairing code, Chrome grants access only to the entered instance host, and the server
atomically consumes the hashed code before returning the device credential. The long-lived token
never enters a URL or the clipboard, and self-hosters do not need their own extension build.

One device can be scoped to up to 32 unique numeric league IDs for a single configured season.
The companion reads and uploads them sequentially, continues after a per-league failure, and
surfaces retained per-league results plus an aggregate full-success, partial-failure, login-required,
pairing-rejected, or failed state. The server independently authorizes every uploaded league ID;
being present in the browser configuration alone grants nothing. A first accepted snapshot may
create a new internal league owned by the device's authenticated Laces Out user. A later successful
provider connection automatically joins that shared league as manager; no separate league approval
is required. Existing roles are preserved, and every joined role may refresh shared provider
observations. Snapshots older than the current canonical observation are rejected.

This is an unofficial compatibility integration, not ESPN OAuth. Its parser must fail closed when
ESPN changes the web-client contract, keep the last good snapshot, and direct the user to reconnect.
The signed companion is available through its unlisted [Chrome Web Store
listing](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj);
broader distribution still requires a separate terms/store-policy decision.

Each accepted sync retains point-in-time standings and the schedule rows ESPN returned. Provider
league, team, and matchup IDs remain text throughout normalization and persistence, including
20-digit decimal IDs. Current-week undecided matchup scores are retained for live opponent analysis;
future placeholder scores become `null`. Replaying the same device/checksum receipt is idempotent.
When present, the same validated snapshot also retains operating rules needed to qualify advice:
waiver timing and limits, minimum bids, keeper and playoff structure, trade timing/review rules,
divisions, team waiver priority, and remaining FAAB. Optional omissions remain unknown rather than
being guessed.

Supplemental ESPN reads use independent artifact contracts, checksums, receipts, and freshness for
league-specific available players, player-level weekly box scores, structured transactions, and
completed/on-demand draft results. A supplemental request may fail without invalidating, blessing,
or rolling back a valid core league snapshot. Message-board content is out of scope.

### Automated refresh intent lifecycle

An authenticated member opening a stale ESPN league or selecting **Refresh league** creates or
reuses one 24-hour, league-season-scoped refresh intent. The server derives the required artifact
families from stored freshness; the client cannot force work or supply an ESPN URL. A verified
public core capability may dispatch a background direct read. Otherwise an authorized Chrome or
future iOS sync agent sees the request on its bounded poll. Multiple devices may race: capture-time,
stale-snapshot, shared checksum, and transactional persistence rules make one current artifact
canonical and later copies unchanged.

The relay records bounded attempt states (`offered`, `started`, `accepted`, `unchanged`,
`login-required`, `not-public`, `retryable-error`, and `rejected`) without response bodies or bearer
material. Login-required is device-local and backs that device off; it does not fail the shared
request while another authorized device could fulfill it. A core receipt fulfills an intent only
when every required artifact family has an accepted timestamp at or after the request's minimum
capture time.

Device registration declares `client_kind` (`chrome-extension` or `ios-app`) and whether the client
implements the `refresh-intents-v1` agent protocol. The API otherwise uses the same league scope,
artifact upload, normalization, checksum, and persistence boundary for both kinds. Legacy
companions continue their six-hour uploads; their absence from polling is not an outage.
The separate native implementation should follow the standalone
[iOS automated-sync handoff](../ios/espn-automated-sync-handoff.md).

### 1a. Live draft observation

Verified: implementation only. Not yet exercised against a real ESPN draft room.

A separate content script observes an ESPN draft room the user already has open and uploads a
bounded, sanitized snapshot of the board through the same league-scoped device credential. The
boundary is deliberately narrower than the core sync:

- it reads only already-rendered fantasy draft facts — completed picks, pick ownership, keepers,
  auction nominations and sale prices, and draft state;
- it never intercepts, proxies, decodes, or hooks ESPN's draft WebSocket or its EventSource
  fallback, and never touches ESPN's network stack;
- it never transmits raw page HTML, arbitrary text nodes, chat, page storage, or any ESPN session
  material, and the device credential stays in the extension service worker;
- the checksum covers durable board state only, so a re-observed unchanged board is an idempotent
  no-op and a bidding war never enters the permanent ledger; and
- every observed team and player must resolve to exactly one internal identity. An unknown or
  ambiguous identity holds that board rather than advancing it, because a wrong pick is worse than
  a briefly stale board.

Server-side reconciliation is event sourced against the existing draft engine: the candidate stream
is reduced and must satisfy every snake, roster, budget, and minimum-bid invariant before anything
is persisted. A destructive difference — a truncation or a changed action before the current end —
must be observed twice before it rewrites accepted history, because a half-rendered ESPN table is
indistinguishable from a commissioner rollback in a single frame. Manual events are never reverted
automatically.

Two limitations are load-bearing and must not be papered over:

1. **The DOM selectors are provisional.** The live DOM contract requires an authenticated ESPN
   draft room and has not been validated. Until it is, the adapter's selector table is unverified
   and the feature must stay flagged off.
2. **Late join may be bounded by virtualized rendering.** If ESPN renders only visible rows, a
   bridge that joins mid-draft may not be able to reconstruct earlier picks. Validation must either
   disprove this or the "bridge must be present from the start" limitation gets documented in the
   product UI, not hidden.

### Live draft release gate

`ESPN_LIVE_DRAFT_SYNC` remains off by default until all of the following are demonstrated against
authenticated disposable leagues. ESPN's public mock lobby is insufficient because it exposes no
paired league ID.

- A complete snake draft and salary-cap draft reproduce every pick, owner, keeper, winning bid,
  pause/resume transition, and final state.
- Reload, late join, source failover, deliberate rollback, and API/container restart preserve an
  exactly-once event ledger. Completed `mDraftDetail` results reconcile with that ledger.
- Unknown or ambiguous players and teams hold the board instead of being guessed. Schema drift,
  malformed DOM, and lost browser state preserve the last good board and expose manual backup.
- A mobile viewer receives the same accepted state; normal provider-to-app latency is at most five
  seconds at p95 and accepted-state recommendation recalculation remains below 500 ms.
- No ESPN password, cookie, `SWID`, `espn_s2`, draft token, WebSocket URL or frame, chat, page
  storage, or raw HTML reaches Laces Out.

Only after this matrix passes may the selectors be marked verified, the flag be enabled for a
canary league, and product copy advertise live ESPN draft sync. Turning the flag off is the
rollback: it stops new provider observations while preserving accepted events and manual entry.

### 2. Anonymous public-league read

`EspnPublicReadClient` calls the web client's `lm-api-reads.fantasy.espn.com` endpoint only for the
numeric league ID and season of an already-admitted ESPN league. This endpoint is **unofficial and
undocumented for third-party use**. The worker integration exists, but
`ESPN_PUBLIC_DIRECT_SYNC_ENABLED` defaults to `false` and an HTTP success never promotes a league
to direct availability. An operator must accept the policy boundary and record sanitized evidence
for the exact artifact family before explicitly promoting that league's capability. The request
boundary:

- has no password, cookie, `SWID`, `espn_s2`, Authorization header, or arbitrary-header parameter;
- sets fetch credentials to `omit` and refuses redirects, preventing an implicit signed-in browser
  session from crossing the boundary;
- permits only a small allowlist of read views;
- applies a timeout and 5 MiB response limit;
- treats returned JSON as an untrusted, checksummed artifact rather than a stable normalized
  contract;
- returns `NOT_PUBLIC` for 401, 403, or 404 without treating a private league as degraded;
- cannot create a league, membership, provider account, team claim, or player identity; and
- verifies the returned ESPN league ID and season before the ordinary normalizer and atomic
  persistence boundary can accept it.

The initial evidence gate supports core only. Supplemental capability fields remain independently
unverified and assisted-only until each has its own sanitized evidence. A successful unknown probe
records that evidence is required; it does not silently make the HTTP path available. Repeated
failures use league-level backoff and a circuit breaker, and a previously verified public league
that becomes private moves to `not-public` while preserving the last good snapshot.

An LM can use ESPN's documented setting to make a private league public if appropriate. Public
visibility is a user/commissioner choice and must not be changed or worked around by this app.

## Explicit exclusions

- Never ask for or store an ESPN password.
- Never automate the ESPN sign-in form.
- Never accept or replay `SWID`, `espn_s2`, browser cookies, copied request headers, or a HAR file
  in the hosted application. The companion may let the browser attach its local ESPN cookies to a
  direct ESPN request, but it never reads or transmits their values.
- Never perform lineup, waiver, transaction, trade, commissioner, or draft writes.
- Never advertise live ESPN draft sync until the release gate above has passed. The implementation
  exists behind `ESPN_LIVE_DRAFT_SYNC` (default off) and its DOM adapter is unvalidated. Manual
  draft event entry remains primary; completed/on-demand provider draft results reconcile against
  it without silently rewriting manual history.
- Do not silently fall back from anonymous reads to browser session credentials.

Disney's terms restrict automated access, monitoring, and copying using robots, spiders, scrapers,
or other automated means. The anonymous public-read experiment therefore remains feature-flagged
and personal-use only until a terms review accepts it. The browser bridge does not depend on that
anonymous endpoint and is the private-league path.

## Setup checklist

1. Obtain each numeric league ID using ESPN's normal web/app UI.
2. For automatic private-league sync, install the signed companion from the [Chrome Web Store
   listing](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj),
   and create a league-scoped pairing from Laces Out's `/connections` page. Hosted deployments hand
   it directly to the extension; a self-hosted deployment displays a one-time code for **Pair a
   self-hosted instance** in the popup. Neither path copies the device token. Sync while signed in
   to ESPN in the same browser profile, then claim the correct fantasy team after each league's
   first import.
3. If using public direct read, confirm the league is intentionally public, complete the operator
   evidence/policy gate in [operations](../operations.md#espn-automated-refresh), and only then set
   `ESPN_PUBLIC_DIRECT_SYNC_ENABLED=true`. No ESPN secret environment variables should exist.
4. Keep the last successful normalized snapshot if a later bridge read fails.
5. Re-run sanitized web-client fixture tests whenever the bridge schema changes.
6. Run the ESPN bridge and schema smokes against disposable PostgreSQL. They exercise first-owner creation, no-op league-ID
   configuration, provider-connection auto-enrollment, member refresh, stale-snapshot rejection,
   checksum replay, player-observation quarantine, canonical-player preservation, normalization,
   and rollback.

## Primary references

- [ESPN Fan Support: League ID](https://support.espn.com/hc/en-us/articles/4408412998804-League-ID)
- [ESPN Fan Support: making a private league public](https://support.espn.com/hc/en-us/articles/47160849553940-Making-a-Private-League-Public-LM-Only)
- [ESPN Fan Support: league types](https://support.espn.com/hc/en-us/articles/360000977272-League-Types-in-ESPN-Fantasy)
- [ESPN Fan Support: public leagues and snake/salary-cap drafts](https://support.espn.com/hc/en-us/articles/115003850011-Join-a-Public-League)
- [Disney Terms of Use](https://disneytermsofuse.com/)

The unofficial host is implementation evidence, not a primary or supported ESPN API reference.
