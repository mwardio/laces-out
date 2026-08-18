# Yahoo Fantasy provider

Verified: 2026-08-05

## Verified provider contract

Yahoo has an official Fantasy Sports API covering games, leagues, teams, players, and other
fantasy resources. Private league data is authorized with OAuth. Yahoo reviews Fantasy API
applications separately; a general Yahoo application or OAuth key does not by itself establish
Fantasy API access.

The implemented authorization path is Yahoo's confidential-client Authorization Code flow:

1. Generate a 256-bit random `state` value and a separate encrypted transaction sentinel.
2. Store only the SHA-256 state digest. Encrypt the sentinel in the short-lived, single-use OAuth
   transaction so an altered row fails closed.
3. Redirect to `https://api.login.yahoo.com/oauth2/request_auth` with the exact registered
   redirect URI, `response_type=code`, and one-time state. Yahoo's documented confidential-client
   flow uses the client secret at token exchange and does not accept PKCE parameters.
4. On callback, check expiry and the state digest before exchanging the code server-side.
5. POST the code and exact redirect URI with confidential-client authentication to
   `https://api.login.yahoo.com/oauth2/get_token`. Do not send Yahoo tokens to browser storage.

Yahoo documents an approximately one-hour access-token lifetime. More importantly, Yahoo may
return a replacement refresh token and revoke the old one. `YahooTokenClient.refresh` returns an
`expectedCredentialVersion` and `nextCredentialVersion`; persistence must encrypt the complete
new token set and commit it with a compare-and-swap update such as:

```sql
UPDATE provider_connections
SET credential_envelope = :new_envelope, credential_version = :next
WHERE id = :connection_id AND credential_version = :expected;
```

If no row is updated, discard the result and reload; never overwrite a newer refresh result.
Serialize refresh jobs per connection as an additional defense against refresh-token races.

Yahoo's Fantasy guide documents XML examples and compound resource keys. The current normalizer
keeps full values such as `449.l.12345`, `449.l.12345.t.1`, and `449.p.9001`; a bare numeric league
ID is retained only as a secondary provider field. The XML parser:

- caps input at 5 MiB;
- rejects `DOCTYPE` and `ENTITY` declarations before parsing;
- disables entity processing, typed value coercion, processing instructions, and HTML entities;
- validates well-formedness;
- parses the minimal league, settings, roster-position, scoring-modifier, team, manager, and
  roster-player surface into the normalized sync contract.

League settings also retain Yahoo's declared scoring-category position families and its
fractional/negative-points switches. When fractional scoring is disabled, conventional passing,
rushing, and receiving yardage modifiers are normalized to exact whole-group components for the
common 5/10/20/25/50/100-yard divisors. Unsupported divisors, combined return-yard grouping, and
threshold bonuses remain fail-closed rather than approximating bucket behavior. Bonus support
requires a sanitized approved-account settings fixture that proves Yahoo's exact bonus payload.

No numeric quota is assumed. The production `YahooFantasyReadClient` now applies a configurable
request timeout, a 5 MiB maximum XML limit by default, a four-request concurrency limit by default,
and credential-scoped in-flight request coalescing. It never follows redirects and accepts only
the fixed `https://fantasysports.yahooapis.com/fantasy/v2/` origin, supported XML content types,
valid UTF-8, and XML that passes the secure parser. Player and transaction collection reads default
to 25 items and reject requested page sizes above 100. Callers still own durable caching and retry
scheduling; the client classifies retryable errors and parses both delta-seconds and HTTP-date
`Retry-After` values without retrying invisibly. A resource `401` requests one serialized access
token refresh through `YahooTokenClient`; only an unsuccessful refresh should move the connection
to reauthorization.

The implemented authenticated GET surface uses Yahoo resource paths for the logged-in user's NFL
games and paginated leagues plus league settings, teams, team rosters (optionally by week),
scoreboard matchups (optionally by week), standings, transactions, paginated players, and draft
results. Strict sanitized-fixture parsers now join discovery, settings, teams, rosters, standings,
and scoreboard responses into one normalized bundle. Cross-resource league/team mismatches fail
closed before persistence; those five resources then commit atomically with a connection-scoped
idempotency receipt. Transactions, player collections, and draft results intentionally remain
validated raw XML artifacts until their own versioned normalizers and approved-account fixtures
exist; the client does not invent response schemas.
Pending waiver and pending-trade reads fail closed unless they use Yahoo's required singular type
filter with a league team key.

Yahoo documents draft-result resources, but no official webhook/live draft channel. Draft reads
remain `polling-unverified` until both snake and auction mock drafts validate latency,
completeness, corrections, and auction price fields for the approved 2026 application.

League deep links accept both observed compound-key families, such as numeric `449.l.12345` and
alphabetic `nfl.l.12345`, and retain the provider league number in the resulting Yahoo URL. Any
unrecognized key deliberately falls back to Yahoo Fantasy rather than guessing a league target.

The initial capability is read-only. Any future write capability needs separate provider access,
an explicit preview/confirmation flow, reconciliation, and a shadow-mode rollout. Yahoo's portal
also requires attribution and approved brand treatment wherever Yahoo Fantasy data is displayed.
The implemented reads do not establish complete lineup-lock, availability, transaction-deadline,
waiver, veto, or keeper constraints. Decision results therefore describe roster-rule and
eligibility validity only. A stored affirmative lock is enforced, but the absence of one does not
prove that Yahoo considers a player unlocked. Users must verify every recommendation in Yahoo;
Laces Out cannot execute it.

## Approved-use and presentation constraints

