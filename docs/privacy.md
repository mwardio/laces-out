# Privacy policy template

Effective: 2026-07-17

Laces Out is self-hosted. The person operating a deployment controls its database, encrypted
backups, provider application credentials, and retention settings. This template describes the
default application behavior; an operator must update it if they add analytics, email, a different
retention schedule, AI providers beyond the implemented Film room, or other data recipients.

The application stores member identity and password/session hashes; league settings, teams,
rosters, standings, matchups, and draft events; user rankings, notes, shares, and recommendation
inputs; stored Weekly Reckoning recaps and League Intel notes; encrypted Yahoo authorization
material; ESPN league snapshots; and bounded operational,
freshness, and audit records. Logs are configured to redact passwords, session material, OAuth
credentials, authorization headers, and known ESPN credential fields.

Film room is available by default through the operator's server-side Google AI Studio project and
fixed `gemini-3.6-flash` model. When a member makes an included request, Laces Out sends the
question plus a bounded snapshot of that member's authorized league overview, Decision Desk,
league analytics, and, for recap requests, the league's manager-written League Intel notes to
Google Gemini. Google's free-tier terms currently state that submitted content
may be used to improve its products. Laces Out stores provider/model settings and a usage ledger
containing token counts, status, timing, access mode, and a keyed provider-request identifier, but
does not store raw questions or model answers, with one exception: a member-triggered Weekly
Reckoning recap is stored as league data, visible to league members, and replaced on each reroll.

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
and the scorched level is disclosed in the recap section to every member, not only to the
commissioner who set it.

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
fantasy synchronization. The optional ESPN companion uses the ESPN browser session locally and
uploads bounded league data, never the ESPN password or cookie values.

Data is used to operate the deployment, synchronize authorized leagues, provide league-wide facts
to authorized league members, generate user-specific analysis, and secure or troubleshoot the
service. Private rankings, notes, credentials, and personal settings are not shared unless their
owner explicitly creates a permitted share. Laces Out has no advertising and does not sell personal
information. The default self-hosted deployment contains no product-analytics beacon, and its
Content-Security-Policy does not permit one.

`NEXT_PUBLIC_CLOUDFLARE_ANALYTICS=enabled` changes the user-facing `/privacy` disclosure for an
operator who separately enables Cloudflare Web Analytics at the hosting edge. The flag does not
inject analytics. A hosted deployment using it must permit only the origins its setup requires and
keep this policy consistent. Cloudflare-proxied sites load the script from
`static.cloudflareinsights.com` and report to the same-origin `/cdn-cgi/rum` endpoint; a
non-proxied manual setup may also require `cloudflareinsights.com` in `connect-src`. Cloudflare
states that Web Analytics does not log query strings; its collection and retention remain governed
by Cloudflare's terms.

The live database retains data until the deployment operator deletes it or it remains necessary for
an active shared league. Deleted records may remain in encrypted backups until the operator's
documented rotation completes. Members request access, export, connection revocation, share
revocation, or deletion from the operator who issued their invite.

The public in-app version is served at `/privacy`. The operator should publish that URL, set a real
HTTPS deployment origin, document backup retention, and notify members before materially changing
processing.
