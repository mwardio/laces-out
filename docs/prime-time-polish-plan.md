# Prime-Time Polish Plan

Five features (plus two honorable mentions) to take Laces Out from "impressively credible tool"
to "thing the whole league argues about every Tuesday." Target audience: a league of friends in
their forties whose social hub is the group text. Every item below is scoped to well under three
days, and every item exploits infrastructure that already exists in this repo.

**The thesis:** the app's craft is already high, but it is tuned entirely for credibility —
provenance stamps, evidence gates, withheld-with-reason. The gap is personality and
shareability, not quality. None of these features weaken the data-integrity philosophy; the
trash talk is only funny _because_ the evidence gates behind it are real.

**Ground rules for all items:**

- Awards, recaps, and share cards are computed only from admitted, final data. Where inputs are
  missing, follow the existing withheld-with-reason pattern — never invent a stat for a joke.
- New analytics are pure functions in `packages/league-analytics` with Vitest coverage
  (property tests via fast-check where the shape fits), consistent with the existing modules.
- No provider writes, no new credential surface, no persisted AI prompts/answers.
- `npm run check` green before merge, per the release runbook.

**Suggested build order:** 1 → 2 → 3 → 4 → 5. Items 2 and 3 build directly on item 1's
payload. Item 4 is independent and can slot anywhere. Item 5 is the largest and lands best
once the weekly habit loop (1–3) exists.

---

## 1. Monday Morning Awards

**What:** a weekly awards strip at the top of League Analytics — the shame-and-glory segment.
Names and faces, not a ledger. This is the screenshot that lands in the group text.

**Why it's cheap:** `packages/league-analytics/src/season.ts` already computes every input:
per-week all-play records, luck wins (`WeeklyTeamAnalytics.luckWins`), lineup efficiency with
points stranded on the bench (`LineupEfficiencySummary.pointsLeft` and its `weekly` array), and
head-to-head margins are derivable from `LeagueWeekInput.performances` + `matchups`. The work
is naming maxima, not computing them.

### Award set (v1)

| Award                    | Definition (per completed week)                                                   |
| ------------------------ | --------------------------------------------------------------------------------- |
| **Bad Beat of the Week** | Highest weekly all-play win rate among teams that lost their head-to-head matchup |
| **The Horseshoe**        | Lowest weekly all-play win rate among teams that won their head-to-head matchup   |
| **Bench Warmer**         | Most points left on the bench (`optimalLineupPoints − actualLineupPoints`)        |
| **Beatdown of the Week** | Largest head-to-head margin of victory                                            |
| **Photo Finish**         | Smallest non-tie margin (only shown when below a threshold, e.g. < 3 pts)         |

Each card: award name, team name (+ logo once item 4 lands), the number that earned it, and a
one-line factual caption ("Outscored 9 of 11 teams and still lost").

### Implementation

