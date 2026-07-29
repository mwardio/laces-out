# Sleeper provider

Verified: 2026-07-27

## Verified provider contract

Sleeper publishes an official read-only HTTP API at `https://docs.sleeper.com/`. The documentation
reviewed on 2026-07-27 states that "No API Token is necessary, as you cannot modify contents via
this API," that a caller should "stay under 1000 API calls per minute, otherwise, you risk being
IP-blocked," and — for the full player catalog — "Please use this call sparingly, as it is intended
only to be used once per day at most to keep your player IDs updated." The trending-players section
states: "Please give attribution to Sleeper you are using our trending data."

The documented call ceiling is recorded in code as `SLEEPER_DOCUMENTED_CALLS_PER_MINUTE` (1000) in
`packages/source-sleeper/src/sleeper-league-source.ts`. It is not a binding constraint on the
shipped surface, which makes at most a few calls per hour.

Live behavior confirmed on 2026-07-27 against the two production endpoints:

- `GET https://api.sleeper.app/v1/players/nfl` returned `200` with a weak `ETag`, a Cloudflare
  `cache-control` of `public, s-maxage=600, stale-while-revalidate=300, stale-if-error=600`, and
  **no** `Last-Modified` header. The same request replayed with `If-None-Match` returned `304`.
- `GET https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50` returned
  `200` with a weak `ETag` and a 1,735-byte body.
- The catalog body measured 14,609,548 bytes (13.9 MiB) uncompressed across 12,201 player rows.
  The documentation's stated size — "close to 5MB" — no longer matches the live payload.

**What could not be verified.** `docs.sleeper.com` links to no developer agreement, API terms of
service, or license for API responses. The nearest published document is Sleeper's General Terms of
Use (Blitz Studios, Inc.; last updated 2026-07-24), which covers account use, prohibits accumulating
points or prizes "through unauthorized methods such as unauthorized scripts or other automated
means," and grants users "a limited, personal, revocable, non-transferable and non-exclusive right
and license to access and use the Services … for your personal and non-commercial use." That
document does not address the public read API, redistribution of API responses, caching or storage
of responses, or third-party attribution. Sleeper's position on redistribution, storage, and
commercial use of this API is therefore **not established** — there is neither an explicit grant
nor an explicit prohibition covering how this project uses it. Treat that as unresolved, not as
permission.

## Production reads and cadence

Two endpoints ship, both defined in `packages/source-sleeper/src/sleeper-source.ts`:

- `SLEEPER_PLAYERS_URL` — `https://api.sleeper.app/v1/players/nfl`, read by `SleeperPlayersSource`.
- `SLEEPER_TRENDS_URL` — `https://api.sleeper.app/v1/players/nfl/trending`, read by
  `SleeperTrendsSource` for both the `/add` and `/drop` signals.

Neither read sends a credential, cookie, or Authorization header. Both send only `Accept:
application/json`, set `redirect: "error"`, and abort after a 30-second `REQUEST_TIMEOUT_MS`.

`SleeperPlayersSource.check` sends `If-None-Match` and `If-Modified-Since` from the stored
`data_sources.etag` and `last_modified`. Sleeper does not return `Last-Modified`, so in practice
only the `ETag` validator is live. A `304` short-circuits to `unchanged`. Otherwise the body is
SHA-256 hashed and compared against the stored `last_checksum`, giving a second `unchanged` path
that protects against a rotated-but-identical artifact.

`SleeperTrendsSource.check` fetches both signals concurrently with `lookback_hours` and `limit`
query parameters (constructor defaults 24 and 50; accepted ranges 1–168 and 1–100). It sends no
conditional headers; a combined checksum over both bodies decides `changed` versus `unchanged`, but
rows are persisted on either result because the market series is a time series.

`apps/worker/src/sleeper-data.ts` sets the source clocks: `catalogCheckIntervalMinutes = 60` and
`trendsCheckIntervalMinutes = 60`, with a 15-minute claim window. Scheduling comes from
`apps/worker/src/jobs.ts` and `apps/worker/src/worker.ts`:

