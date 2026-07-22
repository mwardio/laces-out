# Laces Out

**An invite-only, self-hosted fantasy football decision system for friends.** It syncs Yahoo and
ESPN leagues, builds its own backtested weekly forecast, and automates draft, lineup, waiver,
trade, opponent, and league-wide analysis — user-specific and league-specific, not generic
rankings with a chat layer.

![Laces Out — automated league brief](./apps/web/src/app/opengraph-image.png)

## What's inside

- **League sync** — official Yahoo OAuth (read-only, PKCE) and a private ESPN path: a one-click
  sync bookmark or the signed [Chrome Web Store companion](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj)
  with one-click web-to-extension pairing. Credentials never travel; league data does.
- **First-party forecasts** — a locked-backtest weekly model built from immutable nflverse
  identity, schedule, player/team stats, rosters, injuries, and snap counts, scored to each
  league's exact rules. Unsupported scoring is rejected, never approximated.
- **Decision automation** — every fresh sync or projection import reruns lineup, waiver, trade,
  opponent, and roster-strength analysis and ranks the calls by impact, confidence, and urgency.
- **Draft day** — persistent league-scoped snake and auction rooms on an append-only event
  ledger, with live inflation, scarcity, wait risk, max-bid math, and a browser-local Practice
  Room simulator.
- **Custom edge** — private rankings, ADP, auction values, cheat sheets, and single-week CSV
  projection imports with strict provenance; they sharpen the built-in engine, never power it.
- **Stats Center** — filterable usage/opportunity leaders from the latest admitted nflverse
  versions, with source timestamps and attribution; incompatible metrics stay visibly
  unavailable.
- **Film Room AI** — included Gemini analysis for every member plus encrypted BYOK for OpenAI,
  Anthropic, Gemini, or OpenRouter; grounded in synced league facts, and structurally unable to
  execute provider actions.
- **Market context** — daily Fantasy Football Calculator ADP across formats and hourly attributed
  Sleeper waiver-market momentum.

**Status:** weekly managed projections are the production source. The rest-of-season distribution
engine (model v6) runs in fail-closed shadow mode: the official replay clears every portfolio,
convergence, and availability gate across 2,040 forecasts, with a single interval cell
(one-to-four-week kickers) still withheld by its evidence gate. No ROS value reaches any consumer
before an explicit admission decision; the untouched 2026 final proof is pre-registered in
[docs/ros-v6-2026-untouched-protocol.md](./docs/ros-v6-2026-untouched-protocol.md). Remaining work
is tracked in the ,
, and
a provider account is connected when it is not.

## Provider status

- **Yahoo:** official read-only authorization and sync are implemented, presented as **Coming
  Soon** until enabled for a deployment.
- **ESPN:** no public Fantasy OAuth exists, so private leagues use the scoped bookmark or the
  read-only browser companion. Users sign in on ESPN itself; passwords and cookies stay in the
  browser.
- **Writes:** lineup changes, waiver claims, and trades are disabled everywhere. The app
  recommends and deep-links; every action is completed at the provider.

Evidence and constraints live in [docs/provider-notes/](./docs/provider-notes/).

## Architecture

```text
apps/web          Next.js responsive PWA (hand-authored CSS layers + tokens; no Tailwind)
apps/api          Fastify REST API, provider ingestion, and job-enqueue boundary
apps/worker       pg-boss runtime; shared NFL inputs, forecasts, ADP/status/market jobs
apps/espn-bridge  private ESPN league browser-sync companion (Manifest V3)

packages/domain             provider-neutral entities and rules
packages/connectors         provider capability and sync ports
packages/connector-yahoo    supported Yahoo OAuth/API adapter
packages/connector-espn     import/public ESPN adapter boundary
packages/db                 Drizzle schema and SQL migrations
packages/projections        scoring normalization, weekly model, ROS distributions, uncertainty
packages/engine-*           draft, lineup, waiver, trade engines
packages/league-analytics   strength, luck, schedule, and opportunity analysis
packages/security           credential envelopes and redaction
packages/source-ffc         contextual redraft ADP
packages/source-nflverse    canonical identity, schedules, weekly stats, rosters, injuries, snaps
packages/source-sleeper     player/status/trend sources and read-only league adapter
```

