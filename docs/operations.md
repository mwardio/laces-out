# Operations runbook

## Services

- `web`: responsive Next.js application;
- `api`: REST API, health checks, provider callbacks, and authenticated application services;
- `worker`: pg-boss queues and schedules; today its implemented data-changing job is the daily,
  startup-recovery, and authenticated on-demand nflverse player-catalog check. Provider sync,
  manual projection import, and recommendation reads execute through their current API workflows;
  the other worker handlers are queue scaffolding, not completed orchestration;
- `postgres`: canonical state, audit trail, and pg-boss queues.

## Docker Compose deployment

The root `Dockerfile` has distinct `web`, `api`, `worker`, and one-shot `migrate` targets. The
Compose stack binds PostgreSQL only to host loopback, blocks application startup until migrations
complete, and exposes one Caddy gateway so browser cookies, OAuth callbacks, the web UI, and the
API share an origin.

Fastify logs only request paths, never query strings. Caddy also replaces Yahoo OAuth `code` and
`state` query values before writing access or upstream-error logs. Preserve both controls when
changing either proxy or logger configuration.

```bash
cp .env.docker.example .env
# Replace every `replace-with-...` value. Useful generators are documented in that file.
docker compose config --quiet
docker compose up --build -d --wait
curl --fail "${PUBLIC_URL:-http://localhost:3000}/health/ready"
```

Production startup rejects copied `replace-with-...` placeholders and the Compose database's
default `fantasy` password. This is intentional: fill in every secret before expecting the stack to
become healthy.

To make Film Room available without member setup, set `GEMINI_API_KEY` in `.env` to a Google AI
Studio key restricted to the Gemini API. The key is passed only to the API container. Managed calls
use the fixed `gemini-3.1-flash-lite` model, default to 50 requests per member per UTC day, and cap
answers at 900 tokens. Adjust `MANAGED_AI_DAILY_REQUEST_LIMIT` or
`MANAGED_AI_MAX_OUTPUT_TOKENS` only after reviewing the project's current limits in AI Studio.
Never prefix the key with `NEXT_PUBLIC_` or pass it as a Docker build argument.

Create the first administrator only after migrations are healthy. Supply its password
ephemerally; do not add it to `.env`:

```bash
read -rsp "Owner password: " OWNER_PASSWORD && echo
docker compose run --rm --no-deps \
  -e OWNER_EMAIL="owner@example.com" \
  -e OWNER_DISPLAY_NAME="League Admin" \
  -e OWNER_PASSWORD="$OWNER_PASSWORD" \
  migrate node apps/api/dist/create-owner.js
unset OWNER_PASSWORD
```

If a member forgets a password, the operator can reset it without editing PostgreSQL directly. The
command invalidates every existing session for that account. Supply the new password ephemerally:

```bash
read -rsp "New account password: " ACCOUNT_NEW_PASSWORD && echo
docker compose run --rm --no-deps \
  -e ACCOUNT_EMAIL="member@example.com" \
  -e ACCOUNT_NEW_PASSWORD="$ACCOUNT_NEW_PASSWORD" \
  migrate node apps/api/dist/reset-password.js
unset ACCOUNT_NEW_PASSWORD
```

The command deliberately does not print the account email or password. Confirm the intended email
before running it; the member must sign in again on every device.

For local use, keep `SITE_ADDRESS=:80` and `PUBLIC_URL=http://localhost:3000`. For internet
sharing, point a domain at the host and set `SITE_ADDRESS`, `PUBLIC_URL`, `APP_PORT=80`, and
`HTTPS_PORT=443` as shown in `.env.docker.example`; Caddy then obtains and renews TLS
automatically. Rebuild after changing `PUBLIC_URL` because the browser-visible API origin is
compiled into the Next.js bundle. Set `NEXT_PUBLIC_CONTACT_EMAIL` to the operator address used in
the provider application; it is compiled into the public footer, privacy policy, and terms. Do not
expose the stack over plain HTTP to friends.

Useful lifecycle commands:

```bash
docker compose ps
docker compose logs -f --tail=200 api worker
docker compose up --build -d --wait       # migrate and deploy an update
docker compose down                       # preserves database and Caddy volumes
```

`docker compose down --volumes` permanently deletes the PostgreSQL and Caddy volumes; it is not
an ordinary shutdown command.

## Health

- API liveness: `GET /health/live`
- API readiness: `GET /health/ready`
- Data health is separate from process health. A running API may still show a stale or reauthorization-required provider.

Readiness includes a database query. Provider outages should degrade a connection, retain the last good snapshot, and not make the whole API unready.

## Registration access