- `23 * * * *` UTC — hourly `market-data` refresh calls `SleeperDataRefresher.refreshTrends`.
- `17 5 * * *` UTC — daily `player-data` refresh calls `refreshCatalog` then `refreshTrends`.
- `11 * * * *` UTC — the hourly projection refresh also calls `refreshCatalog`, because injury,
  practice, and availability signals feed start/sit forecasts.
- `*/10 * * * *` UTC — the lock-window projection tick calls `refreshCatalog` only while a lineup
  lock window is active; its final pass sets `force`, which bypasses the source's `nextCheckAt`
  clock but **not** the conditional request. Only a `catalogSchemaVersion` bump clears the stored
  validators and forces a full re-read.

The effective floor is therefore one catalog check per hour and one trends check per hour, except
during an active lineup-lock window, where the final forced pass bypasses `nextCheckAt` (though not
the conditional request).

**Known limitation.** The catalog floor was lowered from 30 to 60 minutes on 2026-07-27, halving
the request rate. It remains more frequent than Sleeper's documented
"once per day at most" guidance for `/v1/players/nfl`, and must not be described as compliant with
that guidance. The conditional request is a real mitigation — a `304` was confirmed live and
transfers no body — but on any day the catalog changes repeatedly, the cadence can still pull the
full ~14 MiB payload several times. If Sleeper stops returning an `ETag`, this becomes an
unconditional multi-megabyte download every hour and must be lowered before it ships in that state.

## Coverage

The shipped Sleeper source is the current NFL player universe plus a 24-hour add/drop market
signal. It carries no season, week, scoring format, roster format, or league-size dimension, and
contributes none of those to downstream analysis. Positions are uppercased and `DEF` is normalized
to `DST`. The catalog spans the whole league including practice-squad, inactive, and retired
records — 12,201 rows on 2026-07-27 — not just rostered starters.

## Response bounds and rejection rules

Catalog bounds: `MAX_PLAYER_RESPONSE_BYTES` 16 MiB, `MAX_PLAYER_ROWS` 100,000. Trend bounds:
`MAX_TREND_RESPONSE_BYTES` 1 MiB per signal, and `parseTrends` rejects any array longer than 250
entries. `readBounded` checks a declared `content-length` first, then streams and cancels the reader
the moment the running total crosses the cap.

The measured 13.9 MiB catalog leaves roughly 13 percent headroom under the 16 MiB cap. That margin
is thin: a `TOO_LARGE` failure would stall the catalog and, through the projection gate below, stall
publication. Re-measure at each admission review and raise the cap or stream incrementally before
the gap closes. Trend payloads measured 1,735 bytes against a 1 MiB cap — no concern.

Transport rejection produces a `SleeperSourceError` with one of four codes: `NETWORK` (retryable),
`UPSTREAM` (retryable only on 429 or 5xx), `TOO_LARGE`, and `INVALID_JSON`. Redirects are refused
outright rather than followed.

Row-level rejection in `normalizePlayer` is deliberately strict, and a rejected row is dropped
rather than repaired:

- the catalog key must match `/^[A-Za-z0-9._-]{1,64}$/`, and an embedded `player_id` that disagrees
  with its key rejects the row;
- a display name and a valid primary position are both required;
- `gsis_id` is retained only when it matches `/^00-\d{7}$/`; ESPN and Yahoo IDs only when they match
  `/^\d{1,32}$/`;
- depth-chart order must be an integer in 0–99; eligible positions are capped at 16.

Whole-artifact rejection: zero rows, more than 100,000 rows, zero surviving players, or malformed
JSON all raise before anything is written. On 2026-07-27, 240 of 12,201 rows (2.0 percent) were
rejected for lacking a usable display name or position.

## Identity, match coverage, and quarantine

`resolvePlayer` in `apps/worker/src/sleeper-data.ts` walks a fixed confidence ladder: canonical GSIS
match (`1.0000`), existing `sleeper` external ID (`0.9500`), `espn` external ID (`0.9500`), `yahoo`
external ID (`0.9000`), then exact normalized name-plus-position (`0.8000`).
`buildUniqueExactPlayerIdentity` discards any name-and-position key that resolves to more than one
canonical player, so the weakest rung can never guess between two people.

