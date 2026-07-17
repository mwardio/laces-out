# Provider integration notes

Verified: 2026-07-17

These notes distinguish supported provider contracts from observed or manual behavior. The
capability objects in `@fantasy/connector-yahoo` and `@fantasy/connector-espn` are the runtime
source of truth for UI enablement. A league being present in the database does not imply that
live sync, draft polling, or writes are supported.

| Mode                       | Authority                | Authentication material accepted             | Writes | Initial status                                              |
| -------------------------- | ------------------------ | -------------------------------------------- | ------ | ----------------------------------------------------------- |
| Yahoo Fantasy API          | Official, approval-gated | OAuth 2 access/refresh tokens                | None   | Implemented foundation; approved-app contract tests remain  |
| ESPN canonical import      | User-supplied            | None                                         | None   | Authenticated preview + atomic confirmed commit implemented |
| ESPN anonymous public read | Unofficial endpoint      | None; browser credentials explicitly omitted | None   | Connector-only artifact boundary; not wired into hosted app |

See [Yahoo](./yahoo.md), [ESPN](./espn.md), and [credential security](./security.md).

Provider responses are inputs, not trusted domain objects. Every adapter must bound response
size, validate the provider contract, normalize complete provider IDs, checksum the source
artifact, and attach a fetch/import timestamp. Parser fixtures contain only invented IDs and
names.
