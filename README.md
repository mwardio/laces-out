# Laces Out

An invite-only, self-hosted fantasy football decision system for friends using Yahoo and ESPN leagues. It provides user-specific and league-specific draft, lineup, waiver, trade, opponent, and league-wide analysis—not generic rankings with a chat layer.

The product is under active development. The current repository contains DB-backed invite and membership boundaries; official Yahoo OAuth, discovery, and read-only league sync; an implemented, fixture- and smoke-tested multi-league ESPN browser companion plus authenticated canonical-JSON recovery; immutable nflverse identity, schedule, weekly player-stat, team-stat, weekly-roster, injury-report, and snap-count ingestion; daily Fantasy Football Calculator ADP, hourly active-season/status checks, and hourly attributed Sleeper waiver-market signals; a locked-backtest, league-scored Laces Out weekly forecast; a sourced Stats Center; custom rankings, board comparison, and projection imports; persistent snake and auction draft rooms with contextual recommendations and local Practice Room simulation; projection-backed lineup, waiver, and trade analysis; league analytics and opponent scouting; an implemented Film room with managed Gemini plus encrypted OpenAI, Anthropic, Gemini, and OpenRouter BYOK; and a responsive interface. The signed, unlisted Chrome Web Store companion is published; sanctioned 2026 private-league testing and terms review remain release gates. The rest-of-season distribution engine and its hourly audit rail are implemented in shadow mode, but calibrated ROS projections are not published or consumed yet. The  and  track the remaining work. Demo data is always labeled; no screen should imply that a provider account is connected when it is not.

evidence, current ROS blockers, and constraints for the next model iteration.

## Important provider status

- **Yahoo:** official read-only Fantasy Sports authorization and sync are implemented. Yahoo connection is presented as **Coming Soon** until it is enabled for this deployment.
- **ESPN:** no current public Fantasy OAuth/API offering was found, so private leagues use a scoped one-click sync bookmark or the optional read-only [Chrome Web Store companion](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj). Pairing is handed directly from Laces Out to the extension without copying a device token. Users sign in on ESPN itself; ESPN passwords and cookies stay in the browser.
- **Writes:** lineup changes, waiver claims, and trades are disabled. The app recommends and deep-links; every action must be verified and completed at the league provider.

See `docs/provider-notes/` for evidence and constraints.

The public landing page is served at `/`, the signed-in locker room at `/app`, and the public privacy
and terms notices at `/privacy` and `/terms`. Set `NEXT_PUBLIC_SITE_URL` and
`NEXT_PUBLIC_CONTACT_EMAIL` before an internet deployment. The operator-facing privacy source is
[docs/privacy.md](./docs/privacy.md); review it whenever processing or retention changes.

## Architecture

```text
apps/web       Next.js responsive PWA
apps/api       Fastify REST API, provider ingestion, and job-enqueue boundary
apps/worker    pg-boss runtime; shared NFL inputs, weekly forecasts, ADP/status/market jobs
apps/espn-bridge  private ESPN league browser-sync companion

packages/domain             provider-neutral entities and rules
packages/connectors         provider capability and sync ports
packages/connector-yahoo    supported Yahoo OAuth/API adapter
packages/connector-espn     import/public ESPN adapter boundary
packages/db                 Drizzle schema and SQL migrations
packages/projections        scoring normalization, source blending, weekly model, and uncertainty
packages/engine-*           draft, lineup, waiver, trade engines
packages/security           credential envelopes and redaction
packages/source-ffc         contextual redraft ADP
packages/source-nflverse    canonical identity, schedules, player/team weekly stats, and snaps
packages/source-sleeper     player/status/trend sources and read-only league adapter
```

PostgreSQL is the only required stateful service. Provider packages normalize external data; recommendation packages never import provider code.
The web UI uses hand-authored cascade-layered global CSS, custom-property design tokens, and scoped
CSS Modules for feature workbenches; it does not use Tailwind.

## Requirements

