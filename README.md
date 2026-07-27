<p align="center">
  <img src="apps/web/public/brand/laces-out-playbook-mark.png" alt="Laces Out playbook mark" width="140">
</p>

<h1 align="center">Laces Out</h1>

<p align="center">
  <strong>Self-hosted fantasy football intelligence for leagues of friends.</strong><br>
  Sync ESPN leagues, build scoring-aware forecasts, and turn every refresh into ranked lineup,
  waiver, trade, opponent, and draft calls—on your server and invite-only.
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

- **Read-only league sync** — ESPN private leagues sync through a revocable bookmark or the signed
  [Chrome companion](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj).
  Yahoo OAuth and sync are implemented and remain labeled **Coming Soon** until enabled for a
  deployment. Laces Out never asks for a provider password or executes roster moves.
- **Monday Morning Awards** — every completed week is scored into Bad Beat, The Horseshoe,
  Beatdown, and Photo Finish, with a one-tap share card for the group chat. An award the stored
  evidence cannot support is withheld with its reason rather than shown as a zero.
- **Forecasts and decisions** — backtested weekly projections use nflverse identity, schedule,
  stats, injuries, rosters, and snap counts, scored to each league's exact rules. Every fresh input
  reruns lineup, waiver, trade, opponent, and roster-strength analysis.
- **Draft day** — persistent snake and auction rooms use an append-only event ledger with
  inflation, scarcity, wait risk, max-bid math, undo, replay, and a browser-local Practice Room.
- **Ad-hoc research** — Stats Center serves every admitted weekly field over any week range:
  volume, scored production, and derived efficiency (air yards, EPA, PACR, WOPR, CPOE), plus a
  per-player profile with a week-by-week game log. A metric the source file does not carry, or a
  share whose team coverage is unproven, is withheld with its reason rather than shown as a zero.
- **Schedule Edge** — league-scored matchup context, near-term and playoff windows, and legal-lineup
  bye pressure for your roster. A bye is asserted only where the admitted schedule covers both the
  team and week; matchup context stays descriptive unless locked historical validation admits
  directional language.
- **Your own edge** — private rankings, ADP, auction values, cheat sheets, custom projections,
  Sleeper momentum, and Fantasy Football Calculator markets sharpen the built-in engine without
  obscuring provenance.
- **Film Room AI** — included Gemini analysis plus encrypted BYOK support for OpenAI, Anthropic,
  Gemini, and OpenRouter. Answers are grounded in league facts and deterministic recommendations;
  models receive no provider credentials, tools, or write access.

## Screenshots

Every view below is the built-in locker room tour—no account required.

|                                                                         |                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| ![Locker room overview](./docs/screenshots/locker-room-overview.webp)   | ![Draft studio](./docs/screenshots/draft-studio.webp)     |
| ![Decision Desk](./docs/screenshots/decision-desk.webp)                 | ![Projection Lab](./docs/screenshots/projection-lab.webp) |
| ![Monday Morning Awards](./docs/screenshots/monday-morning-awards.webp) |                                                           |

## Statistically honest projections

Laces Out publishes a forecast only after it earns the right:

- Locked, strictly prior walk-forward backtests compare each position model with a transparent
  recency baseline under the league's scoring rules. Until the richer model wins, the baseline
  remains live.
- Forecasts carry calibrated intervals, audited coverage, pinned input checksums, training cutoffs,
  and visible backtest metrics. Missing, stale, or in-flight inputs fail closed.
- Rest-of-season cells graduate independently by position and horizon through pre-registered
  evidence gates and explicit admission. Everything else stays withheld.

See [Projection methodology](./packages/projections/README.md).

## Quick start

Requirements: Docker with the Compose plugin.

```bash
git clone https://github.com/mwardio/laces-out.git
cd laces-out
cp .env.docker.example .env
# Replace every replace-with-... value; generator commands are in the file.
docker compose config --quiet
docker compose up --build -d --wait
curl --fail http://localhost:3000/health/ready
```

Production startup rejects placeholder secrets and the default database password.

Create the first administrator without storing its password in `.env`:

```bash
read -rsp "Owner password: " OWNER_PASSWORD && echo
docker compose run --rm --no-deps \
  -e OWNER_EMAIL="owner@example.com" \
  -e OWNER_DISPLAY_NAME="League Admin" \
  -e OWNER_PASSWORD="$OWNER_PASSWORD" \
  migrate node apps/api/dist/create-owner.js
unset OWNER_PASSWORD
```

Open <http://localhost:3000>. Set `REGISTRATION_INVITE_CODE` to enable shared-code registration;
admins can also issue expiring, single-use invitations.

For upgrades, backups, password resets, and health checks, use
[docs/operations.md](./docs/operations.md). Read [docs/security.md](./docs/security.md) before
exposing a deployment to the internet.

## Configuration

Compose settings are documented in [.env.docker.example](./.env.docker.example); local-development
settings live in [.env.example](./.env.example).

