# Sleeper source adapter

This package reads official, public Sleeper NFL endpoints for player identity/status, add/drop
trends, users, leagues, rosters, matchups, transactions, drafts, draft picks, and traded picks.
Every league response includes the requested endpoint, fetch time, and SHA-256 body checksum so the
application can retain source-level provenance.

## Operating constraints

- The API is read-only and does not require an API token. A username or league identifier is public
  discovery input, not proof that a Laces Out account owns or controls a Sleeper team. Authorization
  and team claiming must be handled separately by the application.
- Sleeper's documentation asks clients to remain under 1,000 calls per minute to avoid an IP block.
  Callers should cache stable league data, poll only the active week when possible, and apply their
  own concurrency/rate limit below that ceiling.
- The full player catalog is intentionally a separate daily read. League and draft records retain
  Sleeper player IDs so they can be resolved against that catalog without repeatedly downloading it.
- Requests use the fixed `https://api.sleeper.app/v1/` origin, reject redirects, enforce timeouts and
  response-size limits, and bound all collection/schema parsing. The adapter never sends write
  requests.
- Provider IDs are retained verbatim. Usernames are mutable; persist `userId` after discovery.
- Review Sleeper's current documentation and policies before materially changing polling volume or
  public distribution behavior.

Product attribution: **League data provided by Sleeper**, linking to <https://sleeper.com/>.

Official API documentation: <https://docs.sleeper.com/>.
