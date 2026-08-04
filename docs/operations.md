# Operations runbook

## Services

- `web`: responsive Next.js application;
- `api`: REST API, health checks, provider callbacks, and authenticated application services;
- `worker`: pg-boss queues and schedules for daily/startup/on-demand player identity, schedules,
  weekly player/team stats, weekly rosters, snap counts, Sleeper status, and contextual ADP; hourly Sleeper market
  signals; an hourly first-party weekly-forecast sweep; a quarter-hour lineup-lock notification
  sweep; quarter-hour source health checks; and a bounded five-minute ESPN refresh-intent expiry and
  direct-capability sweep.
  Provider sync, projections, recommendation recomputation, and notification sweeps all have
  concrete worker services and fail closed when a required dependency is unavailable;
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

## Operator automation

For an always-on deployment, monitor both the public readiness endpoint and a worker heartbeat
derived from a completed `data-health-check` job. Five-minute availability checks and a 50-minute
worker-heartbeat threshold cover web/API failures, a stalled scheduler, and one legally long cold
projection rebuild without treating one provider timeout as a site outage. Source and dead-letter alerts should be transition-based: alert
when a condition appears, stay quiet while it is unchanged, and send one recovery notice when it
clears. A short daily digest is useful even when every check passes.

Create a PostgreSQL custom-format dump every night, verify the archive with `pg_restore --list`,
retain a bounded local history, and periodically restore the newest dump into a disposable database
and run integrity queries. When the destination is a dedicated disk, fail closed unless that disk is
actually mounted so a boot-order problem cannot redirect backups onto the system volume. A dump
stored beside the server is fast recovery, not an off-site backup; copy it to separately controlled
storage when the deployment matters beyond one machine.

During the season, record a Wednesday scorecard from the newest publishable model batch: player and
D/ST MAE, bias, nominal-70% interval coverage, per-position challenger versus baseline, and sample
counts. Run the locked validators after model or input-code changes (plus a low-frequency monthly
backstop), retain their raw reports, and never promote a model automatically. The publication gate,
not the scheduler, remains the authority on what reaches members.

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
current session, signs out their other devices, and invalidates every outstanding browser handoff,
including one created from the retained session. The command below is for the case they cannot sign
in at all.

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
before running it; the member must sign in again on every device. Deleting every session also
cascades any handoff bound to one of those sessions.

## Member data export and deletion

Signed-in members manage their data at the direct destination `/settings#account-data`:

- **Download my data** calls authenticated `GET /v1/account/export` and downloads a versioned JSON
  file. The response is `no-store` and excludes passwords, bearer material, provider/AI key
  envelopes, push endpoints/keys, and share capabilities.
- **Permanently delete my account** calls authenticated `DELETE /v1/account` only after
  current-password reauthentication and the exact `DELETE MY ACCOUNT` confirmation. The API clears
  the cookie after the transaction, the account/session cascade invalidates outstanding browser
  handoffs, and the web app confirms the signed-out result at `/account-deleted`.

Deletion transfers an owned league with surviving members to a commissioner first, then a manager,
then a viewer, with oldest membership as the tie-break. It deletes a sole-member league. Private
member artifacts and all credentials cascade; shared league facts, league-visible projections,
immutable change events, and append-only usage/audit facts retain no direct deleted-user attribution.
League Intel text last written by the member and Weekly Reckoning recap text generated by that
member are deleted as authored content. One anonymous `account.deleted` audit record stores only
deletion/transfer/preservation counts and the request correlation identifier.

There is no operator-side soft-delete queue and no undo in the live database. Document the actual
encrypted-backup rotation for the deployment and honor exceptional access/deletion requests for a
member who cannot sign in. Never restore one deleted account from a full backup into the live
service; doing so would also restore revoked sessions and credential material.

## Native-to-browser authenticated handoff

The native app can open an authenticated web-only tool without asking the member to type the
password again:

