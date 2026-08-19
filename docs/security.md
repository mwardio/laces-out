# Security model

This application will hold access to real fantasy accounts. Treat it like a small financial dashboard even though the initial provider scopes are read-only.

## Threats in scope

- theft of Yahoo client credentials, access tokens, or refresh tokens;
- theft or accidental browser/log disclosure of an operator-managed Gemini/OpenRouter key or a
  member-supplied AI API key;
- theft of an authenticated local app session;
- ESPN session material escaping through logs, browser storage, crash reports, or backups;
- Yahoo OAuth authorization CSRF, code interception, replay, or open redirect;
- malicious/oversized XML or JSON provider responses;
- accidental provider writes;
- a compromised dependency or container;
- stale or partially synchronized state presented as current advice.

## Controls

- Yahoo uses its documented confidential-client Authorization Code flow. OAuth state is random,
  hashed, member-bound, expires quickly, and is consumed once. Its closed completion mode is stored
  beside that binding; a provider denial must claim the same state before a native callback is selected.
  Native completion uses only fixed, credential-free `lacesout://connections/yahoo?status=…`
  callbacks and never accepts a callback URL from a client.
- Credential envelopes use AES-256-GCM with a fresh nonce, authenticated context, explicit key version, and no key in the database.
- Refresh-token rotation is serialized per connection and committed atomically.
- Browser code receives neither provider client secrets nor refresh tokens.
- API request logs remove query strings entirely; Caddy independently replaces Yahoo callback
  `code` and `state` query values. Problem-detail instances also use query-free paths, while
  structured authorization/cookie headers, OAuth fields, ESPN cookies, codes, and known token
  patterns are redacted.
- Provider fetchers allowlist hosts, reject unexpected redirects/content types, cap decompressed size, and impose short timeouts.
- XML parsing disables external entities and entity expansion behavior.
- The current application identity is local email/password authentication: passwords use Argon2id,
  sessions are stored server-side and revocable, and production cookies are secure, HTTP-only, and
  same-site. OIDC, passkeys, and MFA are not implemented.
- The production-shaped Compose path terminates HTTPS at Caddy, which supplies HSTS and CSP; the API
  enforces mutation-origin checks and rate limits. Plain HTTP is a loopback development mode only.
- Provider writes are capability-disabled. A future write needs a preview, confirmation, idempotency, receipt, audit event, and reconciliation.
- Canonical ESPN recovery and projection imports validate bounded artifacts and persist normalized
  records/provenance rather than raw credentials or projection CSV. Any future raw-artifact
  retention must add encryption and automatic expiry before it is enabled.
- Invite capabilities contain 256 random bits, are stored only as domain-separated HMACs, expire,
  revoke, and consume once under a row lock. Shareable links keep the capability in the URL fragment
  so it is absent from web/API request targets and referrers.
- Registration is closed by default. Operators may explicitly enable open registration or use one
  environment-only, high-entropy invite code. In shared-code mode, the running
  service retains a domain-separated HMAC rather than storing the plaintext in PostgreSQL, verifies
  candidate digests with a timing-safe comparison, returns the same response for code and email
  conflicts, and allows only 30 attempts per source IP every ten minutes. This accommodates a small
  group sharing one home network while bounding password-hashing work. Disabling
  `REGISTRATION_OPEN` and blanking `REGISTRATION_INVITE_CODE` closes registration without
  disabling existing members.
- Local passwords require 12–128 characters and non-whitespace text, are hashed with Argon2id, and
  are never logged. Account creation and the initial hashed session are one database transaction.
- Portable account export is an explicit field allowlist. It excludes every stored bearer value,
  hash, encryption envelope, key fingerprint, push destination/key, and provider request hash. The
  response is authenticated, marked `no-store`, and delivered as a JSON attachment. ESPN refresh
  history is restricted to the requesting member's intent and bounded attempt metadata; it never
  reveals another member's device identity or any bearer material.
