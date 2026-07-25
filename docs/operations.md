# Operations runbook

## Services

- `web`: responsive Next.js application;
- `api`: REST API, health checks, provider callbacks, and authenticated application services;
- `worker`: pg-boss queues and schedules for daily/startup/on-demand player identity, schedules,
  weekly player/team stats, weekly rosters, snap counts, Sleeper status, and contextual ADP; hourly Sleeper market
  signals; an hourly first-party weekly-forecast sweep; a quarter-hour lineup-lock notification
  sweep; and quarter-hour source health checks.
  Provider sync, manual projection import, and recommendation reads still execute through their
  current API workflows. The projection-refresh queue is implemented; league-sync and
  recommendation-recompute still fail closed when queued until their worker services are wired;
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
use the fixed `gemini-3.6-flash` model, default to 50 requests per member per UTC day, and cap
answers at 2,000 tokens. Adjust `MANAGED_AI_DAILY_REQUEST_LIMIT` or
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

A member who still knows their password changes it themselves at `/settings`, which keeps their
current session and signs out their other devices. The command below is for the case they cannot
sign in at all.

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
npm run yahoo:smoke -w @fantasy/api
npm run invitation:smoke -w @fantasy/api
npm run registration:smoke -w @fantasy/api
npm run runtime:smoke
```

The API smoke checks use invented data inside forced-rollback transactions. They verify that the
first accepted bridge snapshot for a previously unknown ESPN season becomes owner while merely
configuring a league-ID scope grants nothing. A successful validated provider sync automatically
joins a later connector as manager, every joined member can refresh shared state, and monotonic
snapshot time prevents stale replacement. The bridge also
verifies cross-user isolation, canonical-player preservation, non-verified observation quarantine,
idempotency, and last-good rollback; two Yahoo accounts remain isolated while linking the same league, atomically
preserve snapshots, and deduplicate only same-account replays; invitation capabilities hash and
consume once; and shared-code registration stores only password/session hashes. They never print a
device, invitation, registration, or session credential.
`npm run catalog:refresh -w @fantasy/worker` is an explicit live source check that downloads the
nflverse player catalog and updates the configured database. The normal shared-data queue checks
the four-season model window for weekly stats, weekly rosters, and snap counts after refreshing
canonical IDs.
Unpublished active-season artifacts remain pending instead of marking the completed-season source
as failed. Each admitted checksum creates immutable observations linked to its ingestion run;
replay is idempotent, and unresolved GSIS/PFR identities remain queryable as quarantined rows.

The daily draft-market job checks Fantasy Football Calculator at 05:47 UTC for standard,
half-PPR, and PPR leagues of 8, 10, 12, and 14 teams. It publishes a context only when canonical
identity coverage meets the configured threshold. The authenticated Data Health controls can
request both shared NFL data and draft-market checks without waiting for the schedule.

## First-party weekly forecasts

The projection queue runs at minute 11 every hour in UTC. A second game-aware schedule checks every
ten minutes but does model work only within 130 minutes of the next known, unresolved kickoff. In
that near-lock window, current-season nflverse and Sleeper availability inputs use 30-minute
conditional checks; the final pass inside ten minutes of kickoff forces one last source check.
Before modeling, the worker asks the current-season nflverse player-stat, team-stat, weekly-roster,
injury-report, and snap sources, every schedule season in the training window, and the Sleeper
status catalog to refresh. Conditional claims make unchanged checks cheap and prevent overlapping
workers from publishing a mixed in-flight snapshot. The daily 05:17 UTC shared-data job refreshes
the full training window; its successful completion also queues a projection sweep. An
authenticated **Check NFL data** or Projection Lab **Check inputs & rerun** request forces the same
input sweep and queues the model without waiting for cron.

Each model run pins exact immutable source checksums for four seasons, a target season/week, and a
model version. An unchanged aggregate checksum is a no-op only after the worker verifies that the
corresponding immutable model run, raw component observations, and managed league projection sets
still exist. Missing, stale, unavailable, actively refreshing, coverage-rejected, or internally
inconsistent inputs fail closed. A scheduled game with no trustworthy kickoff also withholds that
week. Once a game begins, its last pre-kickoff raw and league-scored rows are authoritative; later
status or source changes cannot rewrite them. A failed or degraded candidate does not overwrite
the last-known-good managed projection set. An unchanged evaluation updates its check time without
pretending the older artifact was republished. The queue retries four times with exponential
backoff up to 30 minutes and retains exhausted jobs in `projection-refresh-dead-letter`.

Publication is also gated by locked, strictly prior out-of-sample evaluation. Player forecasts are
selected per position between the richer contextual model and its transparent recency-only
challenger using that league's scoring rules. By default, the richer model must reduce MAE by at
least 2% for that position across at least 100 predictions and eight completed week batches. Until it
does, recency remains the live strategy. Position-level publication also requires at least 100
scored targets, at least 100 walk-forward interval observations, 62–78% coverage for the nominal
70% interval, no regression against the recency challenger, and bounded residual bias. The
walk-forward backtest applies only the policy available before each whole week. The final selected
strategy is then replayed on the same locked forecasts for release evidence and live calibration.
Point centers use the latest eight completed batches, intervals are rebuilt from corrected prior
residuals, and partially
completed target-week results are excluded. D/ST is evaluated separately and must beat or tie its
recency baseline. Unknown, nonlinear, IDP, bonus, override, or otherwise unsafe scoring mappings
withhold only the affected league publication rather than applying a guessed score. Projection Lab
shows model/input timestamps, training cutoff, coverage, warnings, and backtest metrics; the exact
champion policy remains attached to the managed-set audit metadata. These are weekly forecasts, not
calibrated rest-of-season values. Automatic runs publish only the two earliest actionable weeks;
explicit week requests remain available for research. A successful ESPN or Yahoo league sync queues
the same deduplicated refresh immediately. Expensive locked training artifacts are cached while
their statistical inputs remain unchanged, so roster and scoring updates only redo league work.

The current v7 release reference is the official 2023–2025 replay from 2026-07-21: 9,261 player
outcomes and 1,632 D/ST outcomes passed the exact worker gate. QB/RB/WR/TE/K all defended the
availability-aware recency rail; the contextual challenger remained shadow-only. Player MAE was
4.4065 with 71.02% coverage for the nominal 70% point interval and -0.1074 point bias. D/ST MAE was
4.3193 versus 4.5309 for its baseline, with 71.69% interval coverage. Reproduce the full official
audit with `npm run projections:validate -w @fantasy/worker -- --summary`; expect several minutes
of CPU time because the command deliberately rebuilds every locked batch.

After each weekly sweep, the worker also runs the rest-of-season shadow auditor against the latest
immutable schedule and weekly artifacts. It intentionally records only a degraded model-run audit:
publication remains disabled until at least three fully held-out evidence seasons, 30 season/cutoff
batches, 300 paired outcomes, season-blocked split-conformal interval evidence evaluated on a later
untouched season, complete future-week centers, and persisted paired candidate inputs all exist.
Each position and horizon cell must independently span three seasons, three distinct cutoff weeks,
nine season/cutoff blocks, and 18 paired outcomes. Sparse cells remain withheld. A shadow run never
replaces the last good weekly set and is not visible to lineup, waiver, trade, draft, API, or UI
consumers.

The current ROS admission reference is the v4 read-only official nflverse replay run on
2026-07-21 (2019–2025 sources, 2022–2025 held out, all 17 cutoffs, five deterministic
recent-production quantiles per position, 2,040 paired forecasts, 68/68 batches, zero skips). It
reduced the original 41 release blockers to 4: interval-coverage shortfalls in QB
five-to-eight/nine-plus and K one-to-four/five-to-eight. Convergence passed 144/144 strata at the
8192-vs-16384 diagnostic and availability passed every cell under gate v2 (MAE ≤ 1.5 short/mid,
≤ 2.75 nine-plus, |signed bias| ≤ 1.0 — ratified 2026-07-21 on measured oracle-floor evidence; the
derivation lives beside the constants in `packages/projections/src/rest-of-season.ts`). Model v6 (static center-error component plus corrected two-moment calibration, 12288 release
paths) targets the four remaining coverage cells. The official v6 + gate-v3 replay (2026-07-22) leaves exactly one blocker — K one-to-four
interval coverage — with the admission-ready report preserved at
`reports/ros-validation-v6-2026-07-22.json`; under the ratified per-cell admission policy, every
other cell is releasable once an artifact is provisioned. The 2022–2025 corpus is
development evidence — the untouched release proof is the frozen protocol in
`docs/ros-v6-2026-untouched-protocol.md`, runnable only after the 2026 season resolves. ROS stays
shadow-only until an artifact is provisioned through `npm run ros:admit -w @fantasy/worker`
(explicit `--database-url` and `--confirm`, refuses on any blocker).

Model v7 (kicker count-process, 2026-07-22) replaced the lognormal shock for kickers with a
calibrated integer count process on the five scored components. Its full replay
(`reports/ros-validation-v7-2026-07-22.json`) kept all 15 non-K cells byte-identical to v6 with
no new blocker and moved raw K short-window coverage to nominal, but K one-to-four still failed
walk-forward block coverage — root-caused to weekly-model kicker centers under roster churn, not
the interval family.

Weekly model v8 (2026-07-23) fixed that root cause: the kicker recency baseline blends
thin-history kickers toward the position mean with the pre-existing n/(n+4) reliability form (no
new constants), and the kicker p50 convergence tolerance was declared at the integer lattice
spacing (owner-ratified). The v8 replay (`reports/ros-validation-v8-2026-07-23.json`, source
lineage attached post-run with verification — see `sourceLineageNote` inside) is the project's
first **zero-blocker** report: every cell releasable, K one-to-four cleared at 1/4 walk-forward
blocks, convergence 144/144. The champion artifact (`67e7ba09…655d5d`, engine
`laces-ros-distribution-v7` + weekly `laces-weekly-components-v8`) was admitted 2026-07-23 with
zero cell blockers, superseding v6 under latest-admitted-wins. Deploy note: the version-bump
re-seeds every simulation through the weekly fingerprint → input checksum → seed chain, so
post-deploy ROS numbers legitimately differ draw-level from v6's while remaining
distribution-identical for non-K positions. The pre-registered 2026 kicker-cell addendum is
Amendment 1 of the untouched protocol.

Completed weekly-roster membership supplies the evaluation spine for recently relevant players who
recorded neither a stat nor a snap. Those known DNP outcomes are scored as zero but excluded from
later role training. Announced inactive/reserve/suspended roster states produce a pregame zero;
unexplained active-roster DNPs remain genuine forecast errors. This avoids survivorship bias without
teaching the model that an absence was a played-game role collapse.

Operator checks after a projection change:

```bash
npx vitest run packages/projections/src/first-party.test.ts \
  packages/projections/src/rest-of-season.test.ts \
  apps/worker/src/first-party-projections.test.ts \
  apps/worker/src/first-party-projection-inputs.test.ts \
  apps/worker/src/first-party-ros-backtest.test.ts \
  apps/worker/src/projection-lock-window.test.ts