1. authenticated `POST /v1/auth/browser-handoffs` accepts one exact allowlisted relative
   destination and creates a 256-bit, two-minute bearer. In the same transaction, PostgreSQL locks
   the target user, verifies the exact source session token hash, owner, and expiry, and stores that
   session UUID under an `ON DELETE CASCADE` foreign key. It stores only the new bearer digest and
   replaces any older handoff for that member;
2. the returned URL carries the bearer in the fragment, which is never part of an HTTP request or
   `Referer`; the API-hosted landing document has no external resources, removes the fragment from
   history immediately, and sends it once in the redacted JSON body of the staging request;
3. staging atomically rotates the digest, returns a masked target-account hint, and sets a new
   one-minute bearer in an HttpOnly, `SameSite=Strict` cookie scoped to the handoff route family.
   The landing page stops here and shows **Continue as _masked account_**; it does not navigate to
   consumption automatically;
4. the button sends `POST /v1/auth/browser-handoff/confirm`. The server rechecks the still-active
   source binding and persists the confirmation; only a confirmed row can be consumed; and
5. `GET /v1/auth/browser-handoff/consume` locks the target user and source session, deletes the
   one-time row, clears the handoff cookie, and returns a `303` with
   `Referrer-Policy: no-referrer`. It reuses an active same-user browser session without replacing
   its cookie. A different user's active browser session causes a generic refusal after the
   capability is burned, while that ordinary session remains untouched. With no valid ambient
   session, the transaction inserts the new revocable browser session before releasing the source
   lock.

An expired capability always fails closed. The one-row-per-user record is replaced by the next
creation and disappears when its source session is deleted. Native logout therefore cascades its
bound handoff; password change explicitly invalidates all handoffs even when it retains the source
session; and account deletion cascades the account's sessions and handoffs. Creation, staging, and
confirmation are rate limited. Request logging strips query strings and redacts `req.body.token`
and cookie headers; do not add proxy body logging.

The handoff is enabled and advertised only when `API_URL` and `WEB_URL` have the same scheme and
hostname (different local-development ports are supported). A host-only API session cannot safely
power a differently hosted web origin. Split-host operators must route both surfaces through one
canonical HTTPS gateway; until then `/health/ready` omits `authenticated-browser-handoff` and the
creation endpoint returns `503`.

For local use, keep `SITE_ADDRESS=:80` and `PUBLIC_URL=http://localhost:3000`. For internet
sharing, point a domain at the host and set `SITE_ADDRESS`, `PUBLIC_URL`, `APP_PORT=80`, and
`HTTPS_PORT=443` as shown in `.env.docker.example`; Caddy then obtains and renews TLS
automatically. Rebuild after changing `PUBLIC_URL` because the browser-visible API origin is
compiled into the Next.js bundle. Set `NEXT_PUBLIC_CONTACT_EMAIL` to the operator address used in
the provider application; it is compiled into the public footer, privacy policy, and terms. Do not
expose the stack over plain HTTP to friends.

When a host-level reverse proxy already owns ports 80 and 443, set
`GATEWAY_BIND_ADDRESS=127.0.0.1`, leave `SITE_ADDRESS=:80`, and forward the public HTTPS origin to
`http://127.0.0.1:${APP_PORT:-3000}`. Keep `PUBLIC_URL` on the public HTTPS origin, preserve the
original host and scheme headers, and publish only the bundled gateway. The API, web, and
PostgreSQL services are not independent public entry points. Leave `GATEWAY_BIND_ADDRESS=0.0.0.0`
when the bundled gateway itself terminates public traffic.

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

Readiness includes a database query plus the public native compatibility declaration:
`service: "fantasy-api"`, `mobileApiVersion: 1`, and the bounded `mobileCapabilities` identifier
array. Native clients must check the service and minimum version before accepting a self-hosted
origin. `authenticated-browser-handoff` appears only when the canonical API/web topology can honor
its host-only cookie contract. Provider outages should degrade a connection, retain the last good
snapshot, and not make the whole API unready.

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
Before modeling, the worker asks the canonical nflverse player catalog, current-season player-stat,
team-stat, weekly-roster, injury-report, and snap sources, every schedule season in the training
window, and the Sleeper status catalog to refresh. Conditional claims make unchanged checks cheap
and prevent overlapping workers from publishing a mixed in-flight snapshot. Including the player
catalog in every projection cycle is deliberate: a failed daily catalog request is retried when its
source clock is due instead of withholding forecasts until the next day. The daily 05:17 UTC
shared-data job refreshes the full training window; its successful completion also queues a
projection sweep. An
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

