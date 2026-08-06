# Provider integration notes

Verified: 2026-08-05

These notes distinguish supported provider contracts from observed or manual behavior. The
capability objects in `@laces-out/connector-yahoo` and `@laces-out/connector-espn` are the runtime
source of truth for UI enablement. A league being present in the database does not imply that
live sync, draft polling, or writes are supported.

| Mode                        | Authority                | Authentication material accepted                                  | Writes | Status                                                   |
| --------------------------- | ------------------------ | ----------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Yahoo Fantasy API           | Official, approval-gated | OAuth 2 access/refresh tokens                                     | None   | Implemented; enabled per approved deployment             |
| ESPN sync agent relay       | Unofficial compatibility | Device-local ESPN session; only bounded league artifacts are sent | None   | Chrome and separate native client implemented            |
| ESPN always-on private read | Unofficial compatibility | Explicitly granted `SWID`/`espn_s2`, encrypted at rest            | None   | Server, Chrome, and separate native client implemented   |
| ESPN live draft observer    | Unofficial compatibility | Rendered draft facts; no cookies, tokens, raw HTML, or frame data | None   | Implemented behind a flag; pending live-room validation  |
| ESPN anonymous public read  | Unofficial endpoint      | None; credentials omitted                                         | None   | Implemented behind an evidence gate and default-off flag |

See [Yahoo](./yahoo.md), [ESPN](./espn.md), and [credential security](./security.md).

Provider responses are inputs, not trusted domain objects. Every adapter must bound response
size, validate the provider contract, normalize complete provider IDs, checksum the source
artifact, and attach a fetch/import timestamp. Parser fixtures contain only invented IDs and
names.
