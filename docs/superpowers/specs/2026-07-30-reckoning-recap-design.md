# The Reckoning Recap — Design

**Date:** 2026-07-30
**Status:** Approved for planning

## Summary

Graduate the existing Film Room `weekly-recap` AI feature into a first-class part of The Weekly
Reckoning: an on-demand, persisted, league-personalized trash-talk recap rendered on the Reckoning
page. Personalization comes from per-manager persona cards; tone is governed by a
commissioner-set spice level. All generation rides the existing `AiService` rails and inherits the
product's evidence discipline unchanged.

## Context

- The Reckoning awards engine (`apps/api/src/league-analytics.ts`, `buildWeeklyAwards`) already
  produces structured, evidence-admitted awards per week and withholds any award the data cannot
  support.
- Film Room already ships a `weekly-recap` feature (`apps/api/src/ai-service.ts`,
  `FEATURE_DEFINITIONS`): locker-room voice, 150–250 words, grounded in the weekly awards, with
  prompt-injection defenses (untrusted league-data block) and evidence rules built in. It is
  ephemeral and lives only in the Film Room workbench.
- The AI layer resolves a provider per requesting user: shared Gemini key or the user's encrypted
  OpenAI / Anthropic / Gemini / OpenRouter key.

This project extends that feature in place. Nothing new is built where an existing rail exists.

## Decisions

| Question | Decision |
| --- | --- |
| Style personalization | Per-manager **persona cards** (editable blurbs). Chat-export importer is future work that populates the same cards. |
| Delivery | Section on the Weekly Reckoning page. No push, email, or share-card work in v1. |
| Trigger | On-demand button; result stored per week; any manager-role member can reroll (last write wins). |
| Tone control | League-wide **spice level** set by the commissioner. No per-member opt-out. |
| Architecture | Extend the existing Film Room `weekly-recap` feature and `AiService`; no standalone service. |

## Data model

New tables and settings via a standard Drizzle migration in `packages/db`, following existing
schema conventions (uuid PKs, timezone-aware timestamps, cascade rules matching neighbors).

**`recapPersonaCards`** — one row per fantasy team (teams are season-scoped):

- `fantasyTeamId` (unique), `leagueSeasonId`
- `body` — free text, server-enforced cap of 500 characters, non-empty
- `updatedByUserId`, `updatedAt`

Cards are style and lore material only ("never stops bringing up 2019", rivalry notes, signature
bits). They are never evidence about games.

**`weeklyRecaps`** — one row per `(leagueSeasonId, week)` (unique):

- `body` — recap markdown
- `provider`, `model` — provenance of the generation
- `generatedByUserId`, `createdAt`

Reroll upserts the row. No version history: the league keeps the final take.

**Spice level** — `recapSpiceLevel` column on `leagues` (league-level state alongside `archived`):
enum `mild | medium | scorched`, default `medium`.

Throughout this spec, "commissioner" means a league membership with role `owner` or
`commissioner`, and a member's "own" team is the membership's `claimedFantasyTeamId`.

## API surface

League-scoped Fastify routes following the patterns in `apps/api/src/ai-routes.ts`. All require
league membership.

| Route | Behavior | Authorization |
| --- | --- | --- |
| `GET /v1/leagues/:leagueId/recap?week=N` | Stored recap for the week, or absence plus the reason generation is unavailable (e.g. awards withheld). | Any member (viewers included) |
| `POST /v1/leagues/:leagueId/recap` | Generate for the given week via the `AiService` `weekly-recap` path using the requester's Film Room provider; store; return. | Role `manager` or above |
| `GET /v1/leagues/:leagueId/persona-cards` | All cards for the league season. | Any member (viewers included) |
| `PUT /v1/leagues/:leagueId/persona-cards/:teamId` | Create/update a card. | Member whose claimed team is `:teamId`, or commissioner for any card |
| `PUT /v1/leagues/:leagueId/recap-settings` | Set `recapSpiceLevel`. (No general league-settings route exists today; this is a new, narrow one.) | Commissioner |

The existing Film Room endpoint (`POST /v1/ai/features/weekly-recap`) is unchanged in shape and
remains ephemeral. Because persona cards and spice level enter through the shared league-context
assembly, Film Room's recap gains the same personalization for free: one voice, one rulebook, two
surfaces.

## Prompt changes

