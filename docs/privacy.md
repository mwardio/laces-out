# Privacy policy template

Effective: 2026-08-03

Laces Out may be used through the official hosted deployment or a self-hosted server. The person or
organization operating the selected deployment controls its database, encrypted backups, provider
application credentials, and retention settings. This template describes the default application
behavior; an operator must update it if they add analytics, email, a different retention schedule,
AI providers beyond the implemented Film room, or other data recipients.

The application stores member identity and password/session hashes; league settings, teams,
rosters, standings, matchups, and draft events; user rankings, notes, shares, and recommendation
inputs; stored Weekly Reckoning recaps and League Intel notes; encrypted Yahoo authorization
material; ESPN league snapshots; and bounded refresh-intent, attempt, artifact-freshness, and audit
records. ESPN refresh metadata can include the request state, fulfillment mode, artifact families,
timestamps, sanitized error code, and sync-device label, but never an ESPN response body or device
token. Logs are configured to redact passwords, session material, OAuth
credentials, authorization headers, and known ESPN credential fields.

Film Room is available by default through the operator's server-side Google AI Studio project and
fixed `gemini-3.6-flash` model. An ordinary Film Room request sends the member's question or workflow
instructions plus a bounded snapshot of that member's authorized league overview, Decision Desk,
and league analytics to Google Gemini. A Weekly Reckoning generation sends bounded league context
and the league's manager-written League Intel notes, but no ordinary Film Room question. Google's
free-tier terms currently state that submitted content may be used to improve its products. Laces
Out stores provider/model settings and a usage ledger containing token counts, status, timing,
access mode, and a keyed provider-request identifier, but does not store raw Film Room questions or
answers. A member-triggered Weekly Reckoning recap is the exception: it is stored as league data,
visible to league members, and replaced on each reroll.

The Weekly Reckoning recap is the only stored AI output, and it is scoped to the league that asked
for it. A stored recap keeps the provider, model, requesting member, generated time, and the tone
level in force when it was written; changing the league's tone later never relabels an existing
recap. A generation that fails, times out, or is refused by the provider is not stored at all and
leaves the previous recap in place.

League Intel (per-team persona notes) is manager-written style and lore material: rivalries,
running bits, and league history. It is visible to league members, sent to the selected AI provider
only when a recap is generated, and never treated as evidence about a game. Each member edits the
note for the team they have claimed; a league owner or commissioner may edit or clear any note as a
moderation action. The recap's tone level is a single league-wide setting chosen by a commissioner,
and is disclosed in the recap section to every member, not only to the commissioner who set it.
Mild stays clean; Medium and Scorched deliberately allow uncensored profanity and NSFW adult humor
while retaining the application's subject limits.

A member may instead add an OpenAI, Anthropic, Gemini, DeepSeek, Grok, or OpenRouter key and choose
the model. That personal key is stored in the same purpose-bound, versioned encryption system used
for provider secrets, is never returned after save, and overrides included Gemini for that
member/provider until removed. The member's provider account governs BYOK processing and billing.
Removing the provider configuration deletes the encrypted personal key and restores included
Gemini when available.

For start/sit requests, the selected model may ask Laces Out for one fixed, read-only lineup result
already computed by the deterministic Decision Desk engine. The server supplies the authenticated
member and league scope; the tool cannot select another account or league, expose credentials or
SQL, or perform any provider change. Its bounded result may be sent back to the selected AI provider
as part of that request.

Yahoo authorization occurs at Yahoo. Laces Out uses encrypted Yahoo tokens only for read-only
fantasy synchronization. An ESPN sync agent uses the ESPN session locally on the authorized device
and uploads bounded league data, never the ESPN password or cookie values. An operator-enabled
public-direct refresh sends no member or ESPN credential and can update only an already-admitted,
exactly matching public league season. The path is unofficial, default-off, and separately
evidence-gated by artifact family.

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
session metadata, memberships and claimed-team context, provider-connection metadata, ESPN bridge
device metadata, notification-device and delivery metadata, invitations, owned rankings and their
versions/entries/imports/shares, member-created projection sets and player projections, AI provider
configuration and usage metadata, activity receipts, audit history, League Intel and recap
contributions, and user-owned refresh intent/attempt history. Another member's device identifier,
label, token, and cross-user attempt provenance are not included.

Every export query is an allowlist. It never returns password hashes; session, invitation, bridge,
pairing, or share-token hashes; OAuth state or PKCE verifiers; encrypted Yahoo credentials; push
endpoints or encryption keys; browser-handoff tokens; AI key envelopes, fingerprints,
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
  manager, then viewer and using join order as a deterministic tie-break; a sole-member league and
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