- Password change and account deletion take an account-row lock and verify the current password
  inside the same transaction as the sensitive mutation. Password change replaces the hash,
  revokes every other session, and invalidates every outstanding browser handoff, including one
  bound to the retained current session. Account deletion additionally requires the literal
  confirmation phrase `DELETE MY ACCOUNT` and resolves league ownership before the user cascade
  runs. Shared league history is anonymized or transferred; private account data and every
  credential-bearing row are deleted. Shared text/UGC is not treated as a deterministic fact:
  League Intel last authored by the account and recaps generated by it are explicitly deleted. A
  transaction-local database guard allows only the exact UUID-to-anonymous-sentinel rewrite needed
  to scrub surviving immutable ranking provenance; all other ranking snapshot mutations remain
  rejected.
- Native-to-browser authentication uses two independently random 256-bit, single-use bearers. The
  first exists only in a URL fragment and redacted staging body; the second exists only in a
  handoff-route-scoped HttpOnly cookie. Creation revalidates the exact source session token hash,
  owner, and expiry inside a transaction, then stores that session's UUID through a cascading
  foreign key. PostgreSQL stores bearer SHA-256 digests, atomically rotates then deletes them,
  bounds their total lifetime to minutes, and restricts destinations in both contracts and a
  database check. Staging returns only a masked target-account hint. The landing document never
  consumes automatically: it requires an explicit **Continue as …** action, and the server records
  that confirmation before consumption is eligible.
- Confirmed-only consumption locks the target user and still-active source session and burns the
  handoff in the same transaction. It reuses a valid same-user ambient browser session without
  replacing its cookie, burns and refuses a different user's ambient session without signing that
  user out, or creates the new ordinary session atomically when no valid ambient session exists.
  Source logout deletes the bound session and cascades the handoff; password change explicitly
  invalidates all of the account's handoffs; and account deletion cascades both sessions and
  handoffs. A strict CSP, no external landing-page resources, `Referrer-Policy: no-referrer`, and
  immediate `history.replaceState` keep the fragment bearer out of HTTP URLs, referrers, and
  browser history. The capability is disabled for split-host API/web deployments because the
  ordinary host-only session cookie would not be portable.
- The exact `/connections/yahoo/connect` destination begins the existing server-owned Yahoo flow
  only after the confirmed handoff has created or safely reused the browser member session. Yahoo's
  HTTPS callback remains on the deployment's configured API origin (including self-hosted origins),
  while only the final iOS completion uses the fixed custom scheme. Temporary provider or
  token-endpoint failures return `unavailable`; provider denial returns `denied`; other verified
  failures return `failed`; and a stored connection remains `connected` even if its first read-only
  sync fails.
- The native client accepts only a normalized HTTPS deployment origin in release builds, preflights
  a candidate before adoption, sends that exact origin on mutations, and clears the previous
  origin's cookies when switching. It rejects same-hostname/different-port transitions because the
  system cookie store cannot isolate host-only sessions by port. Browser handoff responses must
  match the selected scheme, hostname, effective port, landing path, expiry, and fragment format.
- Native third-party AI consent is request-bound rather than a durable toggle. Film Room carries the
  immutable prepared league, provider, server, and exact payload and rechecks current league/server
  and provider availability. Weekly Reckoning additionally requires the current provider, week, and
  exact Mild tone to match the prepared request, which the server rechecks before generation. A
  changed recap binding fails closed.
- Every league read and team selection is membership-scoped; private rankings, notes, credentials,
  and recommendation settings are user-owned unless explicitly shared. Yahoo and authenticated
  ESPN server-session mappings require one exact current-user team key stored on that user's own
  provider-to-league link. ESPN bridge and public snapshots remain visibly self-asserted because
  those sources do not safely identify the signed-in member. A missing or ambiguous mapping fails
  closed, and a conflict never authorizes a sync job to replace historical ownership. Only an
  authenticated ESPN server-session read may use the exact SWID-matched member's League Manager
  flag to promote that member to commissioner; co-manager flags never count, and false or missing
  provider flags never demote an existing commissioner or owner.