- Node.js 22.22 or newer (below Node 25)
- npm 9 or newer
- Docker with Compose for local PostgreSQL, or an existing PostgreSQL 17+ database

## Local bootstrap

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate -w @fantasy/db
npm run owner:create -w @fantasy/api
npm run dev
```

The one-shot owner command is a development/bootstrap path. It reads `OWNER_EMAIL`, optional `OWNER_DISPLAY_NAME`, and `OWNER_PASSWORD` from its process environment. Supply the password ephemerally and clear it immediately—do not add it to `.env` or shell history.

For a forgotten member password, `npm run password:reset -w @fantasy/api` reads `ACCOUNT_EMAIL` and
`ACCOUNT_NEW_PASSWORD`, replaces the Argon2id hash, and revokes every existing session. The
container-safe invocation is documented in [docs/operations.md](./docs/operations.md).

## Friend registration

Set `REGISTRATION_INVITE_CODE` to a high-entropy 16–128 character value and set a stable
`SESSION_SECRET` of at least 32 characters to enable `/register`. Blank or omit the registration
code to disable that route. One code can be shared out of band with the group; each friend creates
an individual member account and receives a separate HTTP-only session. The API derives a
domain-separated HMAC at startup, compares candidate digests in constant time, never writes the
code to PostgreSQL, and limits registration to 30 attempts per IP every ten minutes. Duplicate
emails and incorrect codes intentionally return the same generic response. Rotate the environment
value to stop use of a previously shared code; existing accounts and sessions are unaffected.

Personal, expiring, single-use invitation links remain available to administrators as a separate
access path.

Then open <http://localhost:3000> for the public site or <http://localhost:3000/app> for the locker
room. The API listens on <http://localhost:4000>; liveness is available at `/health/live`.

After signing in, `/rankings` provides the first complete custom-board slice: private rankings,
ADP, auction values, and cheat-sheet metadata; immutable draft/published versions; player-catalog
resolved CSV preview and idempotent commit; manual row edits; JSON/CSV export; and revocable,
bounded share links. Share capabilities live in URL fragments and are submitted to the API only in
request bodies, so they do not enter server paths or query logs.

Accessible saved or league-shared boards can be copied into a private baseline and compared side by
side without modifying either source. Rank order controls work by pointer or keyboard.

`/draft` opens authenticated, league-scoped snake and auction rooms backed by an append-only
PostgreSQL event ledger. Owners and commissioners can configure the real snake order or auction
budget, record manual results, safely retry writes, undo or correct entries, and reopen or share a
session link; other league members can follow the same room. Snake rooms can use context-matched,
attributed daily ADP to estimate wait risk, while auction rooms consume authored AAV and target
prices for target/drain nominations. Projection-derived VBD consumes a compatible league/week set
and remains visibly unavailable when none passes scoring and quality gates; rankings are never
relabeled as projected points. Practice Room explicitly forks
the current room into browser memory for seeded snake or auction simulation, undo, and replay;
synthetic events never call room or provider mutation APIs. The interface deliberately reports
`providerPolling=false`: ESPN/Yahoo live-draft polling is not claimed, and the sample board remains
available only as an explicitly labeled demo.

`/stats` reads only the latest admitted nflverse weekly-stat and snap-count versions. It provides
filterable targets, carries, opportunities, target-share, and offensive-snap leaders with source
timestamps, attribution, and identity-quality counts. Metrics that need complete league scoring,
red-zone inputs, or full coverage remain explicitly unavailable instead of being estimated from an
incompatible dataset.

Development mode can display a clearly marked sample portfolio without credentials. Before using any real provider connection, generate the secrets described in `.env.example` and keep `.env` out of source control.

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run check` runs the complete sequence. Provider contract tests use sanitized fixtures; real-account checks will be opt-in and must never issue writes.

With local PostgreSQL running, the additional persistence checks are:

```bash
npm run db:smoke -w @fantasy/db
npm run bridge:smoke -w @fantasy/api
npm run espn:import:smoke -w @fantasy/api
npm run yahoo:smoke -w @fantasy/api
npm run invitation:smoke -w @fantasy/api
npm run registration:smoke -w @fantasy/api
npm run runtime:smoke
```

The API smoke commands run inside forced-rollback transactions: `bridge:smoke` proves first-owner
creation, scoped device authentication, outsider/manager denial, commissioner replacement,
normalization, persistence, and replay idempotency;
`espn:import:smoke` proves strict preview/confirmed commit, checksum idempotency, owner/commissioner
replacement authorization, cross-user isolation, non-authoritative player observations, and
last-good rollback for canonical recovery;
`yahoo:smoke` proves two-account membership isolation, exact provider-team claim enforcement,
conflict-safe automatic claims, connection-to-league provenance, atomic official-read persistence,
replay idempotency, and rollback on an invalid bundle;
`invitation:smoke` proves hashed, single-use capabilities and league membership; and
`registration:smoke` proves normalized unique member creation plus initial password/session hashes.
To perform a real network check of the canonical nflverse player source and update the local
catalog, run
`npm run catalog:refresh -w @fantasy/worker`.
The dashboard's authenticated **Check NFL data** action queues the complete shared-data sweep:
nflverse identity, the four-season schedule/player-stat/team-stat/weekly-roster/snap window, Sleeper
player/status observations, and Sleeper add/drop momentum. A successful sweep then queues the Laces Out weekly
forecast. The same forecast is scheduled hourly and conditionally checks current-season
inputs before computing; unchanged checksums do not create duplicate projection artifacts.
**Check draft market** refreshes the 8-, 10-, 12-, and 14-team standard, half-PPR, and PPR ADP
contexts. These shared-data checks do not replace Yahoo league sync, ESPN browser sync, or private
projection imports; those remain separate workflows in Connections and Projections. Sleeper market
momentum can adjust likely FAAB competition, but a waiver recommendation still has to improve
modeled roster value.

Weekly roster membership prevents the forecast benchmark from silently dropping recently relevant
players who finished with no stats and no snaps. Completed DNPs are scored as zero outcomes but do
not become played-game role training; future games and byes cannot create synthetic zeroes.
`runtime:smoke` builds and actually starts the production API, worker, and web app; verifies API
liveness/database readiness plus a rendered invite route on isolated ports; then shuts them down.

## Yahoo setup

1. Yahoo connection remains Coming Soon in the public product. Enable it only after completing the
   deployment's provider release checklist.