The current release reference is model `laces-weekly-components-v8`, re-audited 2026-07-27 against
the official 2023–2025 replay. The raw audit output is checked in at
`apps/web/src/app/methodology/weekly-validation-2026-07-27.json`; the figures below are read from it
rather than transcribed, and `/methodology` publishes the same numbers from the same file.

The history covered 84,712 player rows, 1,632 D/ST outcomes, 76,016 matched snap rows, 42,036
matched weekly-roster rows, and 5,303 matched injury rows. Champion player MAE was 4.4032 with
71.04% coverage for the nominal 70% point interval and -0.1077 point bias. D/ST MAE was 4.3193
versus 4.5309 for its baseline, with 71.69% interval coverage.

Read the champion result honestly: `championOverall.baselineMae` equals `championOverall.mae`, and
every per-position `baselineMae` equals its own `mae`. The availability-aware recency baseline **is**
the champion at every player position — the richer contextual candidate won none of them. Its
overall MAE of 4.3899 is genuinely lower, but that is a 0.30% improvement against a 2% displacement
threshold, so it correctly remained shadow-only. D/ST is the one place a model beats its baseline.

Reproduce the full official audit with `npm run projections:validate -w @fantasy/worker -- --summary`;
expect several minutes of CPU time (about 375 seconds observed) because the command deliberately
rebuilds every locked batch.

After each weekly sweep, the worker also runs the rest-of-season shadow auditor against the latest
immutable schedule and weekly artifacts. It intentionally records only a degraded model-run audit:
it cannot write managed league sets or replace a prior good result. Release is a separate,
artifact-gated path. Each position/horizon cell requires the configured held-out season, block, row,
coverage, availability, convergence, and calibration evidence; sparse or mismatched cells remain
withheld.

The current rest-of-season rail uses model `laces-ros-distribution-v7`. Each current profile replay
grades 3,264 forecasts across 68 batches and converges all 144 release/reference diagnostics. The
three generic profiles have clean gate-only re-evaluations admitted under the current availability
rule. The two ESPN-shaped profiles use native-lineage, D/ST-complete v10 artifacts with exact
executable publication policies; only their D/ST 5–8 week cells are withheld. Historical results
remain development evidence; the frozen
[2026 untouched protocol](./ros-v6-2026-untouched-protocol.md) is the final confirmation. See
[`packages/projections/README.md`](../packages/projections/README.md) for the model and gate
definitions.

### Rest-of-season release status

`GET /v1/projections/ros-status` reports **six independent facts** and deliberately has no single
red/green verdict. It previously returned one `publication` field of `fail-closed-shadow` or
`publishable`, computed from the newest run under the managed source keyed
`laces-out.projections.first-party-ros-shadow`. Release-mode runs are written under that same
source, so a later audit run flipped the whole response back to `fail-closed-shadow` — which is how
an admitted, release-capable v8 artifact came to be read as "all ROS publication is disabled". Do
not reintroduce a summary field, and do not read release state from a shadow run.

The six fields:

| Field               | Answers                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `admittedArtifacts` | Which immutable champion artifacts are admitted, one per profile   |
| `scoringProfiles`   | Which scoring profiles that evidence covers, and which it does not |
| `leagueReadiness`   | Whether the caller's own league inputs are complete                |
| `cellGates`         | What the live per-position/horizon gate decided most recently      |
| `publishedSets`     | What each league holds, including a retained last-good set         |
| `shadowAudit`       | The independent audit rail, which is evidence about nothing above  |

League-scoped fields are restricted to the caller's own memberships. The endpoint previously
returned every league's published set to any authenticated user.