- `REGISTRATION_INVITE_CODE` blank: shared-code registration returns unavailable.
- `REGISTRATION_INVITE_CODE` set: `/register` creates member accounts; `SESSION_SECRET` must also be
  set and stable.
- Generate a high-entropy 16–128 character code, share it outside application logs, and rotate or
  blank it after the invited group is onboarded. Rotation does not invalidate existing sessions.
- Registration attempts are limited to 30 per source IP every ten minutes, allowing a small draft
  party to share one home network without leaving an unbounded password-hashing endpoint. When running behind a
  reverse proxy, keep the API trust-proxy boundary restricted to the configured gateway so the
  client address cannot be spoofed.

Database-backed release checks:

```bash
npm run db:migrate -w @fantasy/db
npm run db:smoke -w @fantasy/db
npm run bridge:smoke -w @fantasy/api
npm run espn:import:smoke -w @fantasy/api
npm run yahoo:smoke -w @fantasy/api
npm run invitation:smoke -w @fantasy/api
npm run registration:smoke -w @fantasy/api
npm run runtime:smoke
```

The API smoke checks use invented data inside forced-rollback transactions. They verify that the
first accepted bridge or manual snapshot for a previously unknown ESPN season becomes owner while
an arbitrary league-ID scope cannot auto-enroll an outsider or manager, and that an established
commissioner can replace shared state; canonical ESPN recovery
enforces preview and confirmation checksums, owner/commissioner replacement, cross-user isolation,
canonical-player preservation, non-verified observation quarantine, idempotency, and last-good
rollback; two Yahoo accounts remain isolated while linking the same league, atomically
preserve snapshots, and deduplicate only same-account replays; invitation capabilities hash and
consume once; and shared-code registration stores only password/session hashes. They never print a
device, invitation, registration, or session credential.
`npm run catalog:refresh -w @fantasy/worker` is an explicit live
source check that downloads nflverse player data and updates the configured database.

## Current authentication baseline

The implemented application identity is local email/password authentication. Passwords are hashed
with Argon2id, sessions are server-side and revocable, and production cookies are HTTP-only,
same-site, and secure. For internet sharing, terminate TLS through the included Caddy gateway (or an
equivalent trusted edge); plain HTTP is supported only for loopback development. OIDC, passkeys,
and MFA are not configurable features today. They remain future hardening for broader exposure,
not prerequisites the current runbook silently assumes are already installed.

## Provider release gates

- Yahoo friend access requires application approval, a current executed access agreement that
  permits the intended presentation, and real-account contract validation with sanitized fixtures.
- ESPN companion distribution requires sanctioned private-league validation, terms and store-policy
  review, and a signed build. Canonical manual import remains the recovery path.
- Neither gate enables provider writes. Lineup, waiver, and trade changes remain recommendation-only
  until separately approved, implemented, and shadow-validated.

## Backup

1. Take a daily encrypted custom-format PostgreSQL dump to a path outside the repository.
2. Copy it to encrypted off-host storage with retention.
3. Take an additional backup immediately before schema migrations.
4. Never include `.env`, an encryption key, ESPN cookies, or unredacted provider artifacts in an ordinary archive.
5. Quarterly, restore the latest backup to a clean PostgreSQL instance and run migration plus integrity checks.

For the Compose deployment, a custom-format backup can be streamed without exposing PostgreSQL:

```bash
docker compose exec -T postgres pg_dump -U fantasy -d fantasy -Fc > "laces-out-$(date +%F).dump"
```

Encrypt and move the resulting file off-host. Test restores against a separate database or
isolated Compose project; never overwrite the live volume to test a backup.

Targets are RPO 24 hours and RTO 2 hours for this personal deployment.

## Update

1. Review the implementation plan/migration notes and provider capability changes.
2. Run `npm ci && npm run check` against the proposed version.
3. Create and verify a pre-migration backup.
4. Apply migrations as an explicit one-shot operation.
5. Start API/worker/web and verify liveness, readiness, worker startup/catalog scheduling, login,
   and one read-only provider sync through its provider-specific workflow.
6. Keep the previous image/source revision until validation completes.

## Provider incident

- On 401/403: stop retries, mark `reauthorize`, and preserve last good data.
- On 429: honor `Retry-After`, apply jittered backoff, and coalesce jobs.
- On schema drift: quarantine the artifact, fail the affected resource without partial overwrite, and surface manual mode.
- On suspected token exposure: disconnect/revoke at the provider, rotate app/client secrets if needed, delete credential envelopes, invalidate app sessions, and inspect redacted audit events.
- During a draft: fall back immediately to manual event entry; provider recovery may reconcile later but cannot silently overwrite a manual correction.
