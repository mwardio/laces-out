# Privacy policy template

Effective: 2026-07-17

Laces Out is self-hosted. The person operating a deployment controls its database, encrypted
backups, provider application credentials, and retention settings. This template describes the
default application behavior; an operator must update it if they add analytics, email, a different
retention schedule, AI providers beyond the implemented Film room, or other data recipients.

The application stores member identity and password/session hashes; league settings, teams,
rosters, standings, matchups, and draft events; user rankings, notes, shares, and recommendation
inputs; encrypted Yahoo authorization material; ESPN league snapshots; and bounded operational,
freshness, and audit records. Logs are configured to redact passwords, session material, OAuth
credentials, authorization headers, and known ESPN credential fields.

Film room is available by default through the operator's server-side Google AI Studio project and
fixed `gemini-3.5-flash` model. When a member makes an included request, Laces Out sends the
question plus a bounded snapshot of that member's authorized league overview, Decision Desk, and
league analytics to Google Gemini. Google's free-tier terms currently state that submitted content
may be used to improve its products. Laces Out stores provider/model settings and a usage ledger
containing token counts, status, timing, access mode, and a keyed provider-request identifier, but
does not store raw questions or model answers.

A member may instead add an OpenAI, Anthropic, Gemini, or OpenRouter key and choose the model. That
personal key is stored in the same purpose-bound, versioned encryption system used for provider
secrets, is never returned after save, and overrides included Gemini for that member/provider until
removed. The member's provider account governs BYOK processing and billing. Removing the provider
configuration deletes the encrypted personal key and restores included Gemini when available.

Yahoo authorization occurs at Yahoo. Laces Out uses encrypted Yahoo tokens only for read-only
fantasy synchronization. The optional ESPN companion uses the ESPN browser session locally and
uploads bounded league data, never the ESPN password or cookie values.

Data is used to operate the deployment, synchronize authorized leagues, provide league-wide facts
to authorized league members, generate user-specific analysis, and secure or troubleshoot the
service. Private rankings, notes, credentials, and personal settings are not shared unless their
owner explicitly creates a permitted share. Laces Out has no advertising or third-party analytics
by default and does not sell personal information.

The live database retains data until the deployment operator deletes it or it remains necessary for
an active shared league. Deleted records may remain in encrypted backups until the operator's
documented rotation completes. Members request access, export, connection revocation, share
revocation, or deletion from the operator who issued their invite.

The public in-app version is served at `/privacy`. The operator should publish that URL, set a real
HTTPS deployment origin, document backup retention, and notify members before materially changing
processing.