Structured per-league withholding reasons, emitted in this fixed order:

| Reason                          | Operator meaning                                                          |
| ------------------------------- | ------------------------------------------------------------------------- |
| `no-admitted-scoring-profile`   | The league's normalized scoring key matches no admitted artifact          |
| `incomplete-schedule`           | The regular-season schedule has games without a kickoff time              |
| `missing-candidate-pool`        | The current NFL fantasy-player pool has not been captured                 |
| `insufficient-candidate-inputs` | The league has too few scored candidate inputs to release                 |
| `non-converged-cell`            | At least one position/horizon cell did not settle within tolerance        |
| `stale-source`                  | The latest successful source verification is older than the 36-hour limit |
| `no-league-synced`              | The caller has no league season for the requested season                  |

A withheld cell never removes a league's existing set. `metrics.preservePriorGoodSet` on the release
run records that the last good set stays authoritative, and `metrics.cellDecisions` records every
cell decision — released and withheld — so a mixed release is readable without re-deriving it.

### Per-profile validation and admission

The rail is validated and admitted **once per scoring profile**. Profiles come from
`packages/projections/src/ros-scoring-profiles.ts`: `full-ppr`, `half-ppr`, `standard`,
`espn-standard-2pt`, and `espn-standard-2pt-nxm`. The first three share one rule list and differ
only in reception points. The ESPN profiles pin the two live league shapes independently, including
their complete D/ST brackets and their differing missed-extra-point rules.

```bash
npm run ros:validate -w @fantasy/worker -- --scoring-profile=half-ppr --full \
  > reports/ros-validation-<model>-half-ppr-<date>.json
npm run ros:admit -w @fantasy/worker -- --scoring-profile=half-ppr \
  --database-url=postgres://... --report=<that file> --evidence-through=2025 --confirm
```

`--full` is required for a release check: without it the report carries no `sources` block, so
admission fail-closes on `source_lineage_unavailable`. That is exactly why the v7 report is
unadmissible. `--scoring-profile` refuses an unknown name rather than defaulting, and the profile a
report was graded under is recorded in the report's own `scoringProfile` block alongside the
authoritative `identityAudit.scoringProfileKey`.

A releasable report carries both `champion`, the concise audit summary, and `publicationPolicy`,
the exact executable policy with immutable interval-calibration artifacts and checksums. Admission
rejects a report missing the latter as `publication_policy_missing_or_invalid`; the summary is
never cast back into a runtime policy, and its pinned `publicationPolicyChecksum` must match.
Publication applies the selected artifact's conformal correction to P15/P85 before any player row
is written.

Each profile produces its own scoring fingerprint, evidence report, artifact checksum, and
`first_party_ros_champion_artifacts` row. Whole-profile equality wins selection. A league with extra
or provider-specific rules can also match an artifact only for positions whose canonical scoring
vocabulary is byte-equal; unmatched positions withhold independently. There is no nearest-match,
default profile, or cross-position fallback.

#### Per-profile results, 2026-08-04

Every current profile uses 2019–2025 sources, holds out 2022–2025, covers all 17 cutoffs, samples
eight players per position/cutoff, and runs 12,288 release paths against a 16,384-path convergence
reference. No gate, threshold, tolerance, or minimum was relaxed between profiles.

| Profile                 | Current artifact state | Cell blockers   | Releasable cells | Artifact checksum | Scoring digest |
| ----------------------- | ---------------------- | --------------- | ---------------- | ----------------- | -------------- |
| `full-ppr`              | `evidence-ready`       | none            | 18 / 18          | `fa0868a1…92428`  | `dd74455d…`    |
| `half-ppr`              | `evidence-ready`       | none            | 18 / 18          | `65071929…bd7f`   | `66c5c9a4…`    |
| `standard`              | `evidence-ready`       | none            | 18 / 18          | `5882b7e1…744f`   | `ecf42385…`    |
| `espn-standard-2pt`     | `insufficient`         | D/ST, 5–8 weeks | 17 / 18          | `27c655c4…bbe1`   | `6a2ce8c9…`    |
| `espn-standard-2pt-nxm` | `insufficient`         | D/ST, 5–8 weeks | 17 / 18          | `76b8e528…c3f`    | `d0e49cad…`    |

