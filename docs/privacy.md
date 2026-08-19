# Privacy policy template

Effective: 2026-08-05

Laces Out may be used through the official hosted deployment or a self-hosted server. The person or
organization operating the selected deployment controls its database, encrypted backups, provider
application credentials, and retention settings. This template describes the default application
behavior; an operator must update it if they add analytics, email, a different retention schedule,
AI providers beyond the implemented Film Room, or other data recipients.

The application stores member identity and password/session hashes; league settings, teams,
rosters, standings, matchups, and draft events; user rankings, notes, shares, and recommendation
inputs; stored Weekly Reckoning recaps and League Intel notes; encrypted Yahoo authorization
material; encrypted ESPN session authorization when a member explicitly enables always-on sync;
ESPN league snapshots; and bounded refresh-intent, attempt, artifact-freshness, and audit records.
ESPN refresh metadata can include the request state, fulfillment mode, artifact families,
timestamps, sanitized error code, and sync-device label, but never an ESPN response body or device
token. Logs are configured to redact passwords, session material, OAuth
credentials, authorization headers, and known ESPN credential fields.

When the operator configures outbound SMTP email, the deployment can send account email to the
member's registered address: a requested password-reset link, at most one league-setup reminder,
and, when confirm-first registration is enabled, an account-confirmation link. It stores a
send-once ledger row for the reminder (which kind, which account, when), the account's
email-confirmation timestamp, and SHA-256 digests of outstanding confirmation and reset tokens,
never message content or a plaintext token. Confirmation and reset links keep their bearer token
in the URL fragment so it is not sent in the initial web request. The Settings **Email updates**
toggle suppresses the optional reminder; confirmation and password-reset email exist only in
response to a member's own action. Recipient addresses are never written to logs.

Film Room is available by default through the operator's server-side Google AI Studio project and
fixed `gemini-3.6-flash` model. An ordinary Film Room request sends the member's question or workflow
instructions plus a bounded snapshot of that member's authorized league overview, Decision Desk,
and league analytics to Google Gemini. When the operator configures `OPENROUTER_API_KEY`, included
Medium and Scorched Weekly Reckoning generations instead send bounded league context and the
league's commissioner-written League Intel notes to `x-ai/grok-4.3` through OpenRouter. Mild recaps and
deployments without that key use Gemini. Google's free-tier terms currently state that submitted
content may be used to improve its products. Laces Out stores provider/model settings and a usage
ledger containing token counts, status, timing, access mode, and a keyed provider-request
identifier, but does not store raw Film Room questions or answers. A member-triggered Weekly
Reckoning recap is the exception: it is stored as league data, visible to league members, and
replaced on each reroll.

The Weekly Reckoning recap is the only stored AI output, and it is scoped to the league that asked
for it. A stored recap keeps the provider, model, requesting member, generated time, and the tone
level in force when it was written; changing the league's tone later never relabels an existing
recap. A generation that fails, times out, or is refused by the provider is not stored at all and
leaves the previous recap in place.

League Intel (per-team persona notes) is commissioner-written style and lore material:
rivalries, running bits, and league history. Only league commissioners can view, edit,
or clear the notes. They are sent to the selected AI provider only when a recap is generated and
are never treated as evidence about a game. The recap's tone level is a single league-wide setting
chosen by a commissioner and is disclosed in the recap section to every member. Mild stays clean;
Medium and Scorched deliberately allow uncensored profanity and NSFW adult humor while retaining
the application's subject limits.

A member may instead add an OpenAI, Anthropic, Gemini, DeepSeek, Grok, or OpenRouter key and choose
the model. That personal key is stored in the same purpose-bound, versioned encryption system used
for provider secrets, is never returned after save, and overrides the included route for that
request. The member's provider account governs BYOK processing and billing. Removing the provider
configuration deletes the encrypted personal key and restores the applicable included route when
available. Included Medium and Scorched recaps each allow one generation per member per UTC day.
Those two caps do not count, limit, or otherwise affect BYOK requests.

For start/sit requests, the selected model may ask Laces Out for one fixed, read-only lineup result
already computed by the deterministic Decision Desk engine. The server supplies the authenticated
member and league scope; the tool cannot select another account or league, expose credentials or
SQL, or perform any provider change. Its bounded result may be sent back to the selected AI provider
as part of that request.

Yahoo authorization occurs at Yahoo. Laces Out uses encrypted Yahoo tokens only for read-only
fantasy synchronization. A compatible native app reaches that same server-owned Yahoo OAuth flow
through a short-lived authenticated browser handoff and receives only a fixed completion status;
Yahoo credentials and tokens never return through the native callback. ESPN device-only companion
sync uses the session locally and uploads
bounded league data. When a member starts pairing from the League Sync page, that page may ask the
installed companion to list the fantasy-football leagues on the signed-in ESPN account so the
member picks from names instead of typing IDs; the companion reads only the `SWID` cookie for that
lookup, returns league IDs, names, team names, and seasons to that page alone, and stores none of
it. No cookie value ever reaches the page, and nothing is sent to Laces Out until the member
confirms pairing in the extension popup. If both the operator and member enable always-on ESPN sync, an authorized paired client sends
`SWID` and `espn_s2` once over HTTPS; Laces Out stores them in a purpose-bound encrypted credential
envelope and uses them only for fixed, read-only fantasy endpoints. Chrome obtains them from the
existing ESPN session; a compatible native app keeps credential entry on an ESPN-hosted sign-in
page. The ESPN password is never collected. The member can revoke this connection from League Sync,
expiration requires explicit renewal, and self-hosted operators can disable the feature entirely. An operator-enabled
public-direct refresh sends no member or ESPN credential and can update only an already-admitted,
exactly matching public league season. All ESPN server-side paths are unofficial and default off.