PostgreSQL is the only required stateful service. Provider packages normalize external data;
recommendation packages never import provider code.

## Quickstart

Requires Node.js 22.22+ (below 25), npm 9+, and Docker (or PostgreSQL 17+).

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate -w @fantasy/db
npm run owner:create -w @fantasy/api   # reads OWNER_EMAIL / OWNER_PASSWORD from the environment
npm run dev
```

Public site at <http://localhost:3000>, locker room at `/app`, API at <http://localhost:4000>
(liveness at `/health/live`). Supply the owner password ephemerally — never in `.env` or shell
history. Forgotten member passwords are reset with `npm run password:reset -w @fantasy/api`
(revokes all sessions); the container-safe form and full production deployment are documented in
[docs/operations.md](./docs/operations.md).

### Friend registration

Set `REGISTRATION_INVITE_CODE` (high-entropy, 16–128 chars) and a stable `SESSION_SECRET` (32+
chars) to enable `/register`; blank the code to disable it. One code is shared out of band and
each friend creates an individual account. The API compares a domain-separated HMAC in constant
time, never persists the code, rate-limits to 30 attempts per IP per ten minutes, and returns the
same generic response for duplicates and wrong codes. Rotating the value stops new registrations
without touching existing accounts. Admins also have personal, expiring, single-use invitation
links as a separate path.

## The signed-in app

- **`/rankings`** — private rankings, ADP, auction values, and cheat-sheet metadata with immutable
  draft/published versions, catalog-resolved CSV preview + idempotent commit, JSON/CSV export, and
  revocable bounded share links (capabilities ride URL fragments and request bodies only, never
  server logs). Boards can be copied and compared side by side; reordering works by pointer or
  keyboard.
- **`/draft`** — league-scoped snake and auction rooms with owner/commissioner controls, manual
  entry, safe retries, undo/replay, and shareable sessions. Snake rooms use context-matched daily
  ADP for wait risk; auction rooms consume authored AAV and target prices. Projection-derived VBD
  appears only when a compatible league/week set passes its quality gates — rankings are never
  relabeled as projected points. The interface reports `providerPolling=false`: live provider
  draft polling is not claimed.
- **`/stats`** — usage and opportunity leaders from the latest admitted data versions only.
- **`/projections`** — Projection Lab for managed forecasts (inputs, checksums, coverage,
  warnings, backtest metrics, on-demand reruns) plus bounded single-week CSV imports with strict
  preview/commit checksums and full provenance. ROS imports are deliberately not offered while no
  tool consumes them.
- **`/film-room`** — included Gemini 3.5 Flash for every member (default 50 requests/day, 2,000
  output tokens; see `MANAGED_AI_DAILY_REQUEST_LIMIT` / `MANAGED_AI_MAX_OUTPUT_TOKENS`), optional
  write-only BYOK in AES-256-GCM envelopes, native provider endpoints, no tools, no provider
  execution, and only bounded usage metadata retained. See
  [AI provider integration](./docs/provider-notes/ai-provider-integration.md).

Decision Desk results are roster-rule and eligibility models, not assertions a provider will
accept an action — providers do not expose complete lock/deadline/waiver/veto coverage through the
implemented read paths, so every recommendation carries that warning and links out for manual
completion.

## Forecast integrity

The weekly model forecasts provider-neutral stat components strictly from prior observations, then
applies each league's exact scoring. Byes are explicit zeros, confirmed inactives are zeroed, and
missing, stale, degraded, or in-flight inputs fail closed and preserve the prior good publication.
The full training window refreshes daily; forecasts sweep hourly, tighten to ten-minute checks
near kickoff with a forced final input check, and rerun immediately after league syncs. Completed
DNPs score as zero outcomes without polluting role training; future games and byes cannot create
synthetic zeros. Managed-set metadata pins input checksums, model version, cutoffs, coverage, and
locked-backtest metrics.

## Verification

```bash
npm run check          # format:check + lint + typecheck + test + build
```

With PostgreSQL running, the persistence and runtime checks are:

```bash
npm run db:smoke -w @fantasy/db
npm run bridge:smoke -w @fantasy/api        # ESPN device auth, ownership, replay idempotency
npm run espn:import:smoke -w @fantasy/api   # preview/commit checksums, isolation, rollback
npm run yahoo:smoke -w @fantasy/api         # account isolation, team claims, atomic reads
npm run invitation:smoke -w @fantasy/api    # hashed single-use capabilities
npm run registration:smoke -w @fantasy/api  # unique members, password/session hashes
npm run runtime:smoke                       # builds and boots api/worker/web on isolated ports
```

API smokes run in forced-rollback transactions against real PostgreSQL. Provider contract tests
use sanitized fixtures; real-account checks are opt-in and never issue writes.
`npm run catalog:refresh -w @fantasy/worker` performs a real network check of the canonical
nflverse player source. The dashboard's **Check NFL data** action queues the complete shared-data
sweep and, on success, the weekly forecast; **Check draft market** refreshes the 8/10/12/14-team
standard, half-PPR, and PPR ADP contexts.

## Provider setup

**Yahoo** — register an exact callback (`https://your-host/v1/connections/yahoo/callback`), set
`YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` / `YAHOO_REDIRECT_URI` on the API server only, and keep
write access disabled. The connector serializes rotating refresh-token exchanges under a row lock
with credential-version compare-and-swap; a successful callback runs bounded discovery and an
initial read sync committed as one transaction. Each link retains Yahoo's exact current-user team
key, and only that team is claimable — conflicts never let one account take another user's team.
Disconnect deletes the stored encrypted credential (provider-side revocation is separate). The app
renders Yahoo's required attribution globally.