The first three rows are append-only gate re-evaluations of the July 28 v8 validation evidence.
They clear the current evidence-based availability rule without changing any forecast. The two ESPN
rows are fresh v10 validations with complete D/ST scoring, native `--full` source lineage, and 18
exact executable publication-policy choices apiece. Each v10 report graded 3,264 forecasts,
completed 68 of 68 batches and 18 of 18 cells, skipped zero rows, and converged 144 of 144
diagnostics. Their only blocker is statistical undercoverage for D/ST with 5–8 remaining weeks: 0
of 4 walk-forward blocks covered. Admission is intentionally cell-scoped, so that one cell
publishes nothing while the other 17 remain independently releasable. The statistically equivalent
v9 reports remain immutable history but were superseded because they did not carry the exact
runtime policy now required for publication.

All five rows are provisioned in `first_party_ros_champion_artifacts`. Older rows remain immutable
audit history, and production selects the newest compatible artifact for each exact scoring
identity. Leagues with byte-identical scoring reuse the same deterministic simulations rather than
multiplying work by league membership; a distinct admitted profile adds one separate scoring pass.

The two D/ST-complete v10 validations took 22,665 and 22,847 seconds (about 6 hours 18 minutes and 6
hours 21 minutes) when run in parallel on the current host. The run has no checkpointing, so an
interrupted validation restarts from zero. Detach it from the launching shell and redirect stdout to
the report path. `projection-refresh` allows 28,800 seconds for the full shared NFL universe; do not
reduce that timeout below the measured validation envelope without a separate production benchmark.

Redirect the report through `npm run --silent`, or invoke `tsx` directly. Under some environments —
notably a scrubbed one such as `env -i` — `npm run` writes its two-line `> package@version` banner to
stdout, which lands at the top of the redirected file and makes the finished report invalid JSON.
The run itself is unaffected and the damage is recoverable without repeating it: the report is
appended after the banner, so discarding everything before the first `{` restores a parseable file.
Progress logging goes to stderr, so it never interleaves into the report body. Verify a finished
report begins with `{` before trusting it, because a multi-hour run is an expensive place to
discover a formatting problem.

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

#### Current availability and identity gates

Expected-games MAE ceilings remain 1.5 games for one-to-four and five-to-eight weeks and 2.75 for
nine-plus, with absolute signed bias capped at 1.0. A cell withholds for excess MAE only when the
one-sided exact-binomial evidence test at α = 0.10 establishes that its true MAE exceeds the
ceiling; the bias comparison remains direct. The report gate and live release gate use the same
rule.

Scoring identity is position-scoped per cell. Model and interval-method versions must match
exactly; scoring profiles must be byte-equal overall or recover to the same nonempty positional
vocabulary. Unparseable or empty identities fail closed. An admitted artifact's recorded blocker
also remains authoritative until a later report clears that cell and is explicitly admitted.
These pre-kickoff decisions are frozen in Amendment 4 of the
[2026 untouched protocol](./ros-v6-2026-untouched-protocol.md).

The ROS validator is intentionally expensive. The current D/ST-complete v10 profile runs took about
6.4 hours apiece on the production host: four season-locked policies, 3,264 12,288-path forecasts,
and 144 16,384-path convergence references. It writes progress phases to stderr and final JSON to
stdout — redirect stdout to keep a report; nothing is written to disk otherwise. The
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

## Change events

The change feed is on for every deployment and needs no configuration. Four producers write to
`change_events`, and each one compares prior against next before it writes anything:

| Producer         | Fires when                                                                  | Visibility                      |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `league-sync`    | a provider sync is _accepted_ (an unchanged replay never reaches the emit)  | `league` — current members      |
| `roster-diff`    | a team's new roster checksum differs from its previous snapshot's           | `league` — current members      |
| `injury-report`  | an admitted injury observation's `state_key` differs from the prior one     | `private` — rostering members   |
| `decision-delta` | a newly written `recommendation_runs` row differs materially from the prior | `private` — the claiming member |