1. **`packages/league-analytics/src/awards.ts`** — new pure module.
   - `calculateWeeklyAwards(input: CalculateWeeklyAwardsInput): WeeklyAwardsResult`, where the
     input carries the same `teams`/`weeks` shape `analyzeLeagueSeason` takes plus the target
     `week` (no new data plumbing), alongside `latestAwardableWeek(input)`.
   - Result follows the section conventions in `season.ts`: an `available`/`unavailable` state,
     machine-readable reasons, and a `definitions` array so the UI can explain each award.
   - Evidence gates: a week is awardable only when every matchup that week has official final
     scores; Bench Warmer requires `optimalLineupPoints` present for the winning team's week;
     ties and missing weeks are withheld with reasons, mirroring `EXPECTED_WINS_DEFINITION`
     style. Deterministic tie-breaks (e.g. alphabetical team id) so replays are stable.
   - Export from `packages/league-analytics/src/index.ts`. Tests alongside (`awards.test.ts`):
     fixed fixtures for each award plus a fast-check property (awards never reference a team
     absent from the week's performances; Bad Beat loser actually lost; etc.).
2. **API** — `apps/api/src/league-analytics.ts` already assembles `AnalyzeLeagueSeasonInput`
   for the snapshot builder. Add an `awards` section to the snapshot response: latest fully
   final week by default, `?week=` override. Reuse the section state pattern used by
   `scores`/`power`.
3. **Contracts** — add the zod schema for the awards section in `packages/contracts` next to
   the existing league-analytics snapshot schemas, and parse it in
   `apps/web/src/lib/api-client.ts`.
4. **Web** — card strip component at the top of
   `apps/web/src/components/league-analytics-workbench.tsx` (above the Season ledger panel),
   with a compact single-card variant ("Your league's Week N: …") surfaced on the dashboard's
   weekly insights panel in `dashboard-experience.tsx`. Add demo-data fixtures in
   `apps/web/src/lib/demo-contract-data.ts` so the signed-out locker-room tour shows the strip.

**Estimate:** 1–2 days. &nbsp; **Done when:** awards render for the demo league and for a live
league with a completed week; a league with a missing score shows the withheld state with its
reason; unit tests cover every award and gate.

---

## 2. Film Room trash-talk mode

**What:** the Gemini plumbing currently wears a suit. Give it two or three grounded,
personality-forward presets, and a weekly recap job that narrates item 1's awards.

**Why it's cheap:** the grounding architecture in `apps/api/src/ai-service.ts` (system prompt:
"Use only the supplied league data… deterministic Decision Desk outputs are the recommendation
source of truth") is exactly what makes a roast land — it's funny because it's true. The
per-job instruction pattern already exists (see the lineup review instructions in the same
file), and the quick-question list is a constant in
`apps/web/src/components/film-room-workbench.tsx` (`QUICK_QUESTIONS`).

### Implementation

1. **Quick questions** — extend `QUICK_QUESTIONS` with personality presets, e.g.:
   - "Write a scouting report roasting my opponent's roster this week."
   - "Write my victory speech — or my concession statement, depending on the projections."
   - "Which manager in this league should be most embarrassed, and why? Use the numbers."
2. **Tone guardrail, not tone rewrite** — append a short style clause to the system prompt
   _only_ for these requests (or a "Locker room mode" toggle beside the question box): keep
   every claim tied to supplied league facts; jokes may exaggerate delivery, never numbers; no
   profanity beyond PG-13; never mock real-world injuries — roast decisions, not bodies.
3. **Weekly Recap job (pairs with item 1)** — add a `weekly-recap` analysis kind next to the
   existing kinds in `ai-service.ts`, whose grounding payload includes the awards section from
   item 1 plus the week's matchup results. Output contract: 150–250 words, every superlative
   traceable to a supplied number. Surface it as a "Write the recap" button on the awards strip.
4. The existing no-persistence and daily-cap ledger rules apply unchanged.

**Estimate:** half a day for presets + guardrail; +half a day for the recap job. &nbsp;
**Done when:** a roast request cites only real league numbers; recap renders under the awards
strip; existing sober jobs are byte-identical in behavior.

---

## 3. Share cards for the group text

**What:** a Share button on the awards strip, matchup result, and power board that produces a
clean branded image and hands it to the phone's share sheet. Awards nobody can share are awards
nobody sees.

**Why it's cheap:** the app is already an installable PWA (`apps/web/src/app/manifest.ts`),
Next 16's `ImageResponse` (`next/og`) is available with no new dependency, and the repo already
ships static OG images — this extends an existing pattern, not a new one. There is currently no
`navigator.share` usage anywhere in `apps/web`.

### Implementation

1. **Image routes** — `apps/web/src/app/api/share/…/route.tsx` route handlers rendering
   `ImageResponse` (1200×630) for, in priority order:
   - `awards/[leagueId]/[week]` — the item 1 card strip as one image;
   - `matchup/[leagueId]/[week]` — final score, team names/logos, margin callout;
   - (v2) `power/[leagueId]` — top-to-bottom power board.
     Handlers run in the web app's server context and fetch the same authed API endpoints the
     pages use, forwarding the session cookie — same-origin, no new auth surface. Brand them:
     playbook mark, cream/green palette from `globals.css`, week + league name footer.
2. **Share button component** — `apps/web/src/components/share-card-button.tsx`:
   - Fetch the image route as a blob → `File`.
   - `navigator.canShare({ files })` → `navigator.share` (native sheet; this is the whole
     feature on mobile, and it works beautifully from an installed PWA).
   - Fallback chain: `ClipboardItem` image copy → download link. Reuse the copied/failed
     message pattern from `member-invitations.tsx`.
3. Mount on the awards strip, the dashboard matchup panel, and the analytics power board.
4. **Privacy note for docs:** sharing is a deliberate user action that exports a rendered
   image only — no link back into the invite-only deployment, no URLs that leak the host.
   Worth one line in `docs/privacy.md`.

**Estimate:** 1–2 days (first card is most of the cost; each additional card is ~an hour).
&nbsp; **Done when:** on a phone, tapping Share on the awards strip opens the native share
sheet with a correct, branded image; desktop copies to clipboard; signed-out demo hides or
disables the button.

---

## 4. Team logos everywhere

**What:** render the league's actual team logos in standings, matchups, the power board, and
the dashboard. Cheapest possible way to make the app feel like _their_ league rather than a
beautifully typeset spreadsheet — and it makes every award and share card personal.

**Current state (verified):** the ESPN normalizer extracts and validates a per-team logo —
`logoUrl: teamLogo(team)` in `packages/connector-espn/src/web-client-normalizer.ts`, including
an https-only guard that refuses mixed-content URLs — and the normalized contract carries it
(`packages/connectors/src/normalized.ts`, `logoUrl: string | null`; the Yahoo normalizer
carries it too). **It is then dropped:** `fantasy_teams` (`packages/db/src/schema.ts`, table
definition around line 465) has no logo column, so persistence, contracts, API, and web never
see it.

### Implementation

1. **Schema + migration** — add `logoUrl: text("logo_url")` (nullable) to `fantasyTeams`;
   generate the next drizzle migration in `packages/db/migrations` (follows `0022_…`).
2. **Persistence** — include `logoUrl` in the `fantasyTeams` upsert in
   `apps/api/src/espn-sync-persistence.ts` (insert values + `onConflictDoUpdate` set), sourced
   from the already-normalized team bundle. Nothing to change in the connector.
3. **API + contracts** — add `logoUrl` to every team shape the web already consumes: league
   dashboard (standings, member week, matchup), league-analytics snapshot teams, schedule
   board. Update the zod schemas in `packages/contracts` and the parsers in
   `apps/web/src/lib/api-client.ts`.
4. **Web** — a small `team-avatar.tsx` component: renders the logo image with
   `referrerPolicy="no-referrer"`, falls back to a two-letter initials disc (deterministic
   background color from team id) when `logoUrl` is null or errors. Because these are
   arbitrary provider-hosted hosts, use a plain `<img>` (avoids `next/image` remote-pattern
   allow-listing). Mount in: standings panel and matchup header
   (`dashboard-experience.tsx`), power board and season ledger
   (`league-analytics-workbench.tsx`), schedule board (`schedule-board.tsx`), and the item 1
   awards cards. Add logo URLs to the demo fixtures (or lean on the initials fallback there).
5. **Hygiene** — the https-only rule already lives in the normalizer; keep it the single
   enforcement point and note in `docs/security.md` that logos are provider-hosted, https-only,
   fetched by the member's browser with no referrer.

**Estimate:** ~1 day (the migration and contract threading are the bulk; the component is
trivial). &nbsp; **Done when:** a fresh ESPN sync populates `logo_url`; standings and power
board show logos; a team with no logo shows initials, not a broken image.

---

## 5. The lineup-lock alarm (web push)

**What:** a push notification when it matters: _"2 starters need attention — Chase is OUT,
and you have a bye-week TE. First kickoff in 2 hours."_ The one practical feature that earns
permanent goodwill from casual friends, and the difference between an app they _check_ and an
app that _checks on them_. Biggest item on the list; still inside three days.

**Why it's feasible:** every ingredient exists — rosters with injury status and bye coverage
(the Decision Desk already evaluates "stored injury, bye, eligibility, or lock risk"), kickoff
times from the nflverse schedule pipeline, a pg-boss job scheduler in the worker
(`boss.schedule` in `apps/worker/src/jobs.ts`), and an installable PWA. There is no email
infrastructure in the repo (invites are copy-link), so push is the only channel that reaches a
guy at his kid's soccer game — which is exactly when he needs it.

### Implementation

1. **Keys + dependency** — `web-push` package (worker + api). `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` in `.env.example`, `.env.docker.example`, and
   `docker-compose.yml`; generation one-liner documented in `docs/operations.md`. Feature is
   cleanly disabled when keys are absent (settings UI says so, worker job no-ops).
2. **Subscription storage** — `push_subscriptions` table (drizzle migration): `userId`,
   `endpoint` (unique), `p256dh`, `auth`, `userAgent` label, `createdAt`, `lastSuccessAt`.
   Treat like the existing revocable-device pattern: listable and deletable per device.
3. **API** — authed routes: `POST /push/subscriptions`, `DELETE /push/subscriptions`, plus
   `GET` of the public key. Wire a toggle + device list into
   `apps/web/src/components/settings-panel.tsx`.
4. **Service worker** — the PWA currently has no SW. Add `apps/web/public/sw.js` with `push`
   (show notification) and `notificationclick` (focus/open `/decisions?league=…`) handlers;
   register it from the app shell; request `Notification` permission only from the settings
   toggle — never on page load.
5. **Worker job** — pg-boss cron alongside the existing scheduled jobs:
   - Compute each claimed team's alert conditions from stored data: starter ruled OUT/IR,
     starter on a bye (asserted byes only, per the existing bye evidence rule), empty required
     slot. Reuse the same stored facts the Decision Desk lineup check reads — do not build a
     second eligibility engine.
   - Send windows anchored to the league's earliest relevant kickoff from stored schedules:
     T-24h digest and T-2h final warning. Idempotency key
     (`userId:leagueId:week:window`) recorded so re-runs never double-send. Keep the sender
     generic over a notification `kind` (payload builder + idempotency key slot) so later
     notification types are additive jobs, not plumbing changes.
   - Payload is factual and specific (player, reason, kickoff time), deep link to Decision
     Desk. Delete subscriptions on `410 Gone`.
6. **Honest constraints (document in README + settings copy):** alerts fire from the _last
   synced_ roster — staleness shown, per the existing freshness pattern; iOS requires the PWA
   installed to the home screen (iOS 16.4+); notifications never include provider credentials
   or anything beyond league facts.

**Fast-follow (deliberately not v1):** once the lineup alarm has run a couple of clean weeks
and item 1 is live, a Tuesday _"Monday Morning Awards are up"_ push is ~a day on the same
plumbing (new pg-boss job + payload `kind`; nothing else changes) and closes the items 1–3
social loop with a retention hook. A waiver-results digest is the same shape. These are held
back on purpose: the notification channel is a trust budget, and the lineup emergency is the
one push nobody resents — it earns the channel before anything else spends it. A second
notification type that ships before the first has proven itself is how a league of
forty-year-olds mutes the app at the OS level, permanently.

**Fallback scope** if the schedule slips: ship steps 1–3 plus an in-app "needs attention"
badge on the Overview nav item, and land the SW + worker job as the follow-up. (A per-user ICS
calendar feed of kickoff/lock times was considered as a cheaper substitute — it's a couple of
hours — but it doesn't reach anyone who didn't subscribe their calendar, so it's a complement,
not the feature.)

**Estimate:** 2–3 days. &nbsp; **Done when:** enabling the toggle on a phone yields a test
notification; a roster with an OUT starter produces exactly one T-2h alert whose deep link
opens the right league's Decision Desk; revoking the device stops delivery; missing VAPID keys
degrade to a clearly labeled disabled state.

---

## Demo & locker-room tour updates

The signed-out tour is the sales pitch to the rest of the league, and the fun features are the
most pitchable thing in the app — the tour should lead with them, not hide them. The demo
fixtures in `apps/web/src/lib/demo-contract-data.ts` are typed against `@fantasy/contracts`,
so the contract changes in items 1 and 4 will force fixture updates at compile time anyway;
the work is making the demo data _funny_, not wiring it.

| Item           | Tour treatment                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Awards      | **Yes — flagship.** Add a demo `awards` section for the North Loop Auction's Week 6: give the strip a story (e.g. Budget Ballers strand 34.6 bench points for Bench Warmer; a 2–4 team wins The Horseshoe with the week's worst all-play). Shows in the signed-out League Analytics tour and as the compact card on the demo Overview. |
| 2. Trash talk  | **Yes.** The Film Room tour already shows canned "Illustrative sample" answers with sample questions. Add one preset roast/recap sample whose jokes cite the demo awards numbers exactly — it demonstrates both the personality _and_ the grounding promise in one panel.                                                              |
| 3. Share cards | **Yes — and it's the growth loop.** Keep the Share button live in demo mode, with the rendered image carrying a visible "Sample data" ribbon (consistent with the demo-always-labeled rule). A league-mate sharing the sample awards card into the group text _is_ the pitch for adopting the app.                                     |
| 4. Logos       | **Light.** Demo teams use the initials-disc fallback (deterministic colors, no external fetches, and it proves the fallback path in the most-seen surface). Bundled demo logo files are optional polish, not required.                                                                                                                 |
| 5. Push        | **Minimal.** Not meaningfully demoable signed-out. Show the settings toggle in its labeled disabled/preview state in the demo settings panel; a screenshot of a real notification in the README does the rest.                                                                                                                         |

