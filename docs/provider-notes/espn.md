# ESPN Fantasy Football provider

Verified: 2026-07-16

## Supported boundary

The official ESPN support and Disney developer materials reviewed for this project do not publish
a supported, general third-party ESPN Fantasy Football OAuth/API contract. ESPN support does
document league IDs, public/private league behavior, snake and salary-cap formats, and the normal
user sign-in experience. That is not an API authorization grant.

Consequently this product must not show an official “Connect ESPN” OAuth button. It implements
three read-only modes:

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
Laces Out. It runs on demand and, when enabled, every six hours while the browser and ESPN
session are available.

One device can be scoped to up to 32 unique numeric league IDs for a single configured season.
The companion reads and uploads them sequentially, continues after a per-league failure, and
surfaces retained per-league results plus an aggregate full-success, partial-failure, login-required,
pairing-rejected, or failed state. The server independently authorizes every uploaded league ID;
being present in the browser configuration alone grants nothing. A first accepted snapshot may
create a new internal league owned by the device's authenticated Laces Out user. Once the provider
league/season exists, the paired user must already be its owner or a commissioner; ordinary members
and outsiders cannot sync, auto-enroll, link their scope, or discover the existing league by replay.

This is an unofficial compatibility integration, not ESPN OAuth. Its parser must fail closed when
ESPN changes the web-client contract, keep the last good snapshot, and direct the user to reconnect
or import. The signed companion is available through its unlisted [Chrome Web Store
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

Supplemental ESPN reads must use independent artifact contracts and receipts. The implementation
priority is league-specific available players, player-level weekly box scores, structured
transactions, then completed/on-demand draft results. A supplemental request may fail without
invalidating or rolling back a valid core league snapshot. Message-board content is out of scope.

### 2. Canonical manual JSON import

This is the durable baseline. Schema version 1 accepts league identity, season, settings, roster
slots, scoring rules, teams, managers, and roster players. It rejects unknown fields,
inconsistent team counts, duplicate IDs, unknown lineup slots, oversized artifacts, and values
outside conservative bounds. It normalizes provider IDs into season-scoped keys and attaches the
original artifact checksum and import timestamp.

The authenticated workflow deliberately has two phases:

1. `POST /v1/connections/espn/import/validate` parses at most 2 MiB, writes nothing, and returns
   league identity, exact artifact checksum, artifact timestamp, signed age, and warnings.
2. `POST /v1/connections/espn/import/commit` reparses the original artifact and requires both an
   explicit confirmation and the checksum returned by preview. A changed artifact receives a
   conflict response and must be previewed again.

The first bridge or manual import of a provider league/season creates an owner membership for the
authenticated Laces Out user. Once that season exists, only its owner or a commissioner may replace
shared canonical data; manager, viewer, and nonmember attempts fail before checksum replay is
disclosed. A transaction-scoped advisory lock serializes bridge and manual writes for the same ESPN
season. The sync receipt, settings/scoring, teams, roster links, and standings/matchup snapshots
commit together.
A league-season/checksum replay returns the original receipt without duplicate snapshots, and a
failure rolls every attempted mutation back to the last good state.

Player fields in either artifact are self-asserted observations, not catalog authority. Persistence
reuses a global ESPN crosswalk only when the trusted catalog has marked it verified and never updates
that canonical player from the artifact. If no verified crosswalk exists, the roster points to a
non-verified league-season-scoped observation. Its name, team, position, eligibility, and status
remain available for that league's roster display, draft room, and projection resolution, but the
row is excluded from unscoped/global catalog and ranking resolution and cannot be reused by another
league. A later trusted catalog refresh can establish the canonical crosswalk for subsequent
snapshots.

`importedAt` becomes the snapshot's effective time and is always displayed as provenance. Old
artifacts are allowed for recovery, but timestamps more than five minutes ahead of server time are
rejected so a typo cannot outrank later legitimate data. Neither endpoint accepts ESPN passwords,
`SWID`, `espn_s2`, browser cookies, copied request headers, or HAR material; unknown fields fail the
strict contract.

The complete sanitized example is
[`packages/connector-espn/test/fixtures/canonical-v1.json`](../../packages/connector-espn/test/fixtures/canonical-v1.json).
Imports are snapshots, so recommendation UI must visibly display their age. A future CSV wizard
should convert into this JSON contract rather than introducing a second internal format.

### 3. Anonymous public-league read

`EspnPublicReadClient` calls the web client's `lm-api-reads.fantasy.espn.com` endpoint only for a
numeric league ID and season. This endpoint is **unofficial and undocumented for third-party
use**. It remains an isolated connector experiment and is not wired into the hosted application.
The request boundary:

- has no password, cookie, `SWID`, `espn_s2`, Authorization header, or arbitrary-header parameter;
- sets fetch credentials to `omit` and refuses redirects, preventing an implicit signed-in browser
  session from crossing the boundary;
- permits only a small allowlist of read views;
- applies a timeout and 5 MiB response limit;
- treats returned JSON as an untrusted, checksummed artifact rather than a stable normalized
  contract;
- returns `NOT_PUBLIC` for 401, 403, or 404 so the UI can direct the owner to manual import.

An LM can use ESPN's documented setting to make a private league public if appropriate. Public
visibility is a user/commissioner choice and must not be changed or worked around by this app.

## Explicit exclusions

- Never ask for or store an ESPN password.
- Never automate the ESPN sign-in form.
- Never accept or replay `SWID`, `espn_s2`, browser cookies, copied request headers, or a HAR file
  in the hosted application. The companion may let the browser attach its local ESPN cookies to a
  direct ESPN request, but it never reads or transmits their values.
- Never perform lineup, waiver, transaction, trade, commissioner, or draft writes.
- Never advertise live ESPN draft sync until real-season cadence and completeness tests establish a
  safe read contract. Manual draft event entry remains primary; completed/on-demand provider draft
  results may later reconcile against it without silently rewriting manual history.
- Do not silently fall back from anonymous reads to browser session credentials.

Disney's terms restrict automated access, monitoring, and copying using robots, spiders, scrapers,
or other automated means. The anonymous public-read experiment therefore remains feature-flagged
and personal-use only until a terms review accepts it. Manual import works without depending on
that endpoint and is the safe release path.

## Setup checklist

1. Obtain each numeric league ID using ESPN's normal web/app UI.
2. For automatic private-league sync, install the signed companion from the [Chrome Web Store
   listing](https://chromewebstore.google.com/detail/laces-out-espn-bridge/hmilkmcjlkpnigcfnlfogeafacjpmkbj),
   create a league-scoped pairing from Laces Out's `/connections` page, then open the extension and
   choose **Complete pairing**. Laces Out hands off the credential and bounded league-ID set
   directly; there is no token to copy or paste. Sync while signed in to ESPN in the same browser
   profile, then claim the correct fantasy team after each league's first import.
3. Keep canonical JSON import as recovery. Preview the checksum, source time, league, season, and
   team count; then use the separate confirmation to commit. Do not paste credentials or headers.
4. If using public read, confirm the league is intentionally public and enable only the
   `public-unofficial` mode. No ESPN secret environment variables should exist.
5. Keep the last successful normalized snapshot if a later read/import fails.
6. Re-run sanitized fixture tests whenever the canonical schema changes. A schema change requires
   a new explicit version and migration; never reinterpret an existing version.
7. Run both ESPN API smokes against PostgreSQL. They exercise first-owner creation, bridge
   outsider/manager denial, commissioner replacement, checksum replay, player-observation
   quarantine, canonical-player preservation, normalization, and rollback.

## Primary references

- [ESPN Fan Support: League ID](https://support.espn.com/hc/en-us/articles/4408412998804-League-ID)
- [ESPN Fan Support: making a private league public](https://support.espn.com/hc/en-us/articles/47160849553940-Making-a-Private-League-Public-LM-Only)
- [ESPN Fan Support: league types](https://support.espn.com/hc/en-us/articles/360000977272-League-Types-in-ESPN-Fantasy)
- [ESPN Fan Support: public leagues and snake/salary-cap drafts](https://support.espn.com/hc/en-us/articles/115003850011-Join-a-Public-League)
- [Disney Terms of Use](https://disneytermsofuse.com/)

The unofficial host is implementation evidence, not a primary or supported ESPN API reference.
