<p align="center">
  <img src="apps/web/public/brand/laces-out-playbook-mark.png" alt="Laces Out playbook mark" width="140">
</p>

<h1 align="center">Laces Out</h1>

<p align="center">
  <strong>Self-hosted fantasy football intelligence for a league of friends.</strong><br>
  Syncs your ESPN and Yahoo leagues, builds its own backtested weekly projections,
  and turns every sync into ranked lineup, waiver, trade, and draft calls — on your server, invite-only.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22.22%2B-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white">
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-1f7a3d">
</p>

---

## What it does

- **League sync, read-only by design** — official Yahoo OAuth (PKCE, read-only) and a private ESPN
  path: a revocable one-click sync bookmark or the signed
  [Chrome Web Store companion](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj)
  with one-click pairing. Credentials never leave the browser; only bounded league data does.
  Writes (lineup changes, waivers, trades) are disabled everywhere — the app recommends and
  deep-links, you complete actions at the provider.
- **First-party weekly projections** — a locked-backtest model built from immutable nflverse
  identity, schedule, stats, rosters, injuries, and snap counts, scored to each league's _exact_
  rules. Unsupported scoring is withheld, never approximated.
- **Decision automation** — every fresh sync reruns lineup, waiver, trade, opponent, and
  roster-strength analysis and ranks the calls by impact, confidence, and urgency.
- **Draft day** — persistent snake and auction rooms on an append-only event ledger, with live
  inflation, scarcity, wait risk, max-bid math, and a browser-local Practice Room simulator.
- **Your own edge** — private rankings, ADP, auction values, cheat sheets, and single-week CSV
  projection imports with strict provenance; they sharpen the built-in engine, never power it.
- **Stats Center** — filterable usage and opportunity leaders from the latest admitted nflverse
  versions, with source timestamps and attribution.
- **Film Room AI** — included Gemini analysis for every member (operator-supplied key, fixed
  server-side model, daily limits) plus encrypted BYOK for OpenAI, Anthropic, Gemini, or
  OpenRouter. Grounded in synced league facts; no tools, no provider execution.
- **Market context** — daily Fantasy Football Calculator ADP across formats and hourly attributed
  Sleeper waiver-market momentum.

## Statistically honest projections

Most fantasy tools show you a number. Laces Out shows you a number only when it has earned one:

- Publication is gated by locked, strictly prior walk-forward backtests. Per position, the richer
  contextual model must beat a transparent recency baseline on your league's scoring before it
  goes live — until then, the baseline _is_ the live strategy.
- Forecasts carry calibrated intervals with audited coverage, pinned input checksums, training
  cutoffs, and backtest metrics visible in the Projection Lab.
- Missing, stale, or in-flight inputs fail closed and preserve the last good publication. Byes and
  confirmed inactives are explicit zeros, never model noise.
- The rest-of-season distribution engine graduates cell by cell — each position × horizon must
  independently pass pre-registered evidence gates and an explicit, operator-confirmed admission
  before its values reach any screen or engine. Cells that have not earned it stay withheld, and
  the final release proof is a frozen protocol against a fully untouched future season.

Details: [packages/projections/README.md](./packages/projections/README.md) and

## Quick start (Docker Compose)

Requirements: Docker with the Compose plugin. The stack is five containers — Caddy gateway,
Next.js web, Fastify API, pg-boss worker, PostgreSQL 17 — plus a one-shot migration job.
PostgreSQL is the only stateful service, and it binds to host loopback only.

Clone the repository, then from the repo root:

```bash
cp .env.docker.example .env
# Replace every `replace-with-...` value. Generator commands are documented in the file.
docker compose config --quiet
docker compose up --build -d --wait
curl --fail http://localhost:3000/health/ready
```

Production startup deliberately rejects placeholder secrets and the default database password —
fill in every value before expecting the stack to become healthy.

Create the first administrator (supply the password ephemerally, never in `.env`):

```bash
read -rsp "Owner password: " OWNER_PASSWORD && echo
docker compose run --rm --no-deps \
  -e OWNER_EMAIL="owner@example.com" \
  -e OWNER_DISPLAY_NAME="League Admin" \
  -e OWNER_PASSWORD="$OWNER_PASSWORD" \
  migrate node apps/api/dist/create-owner.js
unset OWNER_PASSWORD
```

Open <http://localhost:3000> and sign in; the signed-in app lives at `/app`.

**Inviting friends:** set `REGISTRATION_INVITE_CODE` to enable `/register` and share the code out
of band. The API stores only a domain-separated HMAC, compares in constant time, and rate-limits
attempts; rotating or blanking the code closes registration without touching existing accounts.
Admins also get personal, expiring, single-use invitation links.