- Operator-managed Gemini and OpenRouter keys are read only from the API server's `GEMINI_API_KEY`
  and `OPENROUTER_API_KEY` environment values. They are never compiled into the web image, returned
  by an endpoint, or persisted in PostgreSQL. Film Room member keys are write-only through
  authenticated, same-origin endpoints and use
  purpose-bound AES-256-GCM envelopes. The API never returns a key or suffix. Request logging
  explicitly redacts `apiKey`; keyed hashes are used for credential fingerprints, stable OpenAI
  safety identifiers, and provider request IDs. Prompts and answers are not persisted.
- AI context is assembled only after league-membership checks from bounded overview, Decision Desk,
  and analytics snapshots. Synced names and fields are labeled untrusted prompt data. Models receive
  no credentials, SQL access, or provider-write capability. Start/sit is the only tool-enabled
  feature: it may invoke one fixed, server-authorized, read-only lineup tool whose member and league
  scope come from the authenticated request rather than model arguments. The model cannot add tools,
  select another member or league, or widen the returned Decision Desk section. Per-user/provider
  daily limits, route limits, 30-second egress timeouts, editable output caps, and stateless provider
  options bound cost and exposure. Managed Gemini uses a fixed server-enforced model and
  operator-controlled limits. Included Medium and Scorched recaps use the fixed
  `x-ai/grok-4.3` OpenRouter route when configured, with one independent generation per member per
  tone per UTC day. Those counters apply only to the operator key; BYOK calls retain the member's
  configured limit. Model selection is available only when a member supplies a personal key.
  Authentication rejection marks a saved key invalid without logging the key or provider response
  body. Managed credential failures return a host-configuration error without exposing provider
  details.

## ESPN-specific rule

Never request or store an ESPN password. Device-only companion sync leaves ESPN session material
inside the ESPN origin on its authorized device. If an operator enables the separate always-on mode, an active
agent-capable Chrome or iOS device may capture only `SWID` and `espn_s2` after an explicit member
action and send them once to its paired HTTPS origin. Native credential entry must remain on an
ESPN-hosted page. The client keeps the raw values in memory only; the API validates a fresh capture,
encrypts it immediately in a purpose-bound AES-256-GCM envelope, and never returns it. Logs redact
both field spellings, account export omits the envelope, and encrypted backups must be treated as
credential-bearing until their retention expires. A member can delete the envelope from League
Sync, and a 401/403 changes the connection to reauthorization required instead of retrying
indefinitely.

A device's numeric league-ID/season allowlist is only a transport boundary and grants nothing
before a successful sync. Agent tokens are random, hashed at rest, expiring, revocable, and
accepted only in the `Bridge` authorization header. Poll responses are capped at eight and contain
only request ID, granted league ID/season, minimum capture time, expiry, and fixed artifact-family
names. A revoked, expired, non-agent, cross-league, or cross-season device cannot observe or report
an intent. Native release clients must retain the existing normalized HTTPS server-origin and
mutation-origin rules; a token never belongs in a URL, log, page, content script, or ordinary app
preference.

The first accepted device snapshot may create a new league owned by that authenticated device user;
a later successfully validated provider connection automatically joins the existing shared league
as a member unless that member previously removed the exact provider season. League removal records
that exclusion, detaches the member's provider links and bridge scopes, and prevents a stale or
background sync from silently recreating membership. A fresh explicit pairing can restore it. In
contrast, a server-direct read is authorized only for one existing ESPN league
season and may never create a league, membership, team claim, provider account, invitation,
commissioner capability, or current-user identity. It constructs a fixed ESPN HTTPS endpoint from
the stored numeric ID and season, allowlists views, uses `credentials: omit`, rejects redirects,
bounds time and bytes, validates returned identity, and passes through the same normalizer and
atomic persistence boundary. An HTTP success records only `unknown/evidence-required` until an
operator explicitly approves sanitized evidence; `ESPN_PUBLIC_DIRECT_SYNC_ENABLED=false` is the
default and kill switch.