**ESPN** — never enter an ESPN password here. `/connections` creates a revocable, league-scoped
bookmark, or install the [browser companion](./apps/espn-bridge/README.md) for six-hour background
refreshes and one-click pairing. Either path syncs up to 32 leagues, uploads only bounded
checksummed league data, and stores just the sync-token hash. The first accepted snapshot for a
new internal league establishes its Laces Out owner; replacement requires owner or commissioner.
Members claim their own team in-app because the unofficial response cannot safely identify the
active ESPN member. Unverified roster identities become quarantined league-season observations —
usable inside that league, never merged into shared identity.

## Security posture

- Provider access is read-only by default; secrets and refresh tokens never enter browser storage.
- Local email/password accounts use Argon2id hashes and revocable server-side sessions (OIDC,
  passkeys, MFA are roadmap).
- Yahoo credentials persist in versioned AES-256-GCM envelopes; ESPN bridge devices are
  independently revocable.
- Request logs strip query strings; the gateway redacts OAuth callback values; structured secrets,
  cookies, auth headers, and session fields are redacted.
- Connector egress, payload sizes, parsing, retries, and raw-artifact retention are bounded.
- Production startup requires explicit secrets; internet exposure requires TLS at Caddy or an
  equivalent trusted edge.

Read [docs/security.md](./docs/security.md) before exposing a deployment, and set
`NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_CONTACT_EMAIL` first. The operator-facing privacy source is
[docs/privacy.md](./docs/privacy.md).

## Development rules

- Add provider quirks only inside their adapter.
- Add a sanitized fixture and parser test for every external payload shape.
- Preserve recommendation inputs, algorithm version, input hash, and random seed.
- Never silently merge uncertain player identities.
- Never present stale projections or league state without a freshness warning.
- A live draft must remain completable through manual entry, undo, and replay.

## Documentation

| Document                                                                           | Purpose                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/operations.md](./docs/operations.md)                                         | Deployment, runbook, health, and operator checks       |
| [docs/security.md](./docs/security.md)                                             | Threat model and hardening baseline                    |
| [docs/privacy.md](./docs/privacy.md)                                               | Operator privacy source of truth                       |
| [docs/ros-v6-2026-untouched-protocol.md](./docs/ros-v6-2026-untouched-protocol.md) | Frozen 2026 final-proof protocol                       |
| [docs/provider-notes/](./docs/provider-notes/)                                     | Provider evidence and constraints                      |
| [apps/espn-bridge/README.md](./apps/espn-bridge/README.md)                         | Browser companion build, pairing, and store submission |
| [packages/projections/README.md](./packages/projections/README.md)                 | Model internals and evaluation methodology             |

## Roadmap

Milestones and exit gates live in the implementation plan: provider hardening, automated refresh
and notifications, supported live-draft enhancements, deeper recommendation validation, optional
chat-product connectors, and operational hardening. Sanctioned 2026 private-league testing and
terms review remain release gates.