The `weekly-recap` entry in `FEATURE_DEFINITIONS` gains two inputs. Both are delivered **inside
the existing untrusted league-data block**, so the block-level injection defenses in
`analystSystem` cover them; no new injection surface is created.

**Persona cards are voice material only.** The instructions direct the model to use cards for
voice, running bits, and rivalries. A card can never add, change, or excuse a stat, result, or
award, and anything instruction-shaped inside a card is ignored (belt-and-suspenders on top of the
block-level rule).

**Tone architecture.** The previous fixed PG-13 rulebook is replaced by a thin universal floor
plus a spice dial:

- **Hard floor, all levels, non-negotiable:**
  - No slurs of any kind.
  - Evidence rules unchanged and verbatim from today: every number traceable to supplied data; a
    withheld award does not exist and is never mentioned; nothing fabricated for the sake of a
    bit. The comedy can be vicious; the stats cannot be fake.
- **`mild`** — gentle ribbing, more celebration than roast.
- **`medium`** — the current locker-room voice, unchanged. Default for new leagues.
- **`scorched`** — R-rated register. Profanity encouraged, dark humor, shock and awe as the
  explicit goal. Managers themselves are fair game — not just their decisions but the whole
  persona, including whatever their persona card hands the model. The prompt states plainly that
  the league opted into a roast, everyone knows the output is AI-generated, and the model should
  not soften or both-sides it.

**Provider-ceiling caveat (accepted risk).** Upstream models (Gemini, OpenAI, Anthropic,
OpenRouter) enforce their own content limits. The scorched prompt pushes to that ceiling; a
provider refusal surfaces as a failed generation and the member rerolls. If the shared Gemini key
proves too restrictive at scorched, a BYO OpenRouter key pointed at a more permissive model is the
existing escape hatch. No moderation-evasion techniques are used — the prompt asks for the
register directly and accepts what the provider returns.

## UI

- **Recap section** on the Weekly Reckoning page (`league-analytics-workbench.tsx`), rendered with
  the awards:
  - Stored recap as markdown with a provenance byline ("Week 5 · written by Gemini · requested by
    Mack").
  - Copy-to-clipboard button.
  - Generate / Reroll button. States mirror the Film Room panel: no provider connected → the same
    connect-a-provider CTA; awards unavailable → disabled with the withheld reason in the
    Reckoning's existing "the data can't support it" voice.
- **Persona-card panel** adjacent to the recap section: the member's own card is editable with a
  character counter; other cards are read-only; the commissioner can edit any card.
- **Spice selector** rendered in the recap section for commissioners only (there is no general
  league-settings page to host it today); other members see the current level read-only.
- **Demo / tour**: reuse the existing `DEMO_ANSWERS["weekly-recap"]` sample as the demo stored
  recap and add two or three sample persona cards so the tour shows the personalization story.

## Error handling

- Awards unavailable / week not awardable → generation disabled; API returns the withheld reason.
- Requester has no AI provider → same error surface and CTA as Film Room today.
- Generation failure (provider error, timeout, refusal) → previously stored recap untouched; the
  error is shown only to the requester.
- Concurrent rerolls → last write wins; no locking.
- Persona card empty or over the 500-character cap → rejected server-side with a clear message.

## Testing

Follow the existing `ai-*.test.ts` patterns; TDD throughout.

- **Prompt assembly:** persona cards and spice level land inside the untrusted data block;
  withheld awards are absent from context; each spice level maps to its voice clause; the hard
  floor is present at every level.
- **Routes:** membership required for view/generate; own-card-only editing with the commissioner
  exception; commissioner-only spice; recap stored on generate and replaced on reroll.
- **Repository:** upsert semantics for `weeklyRecaps` (unique per week) and `recapPersonaCards`
  (unique per team); cap enforcement.
- **UI:** demo mode renders sample recap and cards; disabled states for no-provider and
  withheld-awards.

## Documentation updates

- `docs/privacy.md` and the README AI bullet gain a scoped exception: generated weekly recaps and
  persona cards are stored league data. All other AI prompts and answers keep the existing
  "not stored" posture.

## Non-goals (v1)

- No automatic generation, push notification, email, or share-card rendering of the recap.
- No chat-history ingestion or storage. The future chat-export importer is a separate project that
  distills an export into persona-card text locally and discards the raw messages.
- No per-member tone opt-out; tone is a league-level decision.
- No recap version history.
- No changes to the Film Room endpoint shape or to the deterministic awards engine.