Existing roles are preserved, every joined member may request refresh of shared provider data, and
an older capture cannot replace newer canonical state. Request creation is membership-scoped,
server-bucketed, rate-limited, limited to one live intent per league season, and cannot accept a
member force flag or upstream URL. Core and supplemental freshness advance independently and a
request completes only after every required artifact is sufficiently new. Shared checksum
deduplication makes racing agents/direct work unchanged after the first accepted canonical write.
Attempts retain only bounded states, sanitized error codes/details, and timestamps.

An always-on server read resolves the provider account and league through the exact encrypted ESPN
connection, `provider_league_links`, and current membership. It may read only stored numeric league
ID/season pairs through a fixed ESPN HTTPS origin with GET, an allowlisted view/filter set, redirect
rejection, timeout, and response-size cap. It cannot accept a URL, header, league, account, or force
flag from a client; create a league or membership; claim a team; perform an ESPN write; or silently
replace device-only/public-direct mode. The worker uses the same normalization, identity
quarantine, checksum, freshness, and atomic persistence boundary as every other ESPN artifact.

Bridge artifacts may not overwrite shared canonical player fields or create a verified global
player crosswalk. Unmapped roster IDs receive non-verified, league-season-scoped observation rows.
Their supplied roster fields are available only to that league's roster, draft, and projection
workflows and are excluded from unscoped catalog/ranking resolution. A self-asserted observation
never becomes authoritative; a later trusted catalog refresh may establish a canonical crosswalk.
`espn_s2` must be treated as a bearer credential with broader risk than fantasy data alone.

Live draft observation widens what the companion reads, not what it may touch. The content script
observes a draft room the user already has open; it must never intercept, proxy, decode, or hook
ESPN's draft WebSocket or EventSource fallback, and must never transmit raw page HTML, arbitrary
text nodes, chat, page storage, draft security tokens, or transport URLs. The device credential is
held only by the extension service worker and is never exposed to the content script or the page —
so a hostile ESPN page mutation cannot redirect an upload to another origin, league, or token.
Server-side, the observation is a `.strict()`-parsed, size-bounded payload whose checksum the server
recomputes; its text fields reject control characters; and its identifiers must resolve to exactly
one internal team and player, holding rather than guessing otherwise. Provider-sourced draft events
carry `source = 'espn'` under a database check constraint so a provider fact and a manually entered
fact stay distinguishable forever, and the reconciler will not revert a manual event.
`ESPN_LIVE_DRAFT_SYNC` gates ingest entirely and is the kill switch.

`DraftRead` is a separate output-only capability for consumers of the normalized live-draft pulse.
It is accepted only as the exact, case-sensitive `Authorization: DraftRead <capability>` scheme on
`GET /v1/bridge/espn/live-draft/latest`; presenting that scheme to any other route is rejected
before a handler can run. It grants no session, bridge-device, ingest, draft-event, provider-read,
or provider-write authority, and the polling route is not exposed through browser CORS. Versioned
claims contain one literal read permission, the intended user, 1–32 exact ESPN league-season pairs,
issued/expiry times, and a 128-bit nonce. Their HMAC-SHA-256 signing key and signed-message domain
are independently derived from `SESSION_SECRET`; verification uses canonical base64url decoding,
strict bounded parsing, and a fixed-length timing-safe signature comparison. A capability lasts no
more than 12 hours and is rejected before its issue time or at its expiry.