Updates, backups, password resets, and the full runbook are in
[docs/operations.md](./docs/operations.md). Before exposing a deployment to the internet, read
[docs/security.md](./docs/security.md).

## Configuration

All configuration is environment variables, documented inline in
[.env.docker.example](./.env.docker.example) (Compose) and [.env.example](./.env.example)
(local development).

| Variable                                  | Required | Default                 | Purpose                                                                                                                  |
| ----------------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_URL`                              | Yes      | `http://localhost:3000` | Browser-visible origin. Compiled into the web bundle — rebuild images after changing it.                                 |
| `POSTGRES_PASSWORD`                       | Yes      | —                       | Database password. Placeholders and the dev default are rejected at production startup.                                  |
| `SESSION_SECRET`                          | Yes      | —                       | 32+ random chars for session/capability key derivation (`openssl rand -hex 32`).                                         |
| `CREDENTIAL_ENCRYPTION_KEY`               | Yes      | —                       | `base64:`-prefixed 32 random bytes for AES-256-GCM credential envelopes (`printf 'base64:' && openssl rand -base64 32`). |
| `REGISTRATION_INVITE_CODE`                | No       | empty                   | Shared friend-registration code (16–128 chars). Blank disables `/register`.                                              |
| `GEMINI_API_KEY`                          | No       | empty                   | Server-side Google AI Studio key enabling the included Film Room for every member. Never exposed to the browser.         |
| `MANAGED_AI_DAILY_REQUEST_LIMIT`          | No       | `50`                    | Included AI requests per member per UTC day.                                                                             |
| `MANAGED_AI_MAX_OUTPUT_TOKENS`            | No       | `2000`                  | Included AI answer token cap.                                                                                            |
| `NEXT_PUBLIC_CONTACT_EMAIL`               | No*      | empty                   | Operator contact compiled into the footer, privacy policy, and terms. *Set before internet exposure.                     |
| `NEXT_PUBLIC_YAHOO_ACCESS_STATUS`         | No       | `pending`               | Set to `available` after a Yahoo app is approved and credentials are configured.                                         |
| `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | No       | empty                   | Yahoo OAuth app credentials, API server only.                                                                            |
| `SITE_ADDRESS`                            | No       | `:80`                   | Caddy site address. Set to your domain for automatic HTTPS.                                                              |
| `APP_PORT` / `HTTPS_PORT`                 | No       | `3000` / `3443`         | Host ports for the gateway. Use `80`/`443` for a public deployment.                                                      |
| `POSTGRES_PORT`                           | No       | `55432`                 | Host port for PostgreSQL, bound to `127.0.0.1` only.                                                                     |
| `LOG_LEVEL`                               | No       | `info`                  | API/worker log level.                                                                                                    |

For a public deployment, point a domain at the host and set `PUBLIC_URL`, `SITE_ADDRESS`,
`APP_PORT=80`, and `HTTPS_PORT=443` as shown in `.env.docker.example` — Caddy then obtains and
renews TLS automatically. Plain HTTP is a loopback-only development mode.

## Architecture

npm-workspaces TypeScript monorepo. One Caddy gateway fronts everything so cookies, OAuth
callbacks, the web UI, and the API share a single origin.

```text
apps/
  web            Next.js 16 responsive PWA (React 19, hand-authored CSS layers — no Tailwind)
  api            Fastify 5 REST API: auth, provider callbacks, ingestion, job enqueue
  worker         pg-boss runtime: NFL data refresh, forecast sweeps, ADP/status/market jobs
  espn-bridge    Chrome (Manifest V3) companion for private ESPN league sync

packages/
  domain, contracts, config      provider-neutral entities, zod wire contracts, validated env config
  connectors, connector-yahoo,   provider capability/sync ports and per-provider adapters
  connector-espn
  db                             Drizzle ORM schema and SQL migrations
  projections                    scoring normalization, weekly model, ROS distributions, uncertainty
  engine-draft / -lineup /       recommendation engines
  -trade / -waiver
  league-analytics               strength, luck, schedule, and opportunity analysis
  rankings                       private rankings, cheat sheets, CSV import, share integrity
  source-nflverse / -sleeper /   data-source adapters: identity, schedules, stats, status, ADP
  -ffc
  security                       credential envelopes and redaction
  ingestion, testkit             canonical identity resolution, shared test fixtures