2. Register an exact callback such as `https://your-host.example/v1/connections/yahoo/callback`.
3. Set `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, and `YAHOO_REDIRECT_URI` only on the API server.
4. Keep write access disabled. The connector uses Authorization Code + PKCE and serializes each
   rotating refresh-token exchange under a database row lock plus credential-version compare-and-swap.
5. A successful callback performs bounded league discovery and an initial read sync. The
   connections screen can repeat discovery or refresh one linked league on demand. Settings,
   teams, rosters, standings, and the current scoreboard commit as one transaction; a failed
   provider read preserves the last good snapshot.
6. Each account-to-league link retains Yahoo's exact current-user team key. The dashboard exposes
   only that mapped team as claimable for the connected user. An unambiguous first sync claims it
   automatically when it is free; a historical or concurrent ownership conflict leaves the sync
   healthy and never permits either account to take another user's team.
7. The signed-in app globally renders Yahoo's official Fantasy mark and required linked
   attribution.
8. Disconnect removes Laces Out's stored encrypted credential and stops future sync while
   preserving last-known league data. It does not revoke authorization at Yahoo; perform
   provider-side revocation separately when needed.

Yahoo credentials are not required for fixture tests, the forced-rollback persistence smoke, the
engines, or manual workflows. Live-account accuracy is not claimed until the deployment's exact
response shapes pass the same contract suite with sanitized captures.

## ESPN setup

Do not enter an ESPN password into this application. For private leagues, `/connections` creates a revocable, league-scoped one-click bookmark that runs while the user is signed in on ESPN and uploads only bounded, checksummed league data. Users who want six-hour background refreshes can instead install the [browser companion](./apps/espn-bridge/README.md). Either method can sequentially sync up to 32 leagues for one season. The API stores only the sync-token hash, validates each league allowlist entry/checksum/capture time/schema, and commits normalized league state atomically. A device allowlist is transport scope, not membership: the first accepted snapshot for a new internal league establishes its authenticated Laces Out user as owner, while later replacement requires that user already be the owner or a commissioner. Neither method uploads ESPN session material or brands the flow as official ESPN OAuth. Authorized members claim their fantasy team in Laces Out because the unofficial response does not safely identify the active ESPN member.

The anonymous public-league client and canonical recovery parser remain isolated connector
boundaries and are not exposed as connection options in the hosted application. Roster players
reuse only verified catalog crosswalks;
otherwise the import creates a non-verified league-season observation. Its supplied roster fields
remain usable inside that league's dashboard, draft, and projection workflows, but the row is
excluded from unscoped ranking/catalog resolution and cannot update or masquerade as a verified
shared identity.

Exercise both ESPN persistence branches against PostgreSQL with:

```bash
npm run bridge:smoke -w @fantasy/api
npm run espn:import:smoke -w @fantasy/api
```

## Weekly projections and imports

The worker builds managed Laces Out projection sets for the two earliest actionable weeks of each
safely supported league; an explicit week can also be requested for research. It forecasts provider-neutral QB, RB, WR, TE, K, and D/ST stat components from
strictly prior nflverse observations, the schedule, recent role, opponent/team context, and current
status, then applies that league's exact supported Yahoo or ESPN scoring rules. Unknown, nonlinear,
IDP, or otherwise unsupported scoring is rejected rather than approximated. Byes are explicit
zeros, confirmed inactive players are zeroed, and missing, stale, degraded, or incomplete inputs
preserve the prior good publication instead of replacing it. Managed-set metadata retains input
checksums, model version, source and training cutoffs, coverage, warnings, and locked-backtest
metrics. Projection Lab exposes those details and can queue a fresh input check and rerun. The full
training window refreshes daily, current-season inputs are conditionally checked before every
hourly forecast sweep, and a ten-minute game-aware sweep runs within 130 minutes of kickoff with a
forced final source check inside ten minutes. Completed ESPN/Yahoo syncs plus manual checks enqueue
immediate reruns. In-flight or unavailable sources and unknown kickoff times fail closed, while
started games retain their last pre-kickoff rows.

The managed model is a weekly forecast, including individually scored future weeks. A separate
deterministic rest-of-season distribution model, season-blocked champion evaluator, and
split-conformal interval-calibration rail exist in shadow mode. Trade values, end-of-season
forecasts, and other ROS consumers remain gated until the official multi-season replay clears every
position/horizon cell and its later untouched-season interval test.

The current official v6 replay completed all 2,040 forecasts and 68 evaluation batches without a
missing or skipped forecast. Every portfolio and availability gate passes; only the one-to-four-week
kicker interval cell remains withheld by its evidence gate. Weekly managed projections remain the
production source, and no ROS value is exposed to lineup, waiver, trade, standings, API, or UI
consumers before an explicit admission and rollout decision.

The `/projections` area accepts bounded single-week CSV files after a league has been
synchronized. Rest-of-season imports are intentionally not offered yet: the Decision Desk and
league analytics consume only an exact league-season/week set, so the app never invites users to
save data those tools will ignore. Preview resolves every supplied canonical player ID, GSIS ID, or
exact player name and blocks the entire import on invalid, duplicate, unresolved, or ambiguous
rows. Commit repeats that server-side parse and requires the previewed normalized checksum; the
browser cannot submit pre-resolved rows. Raw CSV content is not retained.

Imports are private by default and exact to one league season. League owners, commissioners, and
application admins may publish a set to that league; ordinary members cannot. In-season decisions
select only a compatible single-week set for the exact league/week that is either owned by the
requesting user or shared with the league. Every import requires a strict UTC source-as-of timestamp
and rejects values more than five minutes in the future. That source time participates in both
confirmation checksums and is persisted separately from the later import time. Source label, file
name, author, both timestamps, row count, and source/normalized checksums remain attached as
provenance. Older user-CSV rows that predate trustworthy source-as-of metadata remain usable but are
shown as missing/unverified and are never described as fresh.

Decision Desk results are roster-rule and eligibility models, not assertions that Yahoo or ESPN
will accept an action. The providers do not supply complete lock, transaction-deadline, waiver,
veto, or keeper-constraint coverage through the implemented read paths. Stored `locked=true`
facts are honored; `locked=false` is not treated as provider verification. Every lineup, waiver,
and trade recommendation carries that warning and opens the provider for manual verification and
completion. Laces Out does not execute those actions.

## AI and chat products

`/film-room` uses the operator's server-side `GEMINI_API_KEY` and fixed
`gemini-3.1-flash-lite` model to provide included analysis to every signed-in member. A member may
optionally save an OpenAI, Anthropic, Gemini, or OpenRouter key; that key overrides included Gemini
for the selected provider and unlocks model selection plus independent limits. Personal keys are
write-only after save and protected in purpose-bound AES-256-GCM envelopes. The API uses each
provider's native endpoint, requests stateless processing where supported, and stores only bounded
usage metadata—not raw questions or answers. Every analysis request is membership-scoped and
grounded in that league's overview, deterministic Decision Desk output, and league analytics. The
model receives no tools and no ability to execute a Yahoo or ESPN action.

Set `GEMINI_API_KEY` only in the API server environment. Managed usage defaults to 50 requests per
member per UTC day and 900 output tokens; override those values with
`MANAGED_AI_DAILY_REQUEST_LIMIT` and `MANAGED_AI_MAX_OUTPUT_TOKENS`. The included free-tier project
is governed by Google's free-tier processing terms, including its disclosed product-improvement
use of submitted content.

ChatGPT and Claude consumer subscriptions are not transferable API credentials; provider API
billing is separate. An OAuth-protected remote MCP connector for using Laces Out from compatible
chat products remains a later, separate integration. See [AI provider integration](./docs/provider-notes/ai-provider-integration.md).

## Security posture

- provider access is read-only by default;
- application sign-in currently uses local email/password accounts with Argon2id hashes and
  revocable server-side sessions; OIDC, passkeys, and MFA remain roadmap work;
- secrets and refresh tokens never enter browser storage;
- persisted Yahoo credentials use versioned AES-256-GCM envelopes;
- API request logs strip query strings, the gateway redacts Yahoo callback code/state values, and
  structured secret fields, cookies, auth headers, and ESPN session fields are redacted;
- connector egress, payload size, parsing, retries, and raw artifact retention are bounded;
- production startup requires explicit session/encryption secrets;
- internet sharing requires TLS at Caddy or an equivalent trusted edge; plain HTTP is for loopback
  development only;
- Yahoo local disconnect deletes the encrypted credential while preserving last-known data; ESPN
  bridge devices are independently revocable.

See [SECURITY.md](./docs/security.md) before exposing the application to the internet.

## Development rules

- Add provider quirks only inside their adapter.
- Add a sanitized fixture and parser test for every external payload shape.
- Preserve recommendation inputs, algorithm version, input hash, and random seed.
- Never silently merge uncertain player identities.
- Never present stale projections or league state without a freshness warning.
- A live draft must remain completable through manual entry, undo, and replay.

## Roadmap

Milestones and exit gates are tracked in the implementation plan. Remaining work centers on provider
hardening, automated refresh and notifications, supported live-draft enhancements, deeper
recommendation validation, optional chat-product connectors, and operational hardening.
