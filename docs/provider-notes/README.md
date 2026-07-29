# Provider integration notes

Verified: 2026-07-29

These notes distinguish supported provider contracts from observed or manual behavior. The
capability objects in `@fantasy/connector-yahoo` and `@fantasy/connector-espn` are the runtime
source of truth for UI enablement. A league being present in the database does not imply that
live sync, draft polling, or writes are supported.

| Mode                       | Authority                | Authentication material accepted                                  | Writes | Status                                                  |
| -------------------------- | ------------------------ | ----------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| Yahoo Fantasy API          | Official, approval-gated | OAuth 2 access/refresh tokens                                     | None   | Implemented; disabled until approved and configured     |
| ESPN browser bridge        | Unofficial compatibility | Browser session stays at ESPN; only bounded league data is sent   | None   | Available through the signed Chrome companion           |
| ESPN live draft observer   | Unofficial compatibility | Rendered draft facts; no cookies, tokens, raw HTML, or frame data | None   | Implemented behind a flag; pending live-room validation |
| ESPN anonymous public read | Unofficial endpoint      | None; browser credentials explicitly omitted                      | None   | Connector experiment; not wired into the hosted app     |

See [Yahoo](./yahoo.md), [ESPN](./espn.md), and [credential security](./security.md).

Provider responses are inputs, not trusted domain objects. Every adapter must bound response
size, validate the provider contract, normalize complete provider IDs, checksum the source
artifact, and attach a fetch/import timestamp. Parser fixtures contain only invented IDs and
names.