```

Data flow in one line: source and connector packages normalize external data into PostgreSQL via
the API and worker; recommendation engines read only normalized domain data and never import
provider code.

**Stack:** TypeScript throughout · Next.js 16 + React 19 · Fastify 5 · PostgreSQL 17 with Drizzle
ORM · pg-boss job queues · Vitest · Caddy 2 gateway · Docker Compose.

## Development

Requires Node.js `>=22.22 <25` (see `engines` in `package.json`) and Docker (or your own
PostgreSQL 17+).

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate -w @fantasy/db
npm run owner:create -w @fantasy/api   # reads OWNER_EMAIL / OWNER_PASSWORD from the environment
npm run dev
```

Web at <http://localhost:3000>, API at <http://localhost:4000> (liveness at `/health/live`).

| Command                                         | What it does                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                                   | web + api + worker with live reload                                |
| `npm run check`                                 | format check + lint + typecheck + tests + build (the release gate) |
| `npm run test` / `test:watch` / `test:coverage` | Vitest suites                                                      |
| `npm run lint` / `typecheck` / `format`         | ESLint (zero warnings), `tsc --noEmit`, Prettier                   |
| `npm run build`                                 | builds api, worker, espn-bridge, and web                           |

With PostgreSQL running, database-backed release checks (forced-rollback transactions against a
real database; provider contract tests use sanitized fixtures and never issue writes):

```bash
npm run db:smoke -w @fantasy/db
npm run bridge:smoke -w @fantasy/api        # ESPN device auth, ownership, replay idempotency
npm run yahoo:smoke -w @fantasy/api         # account isolation, team claims, atomic reads
npm run invitation:smoke -w @fantasy/api    # hashed single-use capabilities
npm run registration:smoke -w @fantasy/api  # unique members, password/session hashes
npm run runtime:smoke                       # builds and boots api/worker/web on isolated ports
```

House rules: provider quirks live only in their adapter; every external payload shape gets a
sanitized fixture and parser test; recommendation inputs, algorithm version, input hash, and seed
are preserved; uncertain player identities are never silently merged; stale data always carries a
freshness warning; a live draft must stay completable through manual entry, undo, and replay.

## Security and privacy

- Provider access is read-only; secrets and refresh tokens never enter browser storage, and the
  ESPN path never asks for an ESPN password.
- Local accounts use Argon2id password hashes and revocable server-side sessions; production
  cookies are secure, HTTP-only, and same-site (OIDC/passkeys/MFA are roadmap, not claimed).
- Provider credentials persist in versioned AES-256-GCM envelopes; bridge devices are
  independently revocable.
- Request logs strip query strings, Caddy redacts OAuth callback values, and structured secrets,
  cookies, and auth headers are redacted. Connector egress, payload sizes, and retries are bounded.
- AI providers receive no credentials, tools, or write capability; prompts and answers are not
  persisted.

Threat model and hardening baseline: [docs/security.md](./docs/security.md). Operator privacy
source of truth (served in-app at `/privacy`): [docs/privacy.md](./docs/privacy.md).

## Provider status

| Provider   | Status                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESPN**   | Private leagues sync via the scoped bookmark or the read-only browser companion — no public Fantasy OAuth exists. You sign in on ESPN itself; passwords and cookies stay in your browser. |
| **Yahoo**  | Official read-only OAuth and sync are implemented, presented as **Coming Soon** until enabled for a deployment (requires an approved Yahoo app).                                          |
| **Writes** | Disabled everywhere, for every provider. The app recommends and deep-links; every action is completed at the provider.                                                                    |

Evidence and constraints live in [docs/provider-notes/](./docs/provider-notes/).

## Status and roadmap

Weekly managed projections are the production forecast source. The rest-of-season engine serves
only the cells that have earned admission through its evidence gates — everything else stays
withheld — with its final proof pre-registered against the untouched 2026 season. Demo data is always labeled, and no screen implies a provider account is connected
when it is not. Planned work includes provider hardening, automated refresh and notifications, supported live-draft enhancements, deeper
recommendation validation, and operational hardening.

## Documentation

| Document                                                                           | Purpose                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [docs/operations.md](./docs/operations.md)                                         | Deployment, runbook, health, backup, and operator checks |
| [docs/security.md](./docs/security.md)                                             | Threat model and hardening baseline                      |
| [docs/privacy.md](./docs/privacy.md)                                               | Operator privacy source of truth                         |
| [docs/ros-v6-2026-untouched-protocol.md](./docs/ros-v6-2026-untouched-protocol.md) | Frozen final-proof protocol for the ROS engine           |
| [docs/provider-notes/](./docs/provider-notes/)                                     | Provider evidence and constraints                        |
| [apps/espn-bridge/README.md](./apps/espn-bridge/README.md)                         | Browser companion build, pairing, and store submission   |
| [packages/projections/README.md](./packages/projections/README.md)                 | Model internals and evaluation methodology               |

## License

[MIT](./LICENSE)
