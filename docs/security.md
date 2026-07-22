# Security model

This application will hold access to real fantasy accounts. Treat it like a small financial dashboard even though the initial provider scopes are read-only.

## Threats in scope

- theft of Yahoo client credentials, access tokens, or refresh tokens;
- theft or accidental browser/log disclosure of the operator Gemini key or a member-supplied AI
  API key;
- theft of an authenticated local app session;
- ESPN session material escaping through logs, browser storage, crash reports, or backups;
- Yahoo OAuth authorization CSRF, code interception, replay, or open redirect;
- malicious/oversized XML or JSON provider responses;
- accidental provider writes;
- a compromised dependency or container;
- stale or partially synchronized state presented as current advice.

## Controls

- Yahoo uses server-side Authorization Code + PKCE. OAuth state is random, hashed, session-bound, expires quickly, and is consumed once.
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
- Optional group registration uses one environment-only, high-entropy invite code. The running
  service retains a domain-separated HMAC rather than storing the plaintext in PostgreSQL, verifies
  candidate digests with a timing-safe comparison, returns the same response for code and email
  conflicts, and allows only 30 attempts per source IP every ten minutes. This accommodates a small
  group sharing one home network while bounding password-hashing work. Rotating or blanking
  `REGISTRATION_INVITE_CODE` closes registration without disabling existing members.
- Local passwords require 12–128 characters and non-whitespace text, are hashed with Argon2id, and
  are never logged. Account creation and the initial hashed session are one database transaction.
- Every league read and team claim is membership-scoped; private rankings, notes, credentials, and
  recommendation settings are user-owned unless explicitly shared. Yahoo claims additionally
  require the exact, unambiguous current-user team key stored on that authenticated user's own
  provider-to-league link. ESPN bridge team claims remain visibly self-asserted because those
  sources do not safely identify the signed-in manager. A claim conflict never authorizes a sync
  job to replace historical ownership.
- The managed Gemini key is read only from the API server's `GEMINI_API_KEY` environment and is
  never compiled into the web image, returned by an endpoint, or persisted in PostgreSQL. Film room
  member keys are write-only through authenticated, same-origin endpoints and use
  purpose-bound AES-256-GCM envelopes. The API never returns a key or suffix. Request logging
  explicitly redacts `apiKey`; keyed hashes are used for credential fingerprints, stable OpenAI
  safety identifiers, and provider request IDs. Prompts and answers are not persisted.
- AI context is assembled only after league-membership checks from bounded overview, Decision Desk,
  and analytics snapshots. Synced names and fields are labeled untrusted prompt data. Models receive
  no credentials, tools, SQL access, or provider-write capability. Per-user/provider daily limits,
  route limits, 30-second egress timeouts, editable output caps, and stateless provider options bound
  cost and exposure. Managed Gemini uses a fixed server-enforced model and operator-controlled
  limits; model selection is available only when a member supplies a personal key. Authentication
  rejection marks a saved key invalid without logging the key or provider response body. Managed
  credential failures return a host-configuration error without exposing provider details.

## ESPN-specific rule

Never request or store an ESPN password. Use the browser-local bridge, which leaves cookies inside the ESPN origin. A bridge device's league-ID allowlist is only a transport boundary and grants nothing before a successful sync. The first accepted snapshot may create a new league owned by that authenticated device user; a later successfully validated provider connection automatically joins the existing shared league as manager. No separate league approval is required. Existing roles are preserved, every joined member may refresh shared provider data, and an older snapshot cannot replace newer canonical state. Bridge artifacts may not overwrite shared canonical player fields or create a verified global player crosswalk. Unmapped roster IDs receive non-verified, league-season-scoped observation rows. Their supplied roster fields are available only to that league's roster, draft, and projection workflows and are excluded from unscoped catalog/ranking resolution. A self-asserted observation never becomes authoritative; a later trusted catalog refresh may establish a canonical crosswalk. `espn_s2` must be treated as a bearer credential with broader risk than fantasy data alone.

## Before internet exposure

- replace every development secret;
- use a randomly generated group registration code, distribute it out of band, and blank or rotate
  it as soon as the intended group has registered;
- use unique local account passwords and the implemented Argon2id/session controls for the current
  small invited group; OIDC/passkey/MFA integration is future work and must not be represented as an
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

This is a private project. Record discovered security issues in a private tracker without real secrets or provider payloads. Rotate exposed application secrets immediately, disconnect affected provider access, invalidate app sessions, and inspect audit events.

## Known dependency advisories

Audit reviewed 2026-07-17:

- Production audit reports two moderate findings because Next 16.2.10 carries PostCSS 8.4.31,
  below the advisory's 8.5.10 fix. The registry currently suggests an invalid downgrade rather than
  a supported patched Next release. Laces Out does not accept or stringify user-authored CSS at
  runtime; monitor the next supported Next release and upgrade promptly rather than forcing an
  untested nested override.
- Full audit reports four additional moderate dependency-chain findings through development-only
  Drizzle migration tooling and esbuild. These tools are not shipped in the production runtime and
  no development server may be exposed to untrusted networks. Do not apply the registry's suggested
  Drizzle downgrade without migration compatibility testing.
- CI runs `npm audit --audit-level=high`; any new high or critical advisory is a release failure.
  Moderate findings remain an explicit reviewed exception, not a silent pass.