`change_events` is **append-only at the database level** (`change_events_append_only_trigger`, from
migration `0003`): both `UPDATE` and `DELETE` raise. That is deliberate — an event ledger that can be
rewritten is not a ledger. Three operational consequences follow.

- **Retention is a read window, not a purge.** Nothing older than `CHANGE_EVENT_RETENTION_DAYS`
  (45) is served or counted by `GET /v1/change-events`. Rows are never deleted, and a future purge
  would need a forward migration that alters the trigger.
- **Receipts are prunable and carry no content.** `change_event_receipts` has no trigger. Deleting a
  receipt outside the read window is safe and cannot resurrect a dismissal, because the event stays
  outside the window regardless.
- **A dismissed event never returns.** The writer creates receipts with `ON CONFLICT DO NOTHING` on
  `(event_id, user_id)`, and a duplicate event insert returns zero rows and creates no receipts at
  all — so a later re-sync of the same transition cannot rebuild a receipt the member dismissed.

Visibility is enforced in one SQL predicate: a `private` event is reachable only through a receipt
the writer created, a `league` event is gated on _live_ membership (a removed member stops seeing it
immediately), and a `global` event carries no private league payload. Unknown, inaccessible, and
out-of-retention events all answer the same 404.

**Push delivery reuses the game-day alert transport.** A second sweep kind, `change-event`, runs at
minutes 9, 24, 39, and 54 UTC on the same `notification-sweep` queue, and is subject to the same
VAPID-keys-not-configured no-op described above. It sends **one digest per member per sweep, not one
push per event**, filtered to `severity in ('action','warning','critical')` inside a 24-hour window —
an informational change belongs in the feed and nowhere else. The digest is claimed in
`notification_deliveries` under `change-event:<userId>:<newestEventId>`; migration `0027` widened
`notification_deliveries_kind_check` to admit that kind. `change_event_receipts.delivered_at` and
`delivery_channels` are reconciled from that ledger on the following sweep, so a batch already sent
is never repeated.

## Current authentication baseline

The implemented application identity is local email/password authentication. Passwords are hashed
with Argon2id, sessions are server-side and revocable, and production cookies are HTTP-only,
same-site, and secure. For internet sharing, terminate TLS through the included Caddy gateway (or an
equivalent trusted edge); plain HTTP is supported only for loopback development. OIDC, passkeys,
and MFA are not configurable features today. They remain future hardening for broader exposure,
not prerequisites the current runbook silently assumes are already installed.

## Provider release gates

### ESPN automated refresh

Migration `0034_espn_automated_sync.sql` adds client kind/agent capability to bridge devices,
durable league-refresh fields and the one-live-request partial unique index, shared
`espn_league_sync_states`, and bounded `espn_refresh_attempts`. It also replaces the supplemental
artifact's lifetime checksum uniqueness rule with a lookup index: persistence remains serialized
and idempotent against the current canonical snapshot, while a valid provider reversion such as
`A → B → A` remains representable and independently scoped free-agent/waiver captures may retain
the same canonical payload. It backfills existing ESPN seasons with unknown direct capability.
Existing automatic bridge credentials remain agent-capable across the extension update;
credentials with the fixed legacy one-click label remain upload-only. Old companions can continue
six-hour uploads without polling, so deploy the server migration before the new extension.
After payload verification, the first replay of a legacy browser checksum upgrades only its stored
checksum metadata to the portable canonical identity; it does not duplicate canonical league rows
or emit a change event.

The API evaluates stale-on-view and manual member requests; the `provider-sync-sweep` schedule runs
every five minutes to expire overdue intents even when direct sync is disabled. When direct sync is
enabled, that sweep dispatches at most 100 due verified refreshes to the normal `league-sync` queue.
Migrated `unknown` and `not-public` rows remain unscheduled unless an operator deliberately sets
that one reviewed row's `preferred_mode = 'direct'` for a bounded evidence probe. Queue retries are
bounded and feed `provider-sync-sweep-dead-letter` or
`league-sync-dead-letter`; inspect either transition immediately. Chrome polls only Laces Out every
five minutes, reads ESPN only when an intent is offered, and retains a six-hour full sweep. A
sleeping or signed-out device is not an infrastructure outage.