Once items 1–4 land, re-capture `docs/screenshots/locker-room-overview.webp` and the analytics
shot from the tour (the README states every screenshot is the tour, so keep that true) — the
awards strip should be visible in the hero screenshot, because it's the single most
group-chat-legible thing the product now does.

---

## Honorable mentions (close calls that didn't make the cut)

### A. The Trophy Case (champion + Sacko board)

A league-configurable stakes page: reigning champion with trophy art, last-place punishment
("Sacko") with its terms, and a season-result history. For this demographic it's a guaranteed
hit — _The League_ did the market research already. It missed the cut because it's the only
idea needing genuinely new data modeling (multi-season results you may not have synced) plus an
admin editing surface, and its payoff is season-end rather than weekly. A lightweight v1
(commissioner-entered champion/punishment text + emoji trophy on the league dashboard header)
is 1–2 days if the itch strikes; prior-season history is where scope creep lives.

### B. Member-facing microcopy pass ("locker room voice")

A sweep of in-app labels toward how a league-mate talks ("Score state unavailable" → "No score
yet"). Cut because the impact is diffuse, the sober voice is genuinely part of the product's
credibility brand, and item 2 injects personality surgically where it pays instead of
rewriting two hundred labels. Worth doing opportunistically — fix any label that sounds like a
compliance officer _while you're already in that file_ — but not as a standalone project.

---

## Sequencing recap

| Order | Item                         | Estimate  | Depends on                                    |
| ----- | ---------------------------- | --------- | --------------------------------------------- |
| 1     | Monday Morning Awards        | 1–2 days  | —                                             |
| 2     | Film Room trash talk + recap | 0.5–1 day | 1 (for the recap job)                         |
| 3     | Share cards                  | 1–2 days  | 1 (awards card), 4 (logos on cards, optional) |
| 4     | Team logos                   | ~1 day    | — (independent; do anytime)                   |
| 5     | Lineup-lock push             | 2–3 days  | —                                             |

Items 1–3 form the weekly social loop: compute the awards, narrate them, share them. Item 4
makes everything above personal. Item 5 is the retention anchor. If only two ship this
off-season: **1 + 3**.