Data is used to operate the deployment, synchronize authorized leagues, provide league-wide facts
to authorized league members, generate user-specific analysis, and secure or troubleshoot the
service. Private rankings, notes, credentials, and personal settings are not shared unless their
owner explicitly creates a permitted share. Laces Out has no advertising and does not sell personal
information. The default self-hosted deployment contains no product-analytics beacon, and its
Content-Security-Policy does not permit one.

The native iOS app communicates with the Laces Out server the member selects. It contains no ad
network or third-party product-analytics SDK, stores the selected server origin and app preferences
on device, keeps the authenticated server cookie in system-managed website storage, and invokes the
system share sheet only after a member chooses to share. Release builds accept only an HTTPS origin
without credentials, paths, queries, or fragments. Because website cookies are scoped by hostname
rather than port, the app rejects a transition between different ports on one hostname; separate
deployments that need session isolation must use distinct hostnames. A candidate server is checked
before adoption, and switching clears the prior deployment's cookie.

Native private-code registration and one-time invitation inspection/acceptance send secrets only to
the preflighted candidate server. Passwords, registration codes, and invitation capabilities are
kept in screen memory, not app preferences. A different server becomes active only after successful
registration or invitation acceptance. The bundled demo uses local sample data and requires no
account or network request.

Before each live Film Room transfer, native consent names and travels with the immutable prepared
league, AI provider, server, and exact question or workflow payload; the current league, server, and
provider availability are rechecked before sending. Before each live recap generation or reroll,
consent and the mutation are bound to both the prepared and current league, week, AI provider,
server, and exact Mild tone. A changed recap binding is rejected rather than sending a different
request under prior consent. Cancel sends nothing. The local demo bypasses these prompts because it
contacts no AI provider.

`NEXT_PUBLIC_CLOUDFLARE_ANALYTICS=enabled` changes the user-facing `/privacy` disclosure for an
operator who separately enables Cloudflare Web Analytics at the hosting edge. The flag does not
inject analytics. A hosted deployment using it must permit only the origins its setup requires and
keep this policy consistent. Cloudflare-proxied sites load the script from
`static.cloudflareinsights.com` and report to the same-origin `/cdn-cgi/rum` endpoint; a
non-proxied manual setup may also require `cloudflareinsights.com` in `connect-src`. Cloudflare
states that Web Analytics does not log query strings; its collection and retention remain governed
by Cloudflare's terms.

## Member export and account deletion

Authenticated members can download their data from `GET /v1/account/export` or the direct web
destination `/settings#account-data`. The versioned portable JSON includes identity, preferences,
session metadata, memberships and claimed-team context, removed-league sync choices,
provider-connection metadata, ESPN bridge
device metadata, notification-device and delivery metadata, invitations, owned rankings and their
versions/entries/imports/shares, member-created projection sets and player projections, AI provider
configuration and usage metadata, activity receipts, audit history, League Intel and recap
contributions, and user-owned refresh intent/attempt history. Another member's device identifier,
label, token, and cross-user attempt provenance are not included.

Every export query is an allowlist. It never returns password hashes; session, invitation, bridge,
pairing, or share-token hashes; OAuth state or PKCE verifiers; encrypted Yahoo credentials; push
endpoints or encryption keys; browser-handoff tokens; encrypted ESPN session authorization; AI key envelopes, fingerprints,
provider-account hashes, or provider request hashes. The export response is marked `no-store` and
downloaded as JSON.

When the native app opens an authenticated web tool, the server creates a random, single-use
handoff lasting at most two minutes. Only a SHA-256 digest is stored. The app accepts only an
allowlisted destination and validates the returned URL's scheme, hostname, effective port, landing
path, expiry, and fragment capability against the selected deployment; the handoff is never accepted
for another origin. The bearer travels in a URL fragment, which is not sent in an HTTP request or
referrer, and is removed from browser history before being atomically rotated into a one-minute
HttpOnly cookie. Successful consumption deletes the handoff and creates the same ordinary revocable
browser session used by password sign-in.

Authenticated members can permanently delete the account from `DELETE /v1/account` or the same
Settings destination. Deletion requires current-password reauthentication plus the exact explicit
confirmation phrase shown in the UI. In one database transaction it:

- revokes/deletes every session, provider credential, OAuth state, ESPN bridge device and pending
  pairing, outstanding browser handoff, push subscription, notification-delivery record, AI
  credential, preference, private ranking/import/share, private member projection set, refresh
  request, activity receipt, and membership owned by the account;
- removes every invitation created by, accepted by, or addressed to the account email;
- transfers each shared league the member owns to a surviving member, preferring commissioner,
  then member and using join order as a deterministic tie-break; a sole-member league and
  its dependent league facts are deleted instead;
- preserves league-visible member projections by removing creator attribution before the account
  cascade, while private projections are deleted; user identifiers embedded in surviving shared
  projection or cloned-ranking provenance are replaced with a fixed anonymous sentinel;
- deletes League Intel text last written by the member and Weekly Reckoning recap text generated by
  the member rather than retaining that shared authored content under a null attribution;
- retains synced deterministic league facts, immutable activity events, and append-only AI
  usage/audit facts where required, with the deleted user's foreign-key attribution set to null; and
- creates one direct-account-field-free `account.deleted` audit fact containing only
  deletion/preservation/transfer counts and the request correlation identifier.

Deletion clears the browser session cookie and signs the member out. The account cannot be restored
from the live application. Deleted records may remain in encrypted backups until the deployment
operator's documented rotation completes. An operator must document that duration and handle
exceptional access/deletion requests when a member cannot sign in.

The public in-app version is served at `/privacy`. The operator should publish that URL, set a real
HTTPS deployment origin, document backup retention, and notify members before materially changing
processing.