Unmatched records are quarantined, not dropped and not guessed. A `player_source_observations` row
with a null `player_id` is still written so the observation remains auditable, but it never joins
into anything: `apps/worker/src/first-party-projections.ts` skips status rows with a null
`playerId`, and `apps/api/src/in-season-decisions.ts` selects market signals by canonical
`playerId`, so a null-identity trend cannot reach a recommendation.

`uniqueSleeperPlayerCrosswalkRows` handles the harder case. Sleeper can briefly expose the same ESPN
or Yahoo identifier on two catalog entries — typically an obsolete record and its replacement.
Exact duplicates collapse, but an alias claimed by two different canonical players is withheld
entirely until the provider data becomes unambiguous, rather than letting a conflicting upsert
silently rebind the crosswalk.

Measured provider-side identifier coverage on 2026-07-27, over the 11,961 accepted rows: 3,893
(32.5 percent) carried a well-formed GSIS ID, 6,732 (56.3 percent) an ESPN ID, and 6,746
(56.4 percent) a Yahoo ID. Low GSIS coverage is expected and not a defect — the canonical `players`
table holds nflverse identities, while the Sleeper catalog includes practice-squad and inactive
records that nflverse never assigns.

**Not established.** Neither `refreshCatalog` nor `refreshTrends` writes `rowsRead`, `rowsRejected`,
`rowsUnmatched`, `matchRate`, or `publishable` into `data_sources.metadata`; the catalog writes only
`catalogSchemaVersion` and trends write only `lookbackHours` and `limitPerSignal`. Consequently the
dashboard quality block in `apps/api/src/league-dashboard.ts` renders no match rate for either
Sleeper source, and no source-specific match-rate threshold gates publication. The match coverage
recorded above is a point-in-time measurement taken for this document, not a continuously enforced
metric. Closing that gap means writing the counts into source metadata and choosing a threshold.

## Provenance, freshness, and kill switch

Every changed catalog run writes an immutable `sync_runs` row: kind `player-status`, idempotency key
`sleeper.players:<sha256>`, plus rows read, rows written, and the artifact checksum. Replaying an
identical artifact is a no-op through `onConflictDoNothing`. Observations, crosswalk upserts, the
sync-run row, and the `data_sources` update all commit in one transaction, so a partial catalog can
never replace a complete one.

Trends write kind `market-signal` with idempotency key `sleeper.trends:<checkedAt>`. That key is
time-based rather than checksum-based, so an unchanged trend artifact still produces a new run row
and new observations; `player_market_observations` is append-only with a 90-day retention sweep
(`marketRetentionDays`). This is intentional for a time series but means the trends run count is not
a proxy for the number of distinct artifacts.

Freshness is assessed in `apps/worker/src/data-health.ts`, which marks a source stale at twice its
`checkIntervalMinutes` — 60 minutes for the catalog, 120 for trends — and degraded whenever
`consecutiveFailures > 0`. The league dashboard applies its own display thresholds: fresh within 6
hours, aging to 24 hours, stale beyond.

Last known good is preserved on failure. `recordFailure` advances `nextCheckAt` by exponential
backoff (15 minutes doubling per consecutive failure, capped at 24 hours), increments the failure
count, and records `lastErrorCode` and `lastErrorDetail`. It never clears `lastChecksum`, the stored
validators, or the persisted observations, so the previous catalog and trend rows continue to serve
while the source recovers.

`sleeper.players` is a **required** input in `requiredFirstPartyProjectionSourceKeys`. Before a
projection run publishes, `sourceIsUsableForProjection` requires the source to be enabled, to have
`metadata.publishable !== false`, to have `metadata.availability` unset or `"available"`, to carry
no in-flight `refreshClaimedAt` claim, and to be fresh. A stale Sleeper catalog therefore fails the
projection run rather than publishing forecasts on stale injury and availability status.