| Variable                                  | Required | Default                 | Purpose                                                    |
| ----------------------------------------- | -------- | ----------------------- | ---------------------------------------------------------- |
| `PUBLIC_URL`                              | Yes      | `http://localhost:3000` | Browser-visible origin; rebuild images after changing it   |
| `POSTGRES_PASSWORD`                       | Yes      | —                       | PostgreSQL password; production rejects placeholders       |
| `SESSION_SECRET`                          | Yes      | —                       | Session and capability-key derivation                      |
| `CREDENTIAL_ENCRYPTION_KEY`               | Yes      | —                       | `base64:`-prefixed 32-byte AES-256-GCM key                 |
| `REGISTRATION_INVITE_CODE`                | No       | empty                   | Shared registration code; blank disables `/register`       |
| `GEMINI_API_KEY`                          | No       | empty                   | Enables included Film Room access                          |
| `MANAGED_AI_DAILY_REQUEST_LIMIT`          | No       | `50`                    | Included AI requests per member per UTC day                |
| `MANAGED_AI_MAX_OUTPUT_TOKENS`            | No       | `2000`                  | Included AI response limit                                 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`  | No       | empty                   | Enables game day push alerts; blank disables them cleanly  |
| `VAPID_SUBJECT`                           | No       | empty                   | `mailto:` or `https:` contact required with the VAPID keys |
| `NEXT_PUBLIC_CONTACT_EMAIL`               | No*      | empty                   | Public operator contact; set before internet exposure      |
| `NEXT_PUBLIC_YAHOO_ACCESS_STATUS`         | No       | `pending`               | Controls the public **Coming Soon** state                  |
| `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | No       | empty                   | Yahoo OAuth credentials, API server only                   |
| `SITE_ADDRESS`                            | No       | `:80`                   | Included Caddy site address                                |
| `APP_PORT` / `HTTPS_PORT`                 | No       | `3000` / `3443`         | Included gateway host ports                                |
| `POSTGRES_PORT`                           | No       | `55432`                 | Loopback-only PostgreSQL maintenance port                  |
| `LOG_LEVEL`                               | No       | `info`                  | API and worker log level                                   |

For a standalone public deployment, point a domain at the host and set `PUBLIC_URL`,
`SITE_ADDRESS`, `APP_PORT`, and `HTTPS_PORT` as described in `.env.docker.example`.

## Architecture

```text
Browser ──> Caddy ──> Next.js web
                  └─> Fastify API ──> PostgreSQL
                                      ↑
Provider and NFL sources ──> adapters ─┴─ pg-boss worker
                                      └─ decision engines
```

- `apps/web` — responsive Next.js 16 PWA
- `apps/api` — authentication, provider sync, ingestion, and REST endpoints
- `apps/worker` — refresh schedules, forecast sweeps, markets, and job processing
- `apps/espn-bridge` — Manifest V3 companion for private ESPN league sync
- `packages/*` — provider adapters, domain contracts, projections, rankings, security, and
  draft/lineup/waiver/trade engines

Provider code ends at its adapter. Recommendation engines consume normalized, source-stamped domain
data rather than raw provider payloads.

## Development

Requires Node.js `>=22.22 <25`, Docker, and PostgreSQL 17+.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate -w @fantasy/db
npm run dev
```

Web runs at <http://localhost:3000>; the API runs at <http://localhost:4000>.

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Start web, API, and worker with live reload          |
| `npm run check`      | Format, lint, typecheck, tests, and production build |
| `npm run test`       | Run the Vitest suite                                 |
| `npm run test:watch` | Run Vitest in watch mode                             |
| `npm run build`      | Build API, worker, ESPN companion, and web           |
| `npm run format`     | Apply Prettier formatting                            |

Database-backed smoke commands and the release runbook live in
[docs/operations.md](./docs/operations.md).

## Security and privacy

- Provider access is read-only; the ESPN path never asks for a password.
- Accounts use Argon2id hashes and revocable server-side sessions with secure production cookies.
- Provider credentials use versioned AES-256-GCM envelopes; bridge devices are independently
  revocable.
- Push devices are listed and revoked per member; their endpoints and keys are never returned by an
  API response, never logged, and pruned automatically when a push service reports them gone.
  Notifications carry only league facts the member can already see.
- Logs redact secrets, cookies, authorization headers, and OAuth callback values.
- AI providers receive no credentials, tools, or write capability; prompts and answers are not
  persisted.

See [docs/security.md](./docs/security.md) and [docs/privacy.md](./docs/privacy.md).

## Provider status

| Provider   | Status                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| **ESPN**   | Private leagues sync through the bookmark or browser companion; passwords and cookies stay in the browser        |
| **Yahoo**  | Official read-only OAuth and sync are implemented; deployments show **Coming Soon** until the feature is enabled |
| **Writes** | Disabled everywhere; Laces Out recommends and deep-links, and members complete actions at the provider           |

Provider evidence and limitations live in [docs/provider-notes/](./docs/provider-notes/).

## Status

Weekly managed projections are the production forecast source. Rest-of-season output is served only
for cells that pass their evidence gates; demo data is always labeled. Ongoing work focuses on
provider hardening, refresh and notification depth, live-draft support, recommendation validation,
and operational resilience.

## Documentation

| Document                                                                           | Purpose                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| [docs/operations.md](./docs/operations.md)                                         | Deployment, backups, health, and operator runbook |
| [docs/security.md](./docs/security.md)                                             | Threat model and hardening baseline               |
| [docs/privacy.md](./docs/privacy.md)                                               | Operator privacy source of truth                  |
| [docs/ros-v6-2026-untouched-protocol.md](./docs/ros-v6-2026-untouched-protocol.md) | Frozen final-proof protocol for the ROS engine    |
| [docs/provider-notes/](./docs/provider-notes/)                                     | Provider evidence and constraints                 |
| [apps/espn-bridge/README.md](./apps/espn-bridge/README.md)                         | Browser companion pairing and store submission    |
| [packages/projections/README.md](./packages/projections/README.md)                 | Model internals and evaluation methodology        |

## License

[MIT](./LICENSE)