Yahoo's published API terms prohibit selling, reselling, or sublicensing API access and prohibit a
competing use without express permission. This repository is intended for free, noncommercial
friend-sharing. Each operator must keep the deployment's actual audience, registration posture,
and use within the scope Yahoo approved for that application. `REGISTRATION_OPEN=true` changes who
may create a Laces Out account; it does not widen the application's Yahoo authorization.

The terms also prohibit compiling complete box scores or complete statistics for all players in a
fantasy league on one screen. League analytics should expose derived team-level strength, luck,
efficiency, matchup, and trade metrics, with bounded drill-downs—not a single raw all-player stats
dump. Every Yahoo-backed surface must include the portal's current required “Fantasy data provided
by Yahoo Fantasy” attribution, link, and unmodified official logo treatment.

The authenticated Laces Out app shell implements that treatment globally. Its checked-in mark is
the official `Yahoo_Fantasy.svg` asset published by Yahoo's Fantasy API portal; it is not a traced,
redrawn, or generated substitute.

Yahoo's executed access agreement may add or supersede published requirements. Before enabling
Yahoo on a deployment, recheck that agreement, confirm retention and multi-user display rules,
publish an accurate privacy policy, and keep the capability flag fail closed until those release
gates are recorded. This is an engineering release condition, not legal advice.

## Setup checklist

1. Obtain approved access through the [Yahoo Fantasy API portal](https://sports.yahoo.com/developer/).
2. Configure the exact callback
   `https://your-host.example/v1/connections/yahoo/callback`. Use HTTPS outside local loopback development.
3. Supply the server process with `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, and the exact callback
   URI. The client secret never belongs in `NEXT_PUBLIC_*` variables or browser code.
4. Generate a random 32-byte credential key and encode it explicitly, for example
   `CREDENTIAL_ENCRYPTION_KEY=base64:$(openssl rand -base64 32)`. Store it in a secret manager or
   protected local environment, not Git. Assign a key ID so rotation can keep old decryption keys
   available while new envelopes use the new primary key.
5. Persist OAuth transactions with a short expiry and a uniqueness constraint. Mark state used in
   the same transaction that creates/updates the provider connection.
6. With approved credentials, run the existing fetch-mock transport and forced-rollback persistence
   suites, then capture only sanitized XML
   fixtures and run authenticated contract tests before enabling real league sync or draft
   polling. In particular, verify the `draftresults` auction cost fields and the chained
   league-team-roster path against the approved application.
7. Verify the globally rendered Yahoo attribution and official mark remain present after any shell
   or navigation redesign.

## Implemented read-sync lifecycle

- `GET /v1/connections/yahoo` returns only the authenticated user's non-secret connection health,
  linked leagues, and freshness timestamps.
- `POST /v1/connections/yahoo/:connectionId/discover` paginates the logged-in user's NFL leagues
  and syncs each discovered league.
- `POST /v1/connections/yahoo/:connectionId/leagues/:leagueKey/sync` refreshes one league on demand.
- OAuth completion runs the same bounded discovery/read sync. An initial sync failure does not
  erase the successfully stored authorization; it marks health for retry.
- A compatible native app reuses this exact server-owned OAuth flow. It creates an authenticated
  browser handoff only to `/connections/yahoo/connect`; after explicit browser confirmation, Yahoo
  handles sign-in and consent. Completion returns to the app through one of four fixed,
  credential-free `lacesout://connections/yahoo?status=...` URLs. No caller-supplied callback URL
  or redirect target is accepted.
- A resource 401 performs one serialized refresh and one retry. Yahoo refresh-token rotation is
  protected by a PostgreSQL row lock spanning the exchange and a credential-version CAS update.
- Multiple friends may authorize the same league. A many-to-many provenance link preserves each
  account's access and current-user team key while the normalized league snapshot is shared.
- `YAHOO_AUTOMATED_SYNC_ENABLED` independently gates unattended refresh. The five-minute provider
  sweep selects only active, non-archived seasons with an exact healthy provider link and live
  league membership. It prefers the season's linked healthy connection, then deterministically
  chooses a linked healthy member fallback without crossing account or user boundaries.
- Active current-season leagues become due after 30 minutes; preseason/offseason leagues after six
  hours. A stable sub-five-minute jitter spreads provider traffic. Completed, past, archived, and
  unknown season states never run, and there is intentionally no 15-minute live/near-lock cadence.
- Automated jobs use the same serialized `league-sync` queue, token-rotation lock, circuit breaker,
  parser, and atomic persistence as manual refresh. Disabling automation does not disable OAuth or
  either manual Yahoo refresh endpoint.
- Yahoo team claims are provider-mapped, not self-asserted. The claim endpoint checks the
  authenticated user's own connection-to-league link and accepts only its exact, unambiguous
  current-user team key. It cannot use another member's connection or claim a different team.
- An unclaimed membership is automatically bound to that exact team after a successful sync when
  the mapping is unambiguous and the team is free. Existing historical claims are never replaced;
  a uniqueness conflict leaves the official read sync successful and the claim unavailable for
  manual review rather than rolling back the provider snapshot.

All provider operations above are reads. No lineup, waiver, transaction, or trade write is
implemented or implied.

## Primary references

- [Yahoo Fantasy API developer portal](https://sports.yahoo.com/developer/)
- [Yahoo Fantasy Sports API guide](https://developer.yahoo.com/fantasysports/guide/)
- [Yahoo server-side authorization-code flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/)
- [Yahoo server-side Authorization Code flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/)
- [Yahoo OAuth API request guidance](https://developer.yahoo.com/oauth2/guide/apirequests/)
- [Yahoo Fantasy Sports APIs terms](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/fantasysportsapi/index.html)

Where older Fantasy guide examples and current OAuth 2 documentation differ, the current OAuth 2
and Sign In with Yahoo documentation governs authentication. Approved-app contract tests govern
the actual Fantasy response available to this application.