The kill switch is the `data_sources.enabled` column. With it false, `claimSource` returns null and
the refresh degrades to a `not-due` no-op, while `selectAdmittedSource`, the dashboard source list,
and the projection selector all filter on the same flag, so the source disappears from every
surface. No application route toggles it; disabling Sleeper is a deliberate operator action against
the database. The 15-minute `refreshClaimedAt` claim serves a second purpose here — it prevents
overlapping refreshes and makes the source ineligible to back a publish while a check is in flight.

## Attribution and usage constraints

`SLEEPER_ATTRIBUTION` is `"Player and trending data provided by Sleeper"` and
`SLEEPER_ATTRIBUTION_URL` is `"https://sleeper.com/"`. `claimSource` writes both onto the
`data_sources` row on insert **and** on conflict update, so a stored attribution cannot drift from
the constant. `apps/api/src/league-dashboard.ts` passes them through for every enabled source, and
`apps/web/src/components/dashboard-experience.tsx` renders each as a link in the signed-in
dashboard's "Sources & freshness" panel. Verify that panel still renders after any shell redesign.

Sleeper's documented attribution requirement names trending data specifically; this project
attributes the catalog as well, which is deliberately broader than the stated minimum.

Because no published Sleeper document grants redistribution rights for API responses, both datasets
are treated as inputs to derived, league-scoped analysis for a private group — never as a
redistributable dataset. Do not build a bulk export of the Sleeper catalog or a screen that
reproduces it wholesale. Sleeper's General Terms of Use licenses users a "personal and
non-commercial" right to the Services; whether that clause reaches the public read API is not
stated. Any commercial operation of this product needs a fresh terms review and, if the position is
still unclear, direct written permission from Sleeper. That is an engineering release condition, not
legal advice.

## League connection is deferred

Connecting Sleeper leagues is deferred by product decision on 2026-07-27. This document does not
propose, plan, or authorize it.

`packages/source-sleeper/src/sleeper-league-source.ts` is built and unit tested but intentionally
unwired. `SleeperLeagueSource` is referenced only by its own test file; no worker, job, or API route
constructs it. It is exported from the package index, so keeping it dormant is a standing decision
rather than an accident of module wiring — do not wire it up as incidental cleanup.

For the record, its boundary is already narrow. `#request` resolves each path against
`SLEEPER_API_BASE_URL` and throws `RangeError("Sleeper endpoint escaped the official API origin")`
unless the resolved origin is exactly `https://api.sleeper.app` and the pathname starts with `/v1/`.
It refuses redirects, applies a 15-second default timeout bounded to 1–60 seconds, caps responses at
1 MiB single / 4 MiB collection / 8 MiB large collection, returns a `SleeperResponseProvenance`
carrying endpoint, `fetchedAt`, and SHA-256 on every read, and fails closed when a roster, draft, or
pick response reports a different league or draft ID than the one requested.

None of that is an admission. Wiring the league connector requires its own source-admission pass,
including resolution of the terms question above.

## Setup checklist

1. Provision nothing. The API takes no credential; a `SLEEPER_*` secret anywhere in configuration is
   a defect, not a missing feature.
2. Confirm the `sleeper.players` and `sleeper.trends` rows exist and are enabled. Both self-register
   through `claimSource` on the worker's first refresh.
3. Confirm the Sleeper attribution link renders in the dashboard "Sources & freshness" panel after
   any shell or navigation change.
4. Re-run the live header check at each admission review: request `/v1/players/nfl`, confirm an
   `ETag` comes back, then replay with `If-None-Match` and confirm `304`. If the validator
   disappears, lower the catalog cadence before shipping.
5. Re-measure the catalog payload against `MAX_PLAYER_RESPONSE_BYTES` at the same review. Raise the
   cap or move to incremental parsing well before the measured size approaches it.
6. Leave the league source unwired.

## Primary references

- [Sleeper API documentation](https://docs.sleeper.com/)
- [Sleeper General Terms of Use](https://support.sleeper.com/en/articles/5486620-general-terms-of-use)
- [Sleeper company and legal entity information](https://sleeper.com/company)

Sleeper publishes no developer agreement or API-specific terms. Where the read API documentation and
the consumer Terms of Use are both silent — redistribution, storage, and commercial use — this
project treats the silence as unresolved rather than as permission, and the shipped surface stays
narrow accordingly.