Safe rollout order:

1. Take and verify a backup, apply migration `0034`, then run
   `npm run db:smoke -w @fantasy/db` against a disposable migrated PostgreSQL database.
2. Deploy API and worker support with `ESPN_PUBLIC_DIRECT_SYNC_ENABLED=false`. Confirm request/status
   reads, expiry, redacted structured counts, and legacy uploads before publishing the companion.
3. Publish the compatible companion update and canary one private league. Verify five-minute
   poll/no-work behavior, stale request fulfillment, login-required backoff, restart recovery, and
   the unchanged six-hour fallback. Expand only after queued work is not growing while agents are
   recently seen.
4. Complete the ESPN terms/policy review and capture sanitized anonymous evidence for each artifact
   family. Core approval never approves supplemental artifacts. Do not retain cookies, headers,
   provider bodies, real member identifiers, or unexpected query material as evidence.
5. For one intentionally public canary, explicitly promote only the proven core capability. An HTTP
   200 probe deliberately leaves an unknown league at evidence-required; there is no automatic
   promotion.

```sql
begin;

select season.id, season.provider, season.external_key, season.season,
       state.direct_core_state, state.supplemental_capabilities
from league_seasons season
join espn_league_sync_states state on state.league_season_id = season.id
where season.id = '<reviewed-league-season-uuid>'
for update;

update espn_league_sync_states state
set direct_core_state = 'available',
    consecutive_failures = 0,
    circuit_open_until = null,
    last_error_code = null,
    last_error_at = null,
    last_error_detail = null,
    next_probe_at = now(),
    updated_at = now()
from league_seasons season
where state.league_season_id = season.id
  and season.id = '<reviewed-league-season-uuid>'
  and season.provider = 'espn'
  and season.external_key ~ '^[0-9]{1,20}$'
returning state.league_season_id, state.direct_core_state;

commit;
```

Require exactly one returned row and separately record who accepted the policy/evidence gate. Then
set `ESPN_PUBLIC_DIRECT_SYNC_ENABLED=true` for both API and worker, restart through the normal
deployment process, and canary for at least seven days. The flag schedules verified
`available`/`degraded` rows and only those unverified rows an operator explicitly placed in direct
probe mode; default `unknown` and private rows remain closed. Verify public-to-private transition,
429/circuit behavior, parser rejection, no identity or membership mutations, and last-good data
preservation before expanding.

Use these low-cardinality summaries in the daily operations digest. They contain no response body,
credential, user email, device token, or league name:

```sql
select state, coalesce(fulfillment_mode, 'unassigned') as mode, count(*)
from refresh_requests
where kind = 'league' and created_at >= now() - interval '24 hours'
group by state, coalesce(fulfillment_mode, 'unassigned')
order by state, mode;

select coalesce(fulfillment_mode, 'unassigned') as mode,
       count(*) as fulfilled,
       round(avg(extract(epoch from finished_at - created_at))) as mean_seconds,
       round(percentile_cont(0.95) within group (
         order by extract(epoch from finished_at - created_at)
       )) as p95_seconds
from refresh_requests
where kind = 'league' and state = 'succeeded'
  and finished_at is not null and created_at >= now() - interval '24 hours'
group by coalesce(fulfillment_mode, 'unassigned')
order by mode;

select state, coalesce(error_code, 'none') as error_code, count(*)
from espn_refresh_attempts
where started_at >= now() - interval '24 hours'
group by state, coalesce(error_code, 'none')
order by state, error_code;

select direct_core_state, count(*)
from espn_league_sync_states
group by direct_core_state
order by direct_core_state;

select
  count(*) filter (where last_seen_at >= now() - interval '15 minutes') as seen_15m,
  count(*) filter (where last_seen_at >= now() - interval '6 hours') as seen_6h,
  count(*) filter (where last_seen_at >= now() - interval '7 days') as seen_7d
from bridge_devices
where provider = 'espn' and agent_capable and revoked_at is null
  and (expires_at is null or expires_at > now());

select count(*) as waiting_without_recent_agent
from refresh_requests request
join league_seasons season on season.id = request.league_season_id
where request.kind = 'league'
  and request.state in ('queued', 'processing')
  and request.expires_at > now()
  and season.provider = 'espn'
  and not exists (
    select 1
    from bridge_device_leagues scope
    join bridge_devices device on device.id = scope.bridge_device_id
    where scope.league_id = season.league_id
      and scope.external_league_id = season.external_key
      and (scope.season is null or scope.season = season.season)
      and device.provider = 'espn' and device.agent_capable
      and device.revoked_at is null
      and (device.expires_at is null or device.expires_at > now())
      and device.last_seen_at >= now() - interval '15 minutes'
  );

select name, state, count(*)
from pgboss.job
where name in (
  'provider-sync-sweep', 'provider-sync-sweep-dead-letter',
  'league-sync', 'league-sync-dead-letter'
)
group by name, state
order by name, state;
```

Alert on repeated failures for a previously available league, cross-league parser rejection that
suggests schema drift, dead-letter transitions, or a growing non-expired queue despite agents seen
in the last 15 minutes. Do not alert merely because a league is private, one desktop is offline, or
one request is waiting. Correlate API `member-refresh`, `agent-poll`, and `agent-attempt` count-only
records with worker sweep results; never add league payloads or authorization headers to logs.

Rollback is forward-compatible:

- Set `ESPN_PUBLIC_DIRECT_SYNC_ENABLED=false` in API and worker to stop new anonymous reads. Leave
  the capability rows and last good snapshots intact.
- Roll back the stale-on-view web client if intent creation must stop; the manual/legacy upload
  paths remain compatible. The new companion retains its six-hour baseline if polling is disabled
  server-side or returns no work.
- Cancel live intents without deleting attempts or canonical facts:

```sql
update refresh_requests
set state = 'cancelled',
    started_at = coalesce(started_at, created_at),
    finished_at = now(),
    error_code = 'OPERATOR_CANCELLED',
    error_detail = 'Cancelled during automated ESPN refresh rollback.'
where kind = 'league' and state in ('queued', 'processing');
```

- Do not reverse migration `0034` during an incident. Do not delete shared sync state, attempts, an
  accepted snapshot, league, membership, or healthy bridge credential as a rollback step.

Heavy release validation includes the PostgreSQL concurrency/race suite, schema smoke, old/new
extension compatibility, production web/API builds, and the sanitized live matrix in the ESPN
provider note. It must run away from the live database and only after resource-intensive host work
has finished.

### Other provider gates

- Yahoo friend access may be enabled after the operator completes the current provider terms,
  configuration, and real-account contract-validation checklist. Set
  `NEXT_PUBLIC_YAHOO_ACCESS_STATUS=available` only when the OAuth credentials are ready.
- ESPN companion distribution requires sanctioned private-league validation, terms and store-policy
  review, and a signed build. The signed browser bridge is the only hosted private-league path.
- ESPN live draft sync stays behind `ESPN_LIVE_DRAFT_SYNC=false` until the
  [live draft release gate](./provider-notes/espn.md#live-draft-release-gate) passes against
  disposable snake and salary-cap leagues. The DOM adapter's selector table is unverified until
  then, and landing-page copy may not claim the capability before that gate.
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

Production deployments should run a published release tag rather than an arbitrary moving `main`
checkout:

```bash
VERSION=v1.0.0 # choose and review the release you intend to run
git fetch --tags --prune
git checkout "$VERSION"
git rev-parse --verify HEAD
```

Then:

1. Review that release's notes, migration changes, and provider capability changes.
2. Run `npm ci && npm run check` against the checked-out version.
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