npm run projections:validate -w @fantasy/worker -- --seasons=2023,2024,2025
npm run ros:coverage -w @fantasy/worker -- --summary
npm run ros:validate -w @fantasy/worker -- --allow-incomplete
npm run typecheck
npm run build -w @fantasy/worker
```

The ROS validator is intentionally expensive: the v4 reference run took about 2.7 hours on one CPU
core (four season-locked policies, 2,040 12288-path forecasts at current defaults, and 144
16384-path convergence references). It writes progress phases to stderr and final JSON to stdout —
redirect stdout to keep a report; nothing is written to disk otherwise. The
`--allow-incomplete` flag keeps a diagnostic run at exit zero while preserving `report.state` and
all blockers; omit it for a release check, where any blocker must produce a non-zero exit. The
validator downloads official artifacts directly and performs no database writes.

Inspect the signed-in Data Health and Projection Lab screens after the worker starts. A current
process health check is not sufficient: confirm the input check time, successful compute time,
training cutoff, target week, quality state, and league scoring warnings. Do not delete immutable
source observations or model runs to recover a bad forecast. Disable the affected `data_sources`
row or stop the worker, preserve the prior good set, diagnose the source/model artifact, and resume
with a forward-only code or schema correction.

## Game day alerts (web push)

Off by default, and cleanly off: with no VAPID keys the API answers `GET /v1/push/config` with
`{ "available": false, "publicKey": null }`, refuses registration and test sends with 503, Settings
renders a labeled **Not configured by the operator** panel, and the scheduled worker sweep completes
as a no-op with `skipped: "vapid-keys-not-configured"`. No device rows are created and nothing is
sent. Existing deployments need no action.

To turn it on, generate one key pair, keep it for the life of the deployment, and set all three
variables on the API and worker (the Compose stack does this from one shared block):

```bash
npx web-push generate-vapid-keys
```

```bash
VAPID_PUBLIC_KEY=<publicKey from the command above>
VAPID_PRIVATE_KEY=<privateKey from the command above>
VAPID_SUBJECT=mailto:you@example.com   # or an https: URL a push service can contact
```

Startup rejects a partially configured identity: all three or none. The private key is server-side
only — never prefix either key with `NEXT_PUBLIC_` and never pass one as a Docker build argument.
Rotating the pair invalidates every stored device; members re-enable alerts from `/settings`, and
the old rows are pruned automatically the first time a send returns 410 Gone.

Members opt in per device at `/settings` → **Game day alerts**. Notification permission is requested
from that toggle and nowhere else. Each device is listed and independently revocable, exactly like an
ESPN bridge device; the list never shows the endpoint or its keys, and neither the API nor the worker
writes them to a log.

What the alarm actually checks, from stored data only, for each member with a claimed team and at
least one registered device:

- a starter whose stored, normalized status is `OUT`, `IR`, or `DOUBTFUL` — the same status the
  Decision Desk renders. Provider spellings outside that shared vocabulary are not translated, so the
  alert can never assert something the rest of the app does not show;
- a starter on a bye, asserted only where the admitted schedule affirms coverage for both the team
  and the week and the read rejected no rows — the project-wide bye rule, reused rather than
  restated;
- a required starting slot left empty, counted against the season's starter slot rules.

Send windows are anchored to the earliest stored kickoff, in the league's current week, of a game
involving a team on that member's starting lineup: a digest between 24 and 2 hours out, then a final
warning inside 2 hours. Without a trustworthy stored kickoff nothing is sent, because there is no
honest lead time to state. Every send is claimed first in `notification_deliveries` under
`lineup-lock:<userId>:<leagueId>:<season>:<week>:<window>`, whose unique index is what makes a
re-run, a restart, or two overlapping schedules send exactly once.

The sweep runs at minutes 4, 19, 34, and 49 UTC on the `notification-sweep` queue and dead-letters
to `notification-sweep-dead-letter`. Its log line carries counts only — never a recipient, a device,
or notification text. Alerts read the last synced roster, not the provider, and say how old that
roster is; on iOS, web push is delivered only to a PWA installed to the Home Screen.

## Current authentication baseline

The implemented application identity is local email/password authentication. Passwords are hashed
with Argon2id, sessions are server-side and revocable, and production cookies are HTTP-only,
same-site, and secure. For internet sharing, terminate TLS through the included Caddy gateway (or an
equivalent trusted edge); plain HTTP is supported only for loopback development. OIDC, passkeys,
and MFA are not configurable features today. They remain future hardening for broader exposure,
not prerequisites the current runbook silently assumes are already installed.

## Provider release gates

- Yahoo friend access remains Coming Soon until the operator completes the current provider terms,
  configuration, and real-account contract-validation checklist.
- ESPN companion distribution requires sanctioned private-league validation, terms and store-policy
  review, and a signed build. The signed browser bridge is the only hosted private-league path.
- ESPN live draft sync stays behind `ESPN_LIVE_DRAFT_SYNC=false` until the live validation matrix in
  `docs/ESPN_LIVE_DRAFT_SYNC_PLAN.md` §19.4 passes — a full snake mock, a disposable auction draft,
  reload/late-join, pause/resume, a deliberate rollback, source failover, a mobile viewer, and a
  completed `mDraftDetail` cross-check. The DOM adapter's selector table is unverified until then.
  Landing-page copy may not claim the capability before that gate.
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
- On a bad live draft feed: set `ESPN_LIVE_DRAFT_SYNC=false` and restart the API. New provider
  observations stop mutating draft state while accepted events, the last known feed state, manual
  backup mode, and ordinary ESPN core/supplemental sync all keep working. Never delete or rewrite
  accepted draft history as a first recovery action; reconcile against the completed `mDraftDetail`
  snapshot before closing an affected draft.