A valid signature is identification, not durable authorization. The query must match an embedded
league-season scope, and the API checks the named member's current membership in that exact,
non-archived ESPN league before loading a pulse. It reads the membership again while assembling the
bounded response, closing a concurrent-removal race before anything is returned. The response is a
strict normalized projection and omits the source device, page session, observation identifier,
checksum, issue payload, stored observation document, and provider player identifiers. Authorization
headers are redacted from application logs. Valid capabilities receive separate nonce-scoped
960-request-per-minute buckets; malformed, forged, and expired `DraftRead` values share a
60-request-per-minute source-IP bucket so random token rotation cannot evade throttling. Bridge
readers retain their 960-request-per-minute credential buckets, preceded by a Bridge-only
1,920-request-per-minute source-IP ceiling. The earlier source guard bounds both traffic and
credential-bucket allocation when a caller rotates syntactically valid random Bridge values;
`DraftRead` traffic is not charged to that Bridge-only ceiling.

The one-shot provisioner checks current membership before minting, does not persist the capability
or its digest, writes only to a new absolute path with mode `0600`, and reports only success/failure
plus expiry. Treat that file as a bearer credential: keep it out of source control, `.env` files,
URLs, browser storage, command arguments, logs, and backups, and use a lifetime no longer than the
consumer needs. Removing a local file prevents that copy from being reused but does not revoke
copies. Expiry is the normal per-capability revocation boundary; removing the membership or
archiving the league removes access immediately. `ESPN_LIVE_DRAFT_SYNC=false` disables all live
ingest and pulse reads. Rotating `SESSION_SECRET` invalidates every outstanding `DraftRead`
capability, but it also changes other domain-separated application capabilities and must be treated
as a coordinated deployment-wide secret rotation.

The companion's external-message surface is reachable only from origins in its
`externally_connectable` allowlist (the two published Laces Out domains in the store build).
Beyond the pairing offer, it answers two read-only probes: a presence/pairing-state ping and a
league-discovery request that returns the signed-in ESPN account's fantasy-football league list
(IDs, names, team names, seasons) to the asking page. Discovery reads only the `SWID` cookie,
never returns cookie values, stores nothing, and is rate-bounded in the worker. Pairing consent is
unchanged: a stored offer may auto-open the popup and badge the icon, but only the explicit
in-popup click applies a configuration, so a compromised allowed page still cannot silently
re-point uploads at another account or origin.

## Before internet exposure

- replace every development secret;
- choose the registration posture deliberately: closed, a randomly generated out-of-band group
  code, or explicitly open. Rotate or blank a shared code after the intended group has registered;
- use unique local account passwords and the implemented Argon2id/session controls for the current
  deployment; OIDC/passkey/MFA integration is future work and must not be represented as an
  available login option;
- terminate TLS and verify secure cookie/HSTS/CSP behavior. Prioritize the planned
  passkey/MFA-capable identity-provider migration before materially broader or higher-risk exposure;
- restrict ingress, database access, and provider egress;
- enable encrypted off-host backups and complete a restore drill;
- run dependency, image, license, and secret scans;
- review sanitized fixture and log output manually;
- test disconnect/revocation and OAuth error paths;
- complete the ESPN companion terms/store-policy review and distribute a signed build before asking
  friends to install it; fail closed and retain the last good snapshot when the unofficial contract drifts.

## Reporting

Do not open a public issue containing a vulnerability, real secret, or provider payload. Use the
repository's private vulnerability-reporting channel when available. Rotate exposed application
secrets immediately, disconnect affected provider access, invalidate app sessions, and inspect
audit events.

## Known dependency advisories

Audit reviewed 2026-07-29:

- The full audit reports four moderate development-toolchain findings through esbuild, including
  Drizzle migration tooling. No development server may be exposed to untrusted networks, and these
  tools are not shipped as an internet-facing production service. Do not apply the registry's
  suggested Drizzle downgrade without migration compatibility testing; update through supported
  upstream releases instead.
- Release verification runs `npm audit --audit-level=high`; any new high or critical advisory is a
  release failure. Moderate findings remain an explicit reviewed exception, not a silent pass.
